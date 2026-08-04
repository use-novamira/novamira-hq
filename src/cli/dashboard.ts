// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `novamira-hq dashboard`, ported from `newDashboardCommand`
 * (`internal/cli/dashboard.go`).
 *
 * **A top-level command, not a hosting one.** Go registered it on the root, and
 * so does HQ: the dashboard is a peer surface of the whole CLI, not an operation
 * on a hosting profile. `src/web/` is likewise a peer of `src/cli/` — this file
 * imports the web layer, and nothing under `src/web/` may import `src/cli/`.
 *
 * **Two flags, and deliberately no third.** `--listen` and `--open` are free
 * against the reserved globals (`--profile --json --timeout --yes --no-color
 * --quiet --verbose --version`). The command declares **no `--timeout`**: the
 * name is reserved tree-wide because commander lets an ancestor consume a
 * matching option anywhere in argv, and a `--timeout` on a process that is
 * supposed to run until the operator stops it would mean nothing anyway. The
 * global is inherited and ignored.
 *
 * **The one place HQ's output contract meets a long-running process.**
 * `Renderer.success` is documented "call at most once per invocation". The
 * server is bound *first*, so the printed URL carries the real port when
 * `--listen 127.0.0.1:0` was used; the envelope is emitted immediately after,
 * through the same `runLocalCommand` every other local command uses; and then
 * the handler blocks until the listener stops. Nothing writes to stdout for the
 * rest of the run — a failure after that point is a signal, not a second
 * envelope.
 *
 * **`--open` never fails the command.** Go's `dashboard.OpenBrowser` printed a
 * line and carried on; HQ raises `renderer.warn` and carries on. The opener is
 * spawned with an argv array and `shell: false`, like every other child HQ
 * starts: the URL is ours, but a shell that re-parses a command line is a
 * category of bug worth not having.
 */

import { spawn } from "node:child_process";
import type { Command } from "commander";

import {
  createSiteCliIntegration,
  createSiteCliResolver,
  nodeIsFile,
  nodeSpawnChild,
  type ResolveSiteCli,
  type SpawnChild,
} from "../integration/index.js";
import { globalHttpFetch, type HttpFetch } from "../provisioning/http.js";
import {
  createDashboardServer,
  parseListenAddress,
  requireLoopbackHost,
  type BoundAddress,
  type DashboardIntegration,
  type DashboardServer,
} from "../web/index.js";
import type { CommandDependencies } from "./commands.js";
import { runLocalCommand } from "./hosting-command.js";
import type { GlobalOptions } from "./program.js";

/** Go's default (`internal/cli/dashboard.go:44`), unchanged. */
export const DEFAULT_DASHBOARD_LISTEN = "127.0.0.1:8787";

export interface DashboardCommandOptions {
  /** `--listen <address>`: a loopback `host:port`, `:port` or `port`. */
  readonly listen?: string;
  /** `--open`: launch the platform browser once the listener is up. */
  readonly open?: boolean;
}

export interface DashboardHandlers {
  /** `dashboard`. Resolves when the listener stops. */
  dashboard(
    options: DashboardCommandOptions,
    globals: GlobalOptions,
  ): Promise<void>;
}

/**
 * Seams for {@link createDashboardHandlers}; production supplies none.
 *
 * `spawn` and `resolveSiteCli` are the two seams of the connected-state
 * detector. They exist so a test can drive the service without a real
 * `novamira` child and without touching a real `PATH`; production builds it
 * from {@link nodeSpawnChild} and {@link createSiteCliResolver}. `integration`
 * replaces the whole service, for a test that wants to script its answers.
 */
export interface DashboardCommandOverrides {
  readonly fetch?: HttpFetch;
  readonly randomToken?: () => string;
  readonly now?: () => number;
  readonly spawn?: SpawnChild;
  readonly resolveSiteCli?: ResolveSiteCli;
  readonly integration?: DashboardIntegration;
  readonly openBrowser?: (target: string) => Promise<void>;
}

/**
 * Build the connected-state service the dashboard runs with.
 *
 * This is the only place `@novamira/cli` is reached for, and it is reached for
 * as a *process*, never as a package: nothing imports it, nothing depends on it,
 * and nothing reads its configuration, its profile store or its credentials.
 * With `novamira` absent the service still answers — every environment reports
 * `unavailable` with a fixed install hint — which is why it is built
 * unconditionally rather than only when something is found. Absent is a state,
 * not a missing dependency.
 *
 * Exported so a contract test can assert the production wiring without binding a
 * port: the seams below are the real ones unless a test replaces them.
 */
