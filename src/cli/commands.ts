// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { VerifiedFileSecurity } from "../config/file-security.js";
import type { ProfileLockManager } from "../config/lock.js";
import type { PlatformPaths } from "../config/paths.js";
import type { ConfigStore } from "../config/profiles.js";
import type { CredentialStore } from "../credentials/store.js";
import type { HostingClientFactory } from "../hosting/factory.js";
import type { ProbeSiteCli } from "../integration/index.js";
import type {
  CommandMeta,
  InvocationWarning,
  Renderer,
} from "../output/render.js";
import type { SkillStore } from "../skills/index.js";
import type { InstallRunner, UpdateChecker } from "../update/index.js";
import { createDashboardHandlers } from "./dashboard.js";
import { createDoctorHandlers } from "./doctor.js";
import { createHostingCommandHandlers } from "./hosting/index.js";
import { createSkillsHandlers } from "./skills.js";
import { createUpdateHandlers } from "./update.js";
import type { CommandHandlers, GlobalOptions } from "./program.js";
import { attentionEntries, type HistoryStore } from "../history/index.js";

/** What a command produces; the renderer decides how it reaches the user. */
interface CommandResult {
  /** The `data` member of the success envelope. */
  readonly data: unknown;
  /** Extra `meta` fields (profile, provider). */
  readonly meta?: CommandMeta;
  /** Non-fatal warnings; `meta.warnings` in JSON mode, stderr otherwise. */
  readonly warnings?: readonly InvocationWarning[];
  /** Human-mode rendering. JSON mode always emits `data`. */
  readonly human?: string;
}

export interface CommandDependencies {
  readonly distribution?: "npm" | "desktop";
  readonly mcpConnection?: import("../mcp-connection.js").McpConnectionService;
  readonly history: HistoryStore;
  /** The version reported by `--version` and, later, by `doctor`. */
  readonly version: string;
  readonly paths: PlatformPaths;
  readonly store: ConfigStore;
  /**
   * Builds a `ProviderClient` from a named hosting profile, over the provider
   * registry the composition root injected. The Phase 4 hosting handlers below
   * are its only consumers; a test supplies a factory over a fake registry so
   * no command can reach a live provider API.
   */
  readonly hosting: HostingClientFactory;
  /**
   * The credential store, resolved lazily and at most once per process:
   * constructing it probes the OS keychain, and a command that resolves only
   * `env`/`file` references must not pay for a subprocess it never uses. The
   * dashboard server takes the getter rather than the store for exactly that
   * reason — it is built at startup and may never touch a `stored` credential.
   */
  readonly credentials: () => Promise<CredentialStore>;
  /**
   * Owner-only file permissions, verified and applied.
   *
   * `main.ts` has always built one; Phase 7 is the first consumer outside the
   * config layer, because `doctor`'s `storage.permissions` check verifies HQ's
   * private paths and `--fix` repairs them.
   */
  readonly security: VerifiedFileSecurity;
  /** The packaged agent-skill bundles; `skills` reads them, `doctor` checks them. */
  readonly skills: SkillStore;
  /**
   * "Is `novamira` installed and compatible?", from `src/integration/` — the
   * only place HQ runs that executable. It is a function rather than the
   * integration service because `doctor` asks a different question than the
   * dashboard does, and because every branch of the answer is a warning.
   */
  readonly probeSiteCli: ProbeSiteCli;
  /**
   * The one lock manager this process owns.
   *
   * `main.ts` has always built it — `ConfigStore` takes it — and 7-2 is the
   * first consumer outside the config layer: `UpdateChecker` holds
   * `__update_check__` across both the registry request and the record write,
   * so two HQ invocations starting together make at most one request per
   * interval. It is exposed here rather than reached for through `store`
   * because a manager rejects re-entrant acquisition of a key it already holds,
   * and two managers behave like two processes.
   */
  readonly locks: ProfileLockManager;
  /**
   * Builds the update checker bound to a request deadline, in milliseconds.
   *
   * A factory rather than an instance because the deadline differs per caller:
   * `update` passes `--timeout`, the doctor's `update.available` check passes
   * its own short budget, and the dashboard's card passes a longer one. All of
   * them share one state record, one lock key and one registry, because the
   * composition root closes over the same paths and locks every time.
   */
  readonly createUpdateChecker: (timeoutMs: number) => UpdateChecker;
  /**
   * Builds the package-manager runner `update` spawns, bounded by `timeoutMs`
   * when an explicit `--timeout` was given and by the runner's own five-minute
   * default otherwise. A seam, so a contract test can prove `--check` never
   * spawns anything and that a non-zero exit is an `internal_error`.
   */
  readonly createInstallRunner: (
    timeoutMs: number | undefined,
  ) => InstallRunner;
  /**
   * Resolves the process-wide renderer from the parsed global options.
   * Memoized in `main.ts`, so one renderer — and one `requestId` — serves the
   * whole invocation, including the failure path.
   */
  rendererFor(options: GlobalOptions): Renderer;
}

