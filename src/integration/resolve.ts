// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Finding the `novamira` executable, without ever reading the site CLI's
 * configuration.
 *
 * **What the Go did.** It did not resolve anything: it spelled `"novamira"` at
 * the call site and let `exec.Command` walk `PATH`. That is fine on POSIX and
 * quietly broken on Windows, where a global npm install puts a `novamira.cmd`
 * shim on `PATH` and Node 22 refuses to spawn a `.cmd` without a shell (the
 * CVE-2024-27980 hardening). "Use a shell then" is not available to HQ — a
 * shell re-parses a command line, which is exactly the class of bug the
 * argv-array rule exists to prevent.
 *
 * **What HQ does instead.** An explicit, injectable resolver:
 *
 * 1. `NOVAMIRA_HQ_SITE_CLI`, when set and non-empty, wins outright. It is *HQ's*
 *    variable — the site CLI's own environment variables are never read, and
 *    neither is `NOVAMIRA_HOME`.
 * 2. Otherwise walk `PATH`.
 *    - Non-Windows: the first existing regular file named `novamira` wins and is
 *      spawned directly.
 *    - Windows: probe the extensionless name and each `PATHEXT` suffix in order.
 *      A `.exe`/`.com` hit is spawned directly. Anything else — a
 *      `.cmd`/`.bat`/`.ps1` shim, or the **extensionless** hit — resolves the
 *      CLI's own entry script next to the shim and spawns `process.execPath`
 *      with that script as the first argument. Reading the CLI's *installation
 *      layout* is explicitly not reading its config, its profile store, or its
 *      credentials.
 *
 *      The extensionless case is not a curiosity: `npm i -g` writes three files
 *      side by side — `novamira` (a POSIX `sh` script with no extension),
 *      `novamira.cmd` and `novamira.ps1` — and the extensionless one is the
 *      first candidate the probe order reaches. Treating it as directly
 *      spawnable would hand `CreateProcess` a file that is not an executable
 *      image, and the `.cmd` fallback this whole branch exists for would never
 *      run: every Windows operator with the CLI installed would be told it was
 *      absent.
 * 3. Nothing found is `undefined`, which `connection.ts` turns into the
 *    connection state `unavailable` with reason `cli_absent` — never an error.
 *
 * **Caching.** A positive resolution is cached for the process lifetime: the
 * dashboard refreshes connection state repeatedly and re-walking `PATH` each
 * time buys nothing. A negative result is deliberately *not* cached, so
 * installing the CLI while the dashboard is running is picked up on the next
 * refresh without a restart.
 *
 * **Everything is injected** — the environment record, the platform, the path
 * separator, `execPath`, and the `isFile` probe — so a contract test can assert
 * the Windows shim path from Linux and no test ever touches a real `PATH`.
 */

import { stat } from "node:fs/promises";
import { siteCliEnvironment } from "./environment.js";
import { posix as posixPath, win32 as win32Path } from "node:path";

import { SITE_CLI_OVERRIDE_ENV } from "../connection-state.js";

/** The executable, and any arguments that must precede the CLI's own argv. */
export interface SiteCliResolution {
  readonly command: string;
  /** Empty for a direct spawn; `[<entry script>]` for the Windows shim path. */
  readonly prefixArgs: readonly string[];
}

export type ResolveSiteCli = () => Promise<SiteCliResolution | undefined>;

/**
 * HQ's own override, and the fixed hint that names it.
 *
 * Both moved to `src/connection-state.ts` in 6b and are re-exported here, so
 * that `src/web/` can render the hint without importing `src/integration/` (the
 * two are peer layers). This module remains the only one that *reads* the
 * variable; the root module only spells it, once, so the sentence and the lookup
 * cannot drift.
 */
export { SITE_CLI_INSTALL_HINT } from "../connection-state.js";
export { SITE_CLI_OVERRIDE_ENV };

/** The executable name, as published by `@novamira/cli`. */
export const SITE_CLI_COMMAND = "novamira";

/** Windows' default when `PATHEXT` is unset, in the order the shell probes. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Suffixes Node can spawn directly on Windows without a shell.
 *
 * The extensionless spelling is deliberately absent: on Windows it is npm's
 * POSIX `sh` shim, not an executable image. On every other platform this list is
 * not consulted at all.
 */
const DIRECT_SPAWN_EXTENSIONS: readonly string[] = [".exe", ".com"];

