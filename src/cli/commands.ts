// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PlatformPaths } from "../config/paths.js";
import type { ConfigStore } from "../config/profiles.js";
import type {
  CommandMeta,
  InvocationWarning,
  Renderer,
} from "../output/render.js";
import type { CommandHandlers, GlobalOptions } from "./program.js";

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
  /** The version reported by `--version` and, later, by `doctor`. */
  readonly version: string;
  readonly paths: PlatformPaths;
  readonly store: ConfigStore;
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

    // -------------------------------------------------------------------------
    // PHASE 4 REGISTRATION POINT
    //
    // Hosting handlers land here, each one `execute(options, async () => ...)`
    // over a `ProviderClient` obtained from the `HostingClientFactory` that
    // `main.ts` injects into `CommandDependencies`. Render domain objects
    // through `src/hosting/types.ts`'s `serialize*` helpers so the JSON payload
    // keeps the Go wire names.
    // -------------------------------------------------------------------------
  };
}
