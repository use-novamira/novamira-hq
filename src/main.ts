// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import type { McpLaunch } from "./mcp-connection.js";
import { createMcpConnectionService } from "./mcp/configuration.js";
import { createCommandHandlers } from "./cli/commands.js";
import {
  createProgram,
  DEFAULT_OPERATION_TIMEOUT_MS,
  isCommanderUsageError,
  isHelpExit,
  PROGRAM_NAME,
  type GlobalOptions,
} from "./cli/program.js";
import { defaultFileSecurity } from "./config/file-security.js";
import { ProfileLockManager } from "./config/lock.js";
import {
  overrideOf,
  platformPaths,
  type PathEnvironment,
} from "./config/paths.js";
import { ConfigStore } from "./config/profiles.js";
import {
  createCredentialStore,
  type CredentialStore,
} from "./credentials/store.js";
import { resolveCredential } from "./credentials/resolve.js";
import { asCliError, CliError } from "./errors.js";
import {
  createHostingClientFactory,
  type ProviderRegistry,
} from "./hosting/factory.js";
import { PROVIDER_REGISTRY } from "./hosting/providers/index.js";
import {
  createSiteCliProbe,
  createSiteCliResolver,
  nodeIsFile,
  nodeSpawnChild,
} from "./integration/index.js";
import {
  createRenderer,
  type OutputStreams,
  type Renderer,
} from "./output/render.js";
import { SkillStore } from "./skills/index.js";
import {
  updateCheckEnabled,
  SpawnInstallRunner,
  UpdateChecker,
  type InstallRunner,
} from "./update/index.js";
import { VERSION } from "./version.js";
import { HistoryStore, type HistoryChannel } from "./history/index.js";
import { historyClient } from "./history/client.js";

/**
 * The version literal moved to `src/version.ts` so `src/provisioning/` can
 * stamp it into the compatibility preflight's `User-Agent` without importing
 * the composition root. Re-exported here because it is where every caller,
 * including `test/cli-program-contract.test.mjs`, already looks for it.
 */
export { VERSION };

/**
 * Launch the public command, independent of package manager or install layout.
 * It must be available in the AI client's own execution environment.
 */
export const DEFAULT_MCP_LAUNCH: McpLaunch = {
  command: PROGRAM_NAME,
  args: ["mcp"],
};

export interface RuntimeEnvironment extends PathEnvironment {
  readonly NO_COLOR?: string;
  /** `0` or `false` disables the 24-hour background release notice. */
  readonly NOVAMIRA_HQ_UPDATE_CHECK?: string;
  /** An alternate npm registry for `update` and the background notice. */
  readonly NOVAMIRA_HQ_REGISTRY?: string;
  /** `1` allows a plain-HTTP **loopback** registry; the same opt-in provisioning uses. */
  readonly NOVAMIRA_HQ_ALLOW_INSECURE_HTTP?: string;
  /**
   * The rest of the process environment. Credential references and the
   * providers' identity variables are resolved from the very environment the
   * paths were resolved from, so a test that isolates `NOVAMIRA_HQ_HOME` also
   * isolates every credential lookup.
   */
  readonly [name: string]: string | undefined;
}

/**
 * Seams the composition root exposes to tests. Production passes nothing and
 * gets the real, complete provider registry.
 */
export interface MainOverrides {
  readonly mcpLaunch?: McpLaunch;
  readonly distribution?: "npm" | "desktop";
  readonly historyChannel?: HistoryChannel;
  /**
   * The provider constructors the hosting client factory may build from.
   * Defaults to `PROVIDER_REGISTRY`; a test injects a fake so that no
   * invocation can reach a live provider API.
   */
  readonly registry?: ProviderRegistry;
  /**
   * The `fetch` the update checker uses. Defaults to global `fetch`; every
   * update contract test injects one, so no test in this repository reaches the
   * npm registry. It is deliberately separate from the provisioning `fetch`
   * seam: they answer different questions and a test that fakes one must not
   * silently fake the other.
   */
  readonly updateFetch?: typeof fetch;
  /**
   * The package-manager runner `update` spawns. Defaults to
   * {@link SpawnInstallRunner}; a test injects a recorder so that `--check`
   * can be proved never to spawn anything.
   */
  readonly installRunner?: InstallRunner;
}

/**
 * Reconstruct the global options after a failure that happened before (or
 * during) parsing, when no command handler ever ran. Commander's defaults are
 * used where available and the raw argv is scanned for the flags that change
 * how the failure itself is reported.
 */
function fallbackOptions(
  program: Command | undefined,
  argv: readonly string[],
): GlobalOptions {
  const parsed = program?.opts<Partial<GlobalOptions>>() ?? {};
  return {
    json: parsed.json === true || argv.includes("--json"),
    quiet: parsed.quiet === true || argv.includes("--quiet"),
    verbose: parsed.verbose === true || argv.includes("--verbose"),
    color: parsed.color !== false && !argv.includes("--no-color"),
    yes: parsed.yes === true || argv.includes("--yes"),
    timeout: parsed.timeout ?? DEFAULT_OPERATION_TIMEOUT_MS,
    timeoutExplicit: false,
  };
}

