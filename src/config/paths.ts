// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";

import { CONFIG_LOCK_KEY, LOCK_DIRECTORY_NAME, lockFileName } from "./lock.js";

// HQ owns a namespace that is completely disjoint from the site CLI's. The site
// CLI owns `NOVAMIRA_HOME`, `novamira` (XDG) and `Novamira` (macOS/Windows);
// HQ owns `NOVAMIRA_HQ_HOME`, `novamira-hq` and `Novamira HQ`. `NOVAMIRA_HOME`
// is deliberately never read here: a user who points the site CLI at a custom
// root must not silently relocate HQ's config, locks, cache or credentials.
const XDG_DIRECTORY = "novamira-hq";
const NAMED_DIRECTORY = "Novamira HQ";

export interface PlatformPaths {
  /** Directory holding `config.json`; always `dirname(configFile)`. */
  readonly configDir: string;
  readonly configFile: string;
  readonly stateDir: string;
  /** Directory `ProfileLockManager` writes lock files into. */
  readonly locksDir: string;
  /**
   * Lock file guarding whole-config reads and writes; the file
   * `ProfileLockManager` uses for `CONFIG_LOCK_KEY`.
   */
  readonly lockFile: string;
  readonly cacheDir: string;
  readonly credentialsDir: string;
}

export interface PathEnvironment {
  readonly NOVAMIRA_HQ_HOME?: string;
  readonly NOVAMIRA_HQ_CONFIG?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly XDG_STATE_HOME?: string;
  readonly XDG_CACHE_HOME?: string;
  readonly APPDATA?: string;
  readonly LOCALAPPDATA?: string;
}

/** Local, bounded hosting request journal, separate from configuration. */
export function historyFilePath(
  paths: Pick<PlatformPaths, "stateDir">,
): string {
  return join(paths.stateDir, "hosting-history.json");
}

export function appAcknowledgementPath(
  paths: Pick<PlatformPaths, "stateDir">,
): string {
  return join(paths.stateDir, "app-acknowledgement.json");
}

export function proLicenseMetadataPath(
  paths: Pick<PlatformPaths, "stateDir">,
): string {
  return join(paths.stateDir, "novamira-pro-license.json");
}

interface PathApi {
  join(...parts: string[]): string;
  dirname(path: string): string;
}

interface RootPaths {
  readonly configFile: string;
  readonly stateDir: string;
  readonly cacheDir: string;
  readonly credentialsDir: string;
}

/**
 * The contract's one rule for every HQ environment override: *an empty-string
 * override is treated as unset.*
 *
 * Exported because the rule outgrew this module. `src/main.ts` applies it to
 * `NOVAMIRA_HQ_REGISTRY`, the only HQ override that is not a path — without it
 * an exported-but-empty variable reaches `new URL("/")` and surfaces as an
 * `internal_error` from `update` rather than as "no override given". A second
 * spelling of the rule is a second place for it to drift.
 */
export function overrideOf(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function rootPaths(
  environment: PathEnvironment,
  platform: NodeJS.Platform,
  home: string,
  api: PathApi,
): RootPaths {
  const root = overrideOf(environment.NOVAMIRA_HQ_HOME);
  if (root !== undefined) {
    return {
      configFile: api.join(root, "config.json"),
      stateDir: api.join(root, "state"),
      cacheDir: api.join(root, "cache"),
      credentialsDir: api.join(root, "credentials"),
    };
  }

  if (platform === "win32") {
    const roaming =
      overrideOf(environment.APPDATA) ?? api.join(home, "AppData", "Roaming");
    const local =
      overrideOf(environment.LOCALAPPDATA) ??
      api.join(home, "AppData", "Local");
    return {
      configFile: api.join(roaming, NAMED_DIRECTORY, "config.json"),
      stateDir: api.join(local, NAMED_DIRECTORY, "State"),
      cacheDir: api.join(local, NAMED_DIRECTORY, "Cache"),
      credentialsDir: api.join(local, NAMED_DIRECTORY, "Credentials"),
    };
  }

  if (platform === "darwin") {
    const support = api.join(
      home,
      "Library",
      "Application Support",
      NAMED_DIRECTORY,
    );
    return {
      configFile: api.join(support, "config.json"),
      stateDir: api.join(support, "State"),
      cacheDir: api.join(home, "Library", "Caches", NAMED_DIRECTORY),
      credentialsDir: api.join(support, "Credentials"),
    };
  }

  const configHome =
    overrideOf(environment.XDG_CONFIG_HOME) ?? api.join(home, ".config");
  const stateHome =
    overrideOf(environment.XDG_STATE_HOME) ?? api.join(home, ".local", "state");
  const cacheHome =
    overrideOf(environment.XDG_CACHE_HOME) ?? api.join(home, ".cache");
  return {
    configFile: api.join(configHome, XDG_DIRECTORY, "config.json"),
    stateDir: api.join(stateHome, XDG_DIRECTORY),
    cacheDir: api.join(cacheHome, XDG_DIRECTORY),
    credentialsDir: api.join(stateHome, XDG_DIRECTORY, "credentials"),
  };
}

/**
 * Resolve HQ's storage paths. Pure in `(environment, platform, home)` so a
 * contract test can resolve every platform from a single fake home and prove
 * that no HQ path collides with the site CLI's.
 */
export function platformPaths(
  environment: PathEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): PlatformPaths {
  const api: PathApi = platform === "win32" ? win32 : { join, dirname };
  const roots = rootPaths(environment, platform, home, api);
  // An explicit config override relocates only `config.json`; state, cache and
  // credentials keep their platform locations so a one-off config file cannot
  // scatter secrets into an unexpected directory.
  const configFile =
    overrideOf(environment.NOVAMIRA_HQ_CONFIG) ?? roots.configFile;
  const locksDir = api.join(roots.stateDir, LOCK_DIRECTORY_NAME);
  return {
    configDir: api.dirname(configFile),
    configFile,
    stateDir: roots.stateDir,
    locksDir,
    lockFile: api.join(locksDir, lockFileName(CONFIG_LOCK_KEY)),
    cacheDir: roots.cacheDir,
    credentialsDir: roots.credentialsDir,
  };
}