export function createDashboardIntegration(
  environment: NodeJS.ProcessEnv,
  overrides: DashboardCommandOverrides = {},
): DashboardIntegration {
  if (overrides.integration !== undefined) {
    return overrides.integration;
  }
  return createSiteCliIntegration({
    spawn: overrides.spawn ?? nodeSpawnChild,
    resolve:
      overrides.resolveSiteCli ??
      createSiteCliResolver({
        environment,
        platform: process.platform,
        isFile: nodeIsFile,
      }),
    environment,
    now: overrides.now ?? (() => Date.now()),
  });
}

/**
 * Launch the platform's URL opener with an argv array and no shell.
 *
 * Go's `OpenBrowser` (server.go:136-149), command for command. The child is
 * detached and unref'd so it cannot keep the process alive after the dashboard
 * stops, and its output goes nowhere: a browser's stderr is not the operator's
 * business.
 */
async function openInBrowser(target: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? (["open", [target]] as const)
      : process.platform === "win32"
        ? (["rundll32", ["url.dll,FileProtocolHandler", target]] as const)
        : (["xdg-open", [target]] as const);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      detached: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function humanSummary(bound: BoundAddress, configFile: string): string {
  return [`Novamira HQ dashboard: ${bound.url}`, `Config: ${configFile}`].join(
    "\n",
  );
}

export function createDashboardHandlers(
  dependencies: CommandDependencies,
  overrides: DashboardCommandOverrides = {},
): DashboardHandlers {
  const http: HttpFetch = overrides.fetch ?? globalHttpFetch;
  const openBrowser = overrides.openBrowser ?? openInBrowser;

  return {
    dashboard: async (options, globals) => {
      // Parsed and guarded before anything is constructed, so a bad `--listen`
      // fails with `usage_error` and never opens a socket.
      const address = parseListenAddress(
        options.listen ?? DEFAULT_DASHBOARD_LISTEN,
      );
      requireLoopbackHost(address.hostname);

      let server: DashboardServer | undefined;
      let bound: BoundAddress | undefined;

      await runLocalCommand(dependencies, globals, async ({ renderer, io }) => {
        const started = createDashboardServer({
          version: dependencies.version,
          paths: dependencies.paths,
          store: dependencies.store,
          hosting: dependencies.hosting,
          credentials: dependencies.credentials,
          environment: io.env,
          fetch: http,
          now: overrides.now ?? (() => Date.now()),
          // Built here, where the injected environment record exists, so
          // `NOVAMIRA_HQ_SITE_CLI` and `PATH` come from the same place every
          // other command reads them from.
          integration: createDashboardIntegration(io.env, overrides),
          ...(overrides.randomToken === undefined
            ? {}
            : { randomToken: overrides.randomToken }),
          onDiagnostic: (label, payload) => {
            renderer.diagnostic(label, payload);
          },
        });
        server = started;
        bound = await started.listen(address);
        return {
          data: {
            url: bound.url,
            host: bound.hostname,
            port: bound.port,
            configFile: dependencies.store.configFile,
          },
          human: humanSummary(bound, dependencies.store.configFile),
        };
      });

      if (server === undefined || bound === undefined) {
        return;
      }
      const running = server;
      const renderer = dependencies.rendererFor(globals);

      if (options.open === true) {
        try {
          await openBrowser(bound.url);
        } catch {
          renderer.warn(
            "The dashboard could not be opened in a browser; open the printed URL manually.",
          );
        }
      }

      // Stop on the two signals a foreground server is stopped with, and take
      // the listeners off again in `finally` so a caller that runs `main` twice
      // in one process (the contract tests do) does not accumulate them.
      const stop = (): void => {
        void running.close();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      try {
        await running.closed();
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    },
  };
}

/**
 * Attach `dashboard` to the root program.
 *
 * The registration order below is the shipped flag order and is compared
 * exactly by `test/cli-program-phase4-contract.test.mjs`'s command-surface
 * assertion.
 */
export function registerDashboardCommands(
  parent: Command,
  handlers: DashboardHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  parent
    .command("dashboard")
    .description("serve the local web dashboard")
    .option(
      "--listen <address>",
      "loopback listen address (host:port)",
      DEFAULT_DASHBOARD_LISTEN,
    )
    .option("--open", "open the dashboard in the default browser", false)
    .action(async (options: DashboardCommandOptions, command: Command) =>
      handlers.dashboard(options, optionsFor([command])),
    );
}