/**
 * Where a global npm install puts the CLI's entry script relative to the shim.
 * The first form is npm's per-prefix layout, the second is the `bin`-beside-
 * `lib` layout used by nvm-windows and by npm's default Windows prefix.
 */
const SHIM_ENTRY_CANDIDATES: readonly (readonly string[])[] = [
  ["node_modules", "@novamira", "cli", "dist", "index.js"],
  ["..", "lib", "node_modules", "@novamira", "cli", "dist", "index.js"],
];

export interface SiteCliResolverOptions {
  /**
   * The injected process environment. `NodeJS.ProcessEnv` rather than
   * `RuntimeEnvironment` because that type lives in `src/main.ts`, the
   * composition root: importing it here would invert the layering. The two are
   * structurally identical for a `PATH` lookup.
   */
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Defaults to `;` on Windows and `:` elsewhere. */
  readonly pathSeparator?: string;
  /** Injected so no test walks a real filesystem entry it did not create. */
  readonly isFile: (candidate: string) => Promise<boolean>;
  /** Defaults to `process.execPath`; only used on the Windows shim path. */
  readonly execPath?: string;
}

/** The production `isFile`: a regular file, and `false` for anything else. */
export async function nodeIsFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** `PATH` under any of the spellings Windows and POSIX use. */
function pathVariable(environment: NodeJS.ProcessEnv): string {
  return environment.PATH ?? environment.Path ?? environment.path ?? "";
}

/** Windows quotes `PATH` entries that contain spaces; the quotes are not part of the path. */
function cleanEntry(entry: string): string {
  const trimmed = entry.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1
    ? trimmed.slice(1, -1)
    : trimmed;
}

function pathExtensions(environment: NodeJS.ProcessEnv): readonly string[] {
  const raw = environment.PATHEXT ?? DEFAULT_PATHEXT;
  return raw
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."));
}

export function createSiteCliResolver(
  options: SiteCliResolverOptions,
): ResolveSiteCli {
  const windows = options.platform === "win32";
  // The platform is injected, so the *path* flavour must be too: a test asserts
  // the Windows shim path while running on Linux, where `node:path`'s default
  // export would join with forward slashes.
  const segments = windows ? win32Path : posixPath;
  const join = (...parts: readonly string[]): string => segments.join(...parts);
  const dirname = (value: string): string => segments.dirname(value);
  const separator = options.pathSeparator ?? (windows ? ";" : ":");
  const execPath = options.execPath ?? process.execPath;
  let cached: SiteCliResolution | undefined;

  /** The Windows fallback: spawn Node with the CLI's own entry script. */
  const resolveShim = async (
    shim: string,
  ): Promise<SiteCliResolution | undefined> => {
    const shimDirectory = dirname(shim);
    for (const segments of SHIM_ENTRY_CANDIDATES) {
      const entry = join(shimDirectory, ...segments);
      if (await options.isFile(entry)) {
        return { command: execPath, prefixArgs: [entry] };
      }
    }
    return undefined;
  };

  const searchPath = async (): Promise<SiteCliResolution | undefined> => {
    const extensions = windows
      ? ["", ...pathExtensions(options.environment)]
      : [""];
    for (const rawEntry of pathVariable(
      siteCliEnvironment(options.environment, options.platform),
    ).split(separator)) {
      const directory = cleanEntry(rawEntry);
      if (directory === "") continue;
      for (const extension of extensions) {
        const candidate = join(directory, `${SITE_CLI_COMMAND}${extension}`);
        if (!(await options.isFile(candidate))) continue;
        if (!windows || DIRECT_SPAWN_EXTENSIONS.includes(extension)) {
          return { command: candidate, prefixArgs: [] };
        }
        // A `.cmd`/`.bat`/`.ps1` shim, or npm's extensionless `sh` script: Node
        // 22 will not spawn any of them without a shell, and HQ never uses a
        // shell. Fall back to the entry script beside the shim, and if that is
        // not there keep searching rather than giving up.
        const viaShim = await resolveShim(candidate);
        if (viaShim !== undefined) return viaShim;
      }
    }
    return undefined;
  };

  return async () => {
    if (cached !== undefined) return cached;
    const override = options.environment[SITE_CLI_OVERRIDE_ENV]?.trim();
    const resolution =
      override !== undefined && override !== ""
        ? { command: override, prefixArgs: [] }
        : await searchPath();
    // Positive answers are cached; a negative one is re-probed every refresh so
    // installing the CLI while the dashboard runs takes effect immediately.
    if (resolution !== undefined) cached = resolution;
    return resolution;
  };
}