/**
 * Point a command and every subcommand at the injected streams. Commander
 * copies the output configuration into a subcommand when the subcommand is
 * created, so configuring only the root would leave `config --help` writing to
 * the real `process.stdout` instead of the streams the caller supplied.
 */
function configureOutput(command: Command, streams: OutputStreams): void {
  command.configureOutput({
    // Help and version text is commander's; failures are the renderer's.
    writeOut: (value) => streams.stdout.write(value),
    writeErr: () => undefined,
  });
  for (const child of command.commands) configureOutput(child, streams);
}

/**
 * Composition root. Builds the one lock manager, the one config store and the
 * one renderer this process uses, runs the parsed command, and funnels every
 * failure through `asCliError` -> `Renderer.failure` -> `exitCodeFor`. It never
 * rejects: the returned number is the process exit code.
 */
export async function main(
  argv: readonly string[],
  streams: OutputStreams = { stdout: process.stdout, stderr: process.stderr },
  environment: RuntimeEnvironment = process.env,
  overrides: MainOverrides = {},
): Promise<number> {
  const requestId = randomUUID();
  let renderer: Renderer | undefined;
  let program: Command | undefined;

  // One renderer per process: the first command to run fixes the output mode,
  // and the failure path below reuses it so `meta.requestId` is stable.
  const rendererFor = (options: GlobalOptions): Renderer => {
    renderer ??= createRenderer(
      {
        json: options.json,
        quiet: options.quiet,
        verbose: options.verbose,
        color: options.color && environment.NO_COLOR === undefined,
        requestId,
      },
      streams,
    );
    return renderer;
  };

  try {
    const paths = platformPaths(environment);
    const security = defaultFileSecurity();
    // Exactly one lock manager per process: it rejects re-entrant acquisition
    // of the same key, and two managers behave like two processes.
    const locks = new ProfileLockManager(paths.stateDir, security);
    const store = new ConfigStore(paths.configFile, locks, security);
    const history = new HistoryStore(paths, locks, security);

    // The credential store, built at most once per process and only when a
    // `stored` reference is actually resolved: constructing it probes the OS
    // keychain, and `--version`, `config path` and every `env`/`file`
    // credential must not pay for a subprocess they never use.
    let pendingCredentials: Promise<CredentialStore> | undefined;
    const credentialStore = (): Promise<CredentialStore> => {
      pendingCredentials ??= createCredentialStore(
        paths.credentialsDir,
        security,
        { onWarning: (message) => renderer?.warn(message) },
      );
      return pendingCredentials;
    };

    // Exactly one hosting client factory per process, over the complete
    // provider registry. Diagnostics are routed to the renderer that the first
    // command created; before that there is nothing to write to, and an HTTP
    // request cannot have happened yet either.
    const hosting = createHostingClientFactory({
      decorateClient: (client, profile) =>
        historyClient(
          client,
          profile,
          history,
          () =>
            overrides.historyChannel ??
            (program?.args[0] === "dashboard" ? "dashboard" : "cli"),
        ),
      store,
      registry: overrides.registry ?? PROVIDER_REGISTRY,
      env: environment,
      resolver: {
        resolve: async (ref) =>
          resolveCredential(ref, {
            env: environment,
            security,
            ...(ref.type === "stored"
              ? { store: await credentialStore() }
              : {}),
          }),
      },
      http: {
        onDiagnostic: (diagnostic) => renderer?.diagnostic("http", diagnostic),
      },
    });

    /*
     * One update checker per call, over the one state directory and the one
     * lock manager this process owns.
     *
     * The path comes from `paths.stateDir` — HQ's namespace, resolved by
     * `src/config/paths.ts`; `NOVAMIRA_HOME` is never read and no namespace
     * segment is joined by hand. The registry override and the insecure-HTTP
     * opt-in are HQ's own variables: `NOVAMIRA_HQ_REGISTRY` and
     * `NOVAMIRA_HQ_ALLOW_INSECURE_HTTP`, the latter shared with
     * `src/provisioning/` so HQ has one insecure-HTTP opt-in rather than two.
     *
     * The registry override goes through {@link overrideOf}, which is
     * `src/config/paths.ts`'s rule — *an empty-string override is treated as
     * unset* — applied to the one HQ variable that is not a path. Passing `""`
     * through would reach `new URL("/")` and surface as `internal_error` from
     * `update`, and as `evidence: { registry: "" }` on the doctor's
     * `update.available`; an operator who exports the variable empty means "I am
     * not overriding this".
     */
    const registryOverride = overrideOf(environment.NOVAMIRA_HQ_REGISTRY);
    const createUpdateChecker = (timeoutMs?: number): UpdateChecker =>
      new UpdateChecker(paths.stateDir, locks, security, {
        currentVersion: VERSION,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(overrides.updateFetch === undefined
          ? {}
          : { fetch: overrides.updateFetch }),
        ...(registryOverride === undefined
          ? {}
          : { registry: registryOverride }),
        allowInsecureHttp: environment.NOVAMIRA_HQ_ALLOW_INSECURE_HTTP === "1",
      });

    const handlers = createCommandHandlers({
      distribution: overrides.distribution ?? "npm",
      mcpConnection: createMcpConnectionService(
        overrides.mcpLaunch ?? DEFAULT_MCP_LAUNCH,
        environment,
      ),
      history,
      version: VERSION,
      paths,
      store,
      hosting,
      // The same memoized getter the credential resolver above uses, so the
      // dashboard server and every `stored` credential lookup share one store
      // and one keychain probe.
      credentials: credentialStore,
      security,
      // Reads the packaged `skills/` directory relative to its own module URL;
      // constructing it performs no I/O.
      skills: new SkillStore(),
      // The doctor's site-CLI question, built from the same resolver and spawn
      // seam the dashboard's connected-state service uses. `src/integration/`
      // is the only place HQ runs `novamira`, so there is one of these and the
      // doctor takes it rather than opening a second one.
      probeSiteCli: createSiteCliProbe({
        resolve: createSiteCliResolver({
          environment,
          platform: process.platform,
          isFile: nodeIsFile,
        }),
        spawn: nodeSpawnChild,
        environment,
      }),
      locks,
      createUpdateChecker,
      createInstallRunner: (timeoutMs) =>
        overrides.installRunner ?? new SpawnInstallRunner(timeoutMs),
      rendererFor,
    });

    program = createProgram(VERSION, handlers);
    configureOutput(program, streams);

    /*
     * Whether this invocation may be followed by the background release notice.
     *
     * A commander `preAction` hook on the root fires for the leaf command, so
     * this is one registration rather than a flag threaded through ~110
     * handlers. `dashboard` is excluded because its handler blocks until the
     * listener stops, so the notice would arrive at shutdown and mean nothing;
     * `doctor --offline` is excluded because `--offline` promises **no network
     * operation of any kind**, and a notice that quietly made one would make the
     * promise false.
     */
    // A record rather than a `let`, because the assignment happens inside a
    // callback the compiler cannot see running: a plain `let` would be narrowed
    // to its initializer at every read below.
    const invocation: { noticeAllowed: boolean } = { noticeAllowed: false };
    program.hook("preAction", (_root: Command, actionCommand: Command) => {
      const local = actionCommand.opts<{ readonly offline?: boolean }>();
      const globals = actionCommand.optsWithGlobals<Partial<GlobalOptions>>();
      invocation.noticeAllowed =
        actionCommand.name() !== "dashboard" &&
        local.offline !== true &&
        globals.json !== true &&
        globals.quiet !== true;
    });

    await program.parseAsync(argv, { from: "user" });

    /*
     * The 24-hour background release notice.
     *
     * It runs only after a *successful* invocation, writes one line to stderr
     * through the renderer's warning path, never touches stdout, and never
     * changes the exit code. Every failure inside it is silent — `notice()`
     * swallows its own errors and returns `undefined` — and the cached record
     * bounds it to at most one registry request per day per registry.
     *
     * **Every suppressor is evaluated before the call, not after it.** The point
     * is not to hide a line, it is to not make the request: `--offline`, and the
     * general rule that a non-interactive invocation performs no work the caller
     * did not ask for, are promises about network traffic and about writes into
     * the state directory, neither of which a check-then-discard would keep.
     *
     * **The terminal gate is the important one.** HQ is an agent-facing tool:
     * most invocations are a script or an agent reading `--json`, and a daily
     * registry request plus a state write attached to *those* would be work
     * nobody asked for, in a process nobody is watching. So the notice is for a
     * human at a terminal, and `stderr` not being a TTY — a pipe, a log, a CI
     * job, a test's injected sink — turns it off entirely. `--json` and
     * `--quiet` turn it off for the same reason, one step earlier.
     */
    if (
      invocation.noticeAllowed &&
      streams.stderr.isTTY === true &&
      updateCheckEnabled(environment)
    ) {
      const message = await createUpdateChecker().notice();
      if (message !== undefined) renderer?.warn(message);
    }
    return 0;
  } catch (error) {
    if (isHelpExit(error)) return 0;
    const cliError = isCommanderUsageError(error)
      ? new CliError(
          "usage_error",
          `Invalid command usage. Run ${PROGRAM_NAME} --help.`,
        )
      : asCliError(error);
    const active = renderer ?? rendererFor(fallbackOptions(program, argv));
    return active.failure(cliError);
  }
}