/** Align `key: value` lines for human-mode path output. */
function humanReport(report: Readonly<Record<string, string>>): string {
  const keys = Object.keys(report);
  const width = keys.reduce((widest, key) => Math.max(widest, key.length), 0);
  return Object.entries(report)
    .map(([key, value]) => `${key.padEnd(width)}  ${value}`)
    .join("\n");
}

export function createCommandHandlers(
  dependencies: CommandDependencies,
): CommandHandlers {
  const { paths, store } = dependencies;

  const execute = async (
    options: GlobalOptions,
    run: () => Promise<CommandResult> | CommandResult,
  ): Promise<void> => {
    const renderer = dependencies.rendererFor(options);
    const result = await run();
    renderer.success(result.data, {
      ...(result.meta === undefined ? {} : { meta: result.meta }),
      ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
      ...(result.human === undefined ? {} : { human: result.human }),
    });
  };

  return {
    historyList: (options) =>
      execute(options, async () => {
        const entries = await dependencies.history.list(options.profile);
        return {
          data: { entries, needsAttention: attentionEntries(entries).length },
          human:
            entries.length === 0
              ? "No hosting requests recorded."
              : entries
                  .map(
                    (entry) =>
                      `${entry.startedAt}  ${entry.channel}  ${entry.profile}  ${entry.action}  ${entry.environmentId ?? entry.siteId ?? "—"}  ${entry.status}${entry.operationId === undefined ? "" : `  operation=${entry.operationId}`}`,
                  )
                  .join("\n"),
        };
      }),
    // The ~100 hosting handlers, built over the same dependencies. They render
    // through `runHostingCommand`/`runLocalCommand`, which call the very
    // `rendererFor` below, so hosting and local commands share one renderer,
    // one `requestId` and one envelope.
    ...createHostingCommandHandlers(dependencies),

    // The `dashboard` command. It is a top-level peer of `hosting`, and its
    // handler is the only one that does not return: it binds, renders the one
    // envelope, and then blocks until the listener stops.
    ...createDashboardHandlers(dependencies),

    // `skills` and `doctor`: two local groups that reach no provider. `doctor`
    // is the one command whose *contents* may report a failure while the
    // invocation itself succeeds — see `cli/doctor.ts`.
    ...createSkillsHandlers(dependencies),
    ...createDoctorHandlers(dependencies),

    // `update`: the third top-level command. It is the only handler in HQ that
    // spawns a package manager, and the only one whose child's output reaches
    // the operator verbatim — on stderr, never on stdout.
    ...createUpdateHandlers(dependencies),

    version: (programVersion, options) =>
      execute(options, () => ({
        data: { version: programVersion },
        human: programVersion,
      })),

    configPath: (options) =>
      execute(options, () => {
        // Non-secret by construction: these are locations, never contents.
        const data = {
          configFile: store.configFile,
          configDir: paths.configDir,
          stateDir: paths.stateDir,
          locksDir: paths.locksDir,
          lockFile: paths.lockFile,
          cacheDir: paths.cacheDir,
          credentialsDir: paths.credentialsDir,
        };
        return { data, human: humanReport(data) };
      }),
  };
}
