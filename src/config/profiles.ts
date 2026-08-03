// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";

import { CliError } from "../errors.js";
import { atomicWriteFile } from "./atomic-write.js";
import type { FileSecurity } from "./file-security.js";
import { CONFIG_LOCK_KEY, type ProfileLockManager } from "./lock.js";
import {
  emptyConfigDocument,
  emptyNameMap,
  parseConfigDocument,
  parseDeployPath,
  parseHostingProfile,
  serializeConfigDocument,
  validateDeployPathName,
  validateProfileName,
  type ConfigDocument,
  type DeployPath,
  type HostingProfile,
} from "./schema.js";

/**
 * Lock key prefixes. The whole-document key is `CONFIG_LOCK_KEY`, so profile
 * and deploy-path keys are namespaced: a hosting profile that happened to be
 * named `config` must not collide with the document lock (one
 * `ProfileLockManager` refuses to hold the same key twice).
 */
export const HOSTING_PROFILE_LOCK_PREFIX = "hosting-profile:";
export const DEPLOY_PATH_LOCK_PREFIX = "deploy-path:";

export function hostingProfileLockKey(name: string): string {
  return `${HOSTING_PROFILE_LOCK_PREFIX}${name}`;
}

export function deployPathLockKey(name: string): string {
  return `${DEPLOY_PATH_LOCK_PREFIX}${name}`;
}

export interface HostingProfileEntry {
  readonly name: string;
  readonly profile: HostingProfile;
}

/** Lock keys held by the current async call chain, for re-entrancy detection. */
const heldLockKeys = new AsyncLocalStorage<ReadonlySet<string>>();
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

function sortedNames(record: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(record).sort((left, right) => left.localeCompare(right));
}

/**
 * Own-property lookup. Profile and deploy-path names are user-chosen and the
 * name pattern accepts `toString`, `constructor`, `valueOf` and friends, so a
 * bare `record[name]` could yield an inherited `Object.prototype` function and
 * be mistaken for an existing entry. Maps are built prototype-less as well;
 * this guard keeps the invariant even for a map rebuilt by object spread.
 */
function lookup<T>(
  record: Readonly<Record<string, T>>,
  name: string,
): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

function withKey<T>(
  record: Readonly<Record<string, T>>,
  name: string,
  value: T,
): Record<string, T> {
  const next = emptyNameMap<T>();
  for (const [key, entry] of Object.entries(record)) next[key] = entry;
  next[name] = value;
  return next;
}

function withoutKey<T>(
  record: Readonly<Record<string, T>>,
  name: string,
): Record<string, T> {
  const next = emptyNameMap<T>();
  for (const [key, entry] of Object.entries(record))
    if (key !== name) next[key] = entry;
  return next;
}

function profileNotFound(name: string, profiles: readonly string[]): CliError {
  return new CliError(
    "profile_not_found",
    `Hosting profile ${name} was not found.`,
    { details: { profiles } },
  );
}

function deployPathNotFound(
  name: string,
  deployPaths: readonly string[],
): CliError {
  // `profile_not_found` is the taxonomy's exit-2 "named local entry is
  // missing" code; a mistyped deploy-path name is the same class of mistake.
  return new CliError(
    "profile_not_found",
    `Deploy path ${name} was not found.`,
    { details: { deployPaths } },
  );
}

/**
 * Reads and writes HQ's `config.json`.
 *
 * Every mutation is a read-modify-write under `CONFIG_LOCK_KEY`, nested inside
 * a per-entry lock so that a config write and the matching credential write can
 * share one lock acquisition (plan §5.5). Credential code should call
 * {@link ConfigStore.withHostingProfileLock} once and then use the
 * `*WithProfileLockHeld` mutators, rather than taking the lock twice.
 *
 * Nothing written here is secret: a `stored` credential keeps only an opaque
 * id, and the secret itself lives in the credential store.
 */
export class ConfigStore {
  /** In-process wait queue, one chain per lock key. */
  private readonly queue = new Map<string, Promise<void>>();

  constructor(
    public readonly configFile: string,
    private readonly locks: ProfileLockManager,
    private readonly security: FileSecurity,
  ) {}

  /** Load the document, or an empty version-1 document when no file exists. */
  async load(): Promise<ConfigDocument> {
    let raw: string;
    try {
      raw = await readFile(this.configFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyConfigDocument();
      throw new CliError(
        "config_error",
        `Failed to read the configuration file at ${this.configFile}.`,
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new CliError(
        "config_error",
        `The configuration file at ${this.configFile} is not valid JSON.`,
        { cause },
      );
    }
    try {
      return parseConfigDocument(parsed);
    } catch (error) {
      if (error instanceof CliError) {
        throw new CliError(
          error.code,
          `${error.message} (in ${this.configFile})`,
          {
            retryable: error.retryable,
            ...(error.details === undefined ? {} : { details: error.details }),
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  /**
   * Write a document. The caller is responsible for serialising writes; use
   * {@link ConfigStore.updateDocument} unless a lock is already held.
   */
  async save(document: ConfigDocument): Promise<void> {
    await atomicWriteFile(
      this.configFile,
      serializeConfigDocument(parseConfigDocument(document)),
      this.security,
    );
  }

  /**
   * Read-modify-write the whole document under the config lock, returning the
   * saved document. Never call it from inside another `updateDocument` on the
   * same store: the lock manager refuses to hold one key twice.
   */
  async updateDocument(
    mutator: (
      document: ConfigDocument,
    ) => ConfigDocument | Promise<ConfigDocument>,
  ): Promise<ConfigDocument> {
    return this.mutate(async (document) => {
      const next = await mutator(document);
      return { document: next, result: next };
    });
  }

  /**
   * Run `operation` while holding the hosting profile's lock. Credential
   * mutation and config mutation for the same profile belong inside one call.
   */
  async withHostingProfileLock<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runExclusive(
      hostingProfileLockKey(validateProfileName(name)),
      operation,
    );
  }

  /** Alias kept for symmetry with the site CLI's `withProfileLock` naming. */
  async withProfileLock<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withHostingProfileLock(name, operation);
  }

  async withDeployPathLock<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runExclusive(
      deployPathLockKey(validateDeployPathName(name)),
      operation,
    );
  }

  async listHostingProfiles(): Promise<HostingProfileEntry[]> {
    const document = await this.load();
    return sortedNames(document.hostingProfiles).flatMap((name) => {
      const profile = lookup(document.hostingProfiles, name);
      return profile === undefined ? [] : [{ name, profile }];
    });
  }

  async getHostingProfile(name: string): Promise<HostingProfile | undefined> {
    return lookup((await this.load()).hostingProfiles, name);
  }

  /** Like {@link ConfigStore.getHostingProfile}, but fails with `profile_not_found`. */
  async requireHostingProfile(name: string): Promise<HostingProfileEntry> {
    const document = await this.load();
    const profile = lookup(document.hostingProfiles, name);
    if (profile === undefined)
      throw profileNotFound(name, sortedNames(document.hostingProfiles));
    return { name, profile };
  }

  /**
   * Resolve an explicitly requested profile, mirroring the Go
   * `SelectedHostingProfile`: the profile is never inferred, it must be named.
   */
  async selectHostingProfile(
    requested: string | undefined,
  ): Promise<HostingProfileEntry> {
    const document = await this.load();
    const profiles = sortedNames(document.hostingProfiles);
    if (requested === undefined || requested === "") {
      throw new CliError(
        "usage_error",
        "Select a hosting profile with --profile.",
        { details: { profiles } },
      );
    }
    const profile = lookup(document.hostingProfiles, requested);
    if (profile === undefined) throw profileNotFound(requested, profiles);
    return { name: requested, profile };
  }

  async upsertHostingProfile(
    name: string,
    profile: HostingProfile,
  ): Promise<HostingProfile> {
    return this.withHostingProfileLock(name, () =>
      this.upsertHostingProfileWithProfileLockHeld(name, profile),
    );
  }

  /** Upsert without taking the profile lock; the caller must already hold it. */
  async upsertHostingProfileWithProfileLockHeld(
    name: string,
    profile: HostingProfile,
  ): Promise<HostingProfile> {
    const key = validateProfileName(name);
    const validated = parseHostingProfile(profile, `hostingProfiles.${key}`);
    await this.mutate((document) => ({
      document: {
        ...document,
        hostingProfiles: withKey(document.hostingProfiles, key, validated),
      },
      result: undefined,
    }));
    return validated;
  }

  async removeHostingProfile(name: string): Promise<HostingProfile> {
    return this.withHostingProfileLock(name, () =>
      this.removeHostingProfileWithProfileLockHeld(name),
    );
  }

  /** Remove without taking the profile lock; the caller must already hold it. */
  async removeHostingProfileWithProfileLockHeld(
    name: string,
  ): Promise<HostingProfile> {
    const key = validateProfileName(name);
    return this.mutate((document) => {
      const existing = lookup(document.hostingProfiles, key);
      if (existing === undefined)
        throw profileNotFound(key, sortedNames(document.hostingProfiles));
      return {
        document: {
          ...document,
          hostingProfiles: withoutKey(document.hostingProfiles, key),
        },
        result: existing,
      };
    });
  }

  async listDeployPaths(): Promise<DeployPath[]> {
    const document = await this.load();
    return sortedNames(document.deployPaths).flatMap((name) => {
      const deployPath = lookup(document.deployPaths, name);
      return deployPath === undefined ? [] : [deployPath];
    });
  }

  async getDeployPath(name: string): Promise<DeployPath | undefined> {
    return lookup((await this.load()).deployPaths, name);
  }

  async requireDeployPath(name: string): Promise<DeployPath> {
    const document = await this.load();
    const deployPath = lookup(document.deployPaths, name);
    if (deployPath === undefined)
      throw deployPathNotFound(name, sortedNames(document.deployPaths));
    return deployPath;
  }

  /**
   * Upsert a deploy path, keyed by its own `name`. The referenced hosting
   * profile is not required to exist: a path may outlive a profile that is
   * about to be recreated, exactly as in the Go dashboard.
   */
  async upsertDeployPath(deployPath: DeployPath): Promise<DeployPath> {
    return this.withDeployPathLock(deployPath.name, () =>
      this.upsertDeployPathWithLockHeld(deployPath),
    );
  }

  /** Upsert without taking the deploy-path lock; the caller must hold it. */
  async upsertDeployPathWithLockHeld(
    deployPath: DeployPath,
  ): Promise<DeployPath> {
    const key = validateDeployPathName(deployPath.name);
    const validated = parseDeployPath(deployPath, `deployPaths.${key}`, key);
    await this.mutate((document) => ({
      document: {
        ...document,
        deployPaths: withKey(document.deployPaths, key, validated),
      },
      result: undefined,
    }));
    return validated;
  }

  async removeDeployPath(name: string): Promise<DeployPath> {
    return this.withDeployPathLock(name, () =>
      this.removeDeployPathWithLockHeld(name),
    );
  }

  /** Remove without taking the deploy-path lock; the caller must hold it. */
  async removeDeployPathWithLockHeld(name: string): Promise<DeployPath> {
    const key = validateDeployPathName(name);
    return this.mutate((document) => {
      const existing = lookup(document.deployPaths, key);
      if (existing === undefined)
        throw deployPathNotFound(key, sortedNames(document.deployPaths));
      return {
        document: {
          ...document,
          deployPaths: withoutKey(document.deployPaths, key),
        },
        result: existing,
      };
    });
  }

  private async mutate<T>(
    mutator: (
      document: ConfigDocument,
    ) =>
      | { document: ConfigDocument; result: T }
      | Promise<{ document: ConfigDocument; result: T }>,
  ): Promise<T> {
    return this.runExclusive(CONFIG_LOCK_KEY, async () => {
      const current = await this.load();
      const { document, result } = await mutator(current);
      await this.writeDocument(document);
      return result;
    });
  }

  /**
   * Take `key`'s cross-process lock, queueing behind any in-process holder.
   *
   * `ProfileLockManager` refuses to hold one key twice, so two overlapping
   * dashboard requests would otherwise fail instead of waiting for each other.
   * Genuine re-entrancy — the same key taken again inside its own operation —
   * still fails fast rather than deadlocking on the queue.
   */
  private async runExclusive<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const held = heldLockKeys.getStore() ?? EMPTY_KEYS;
    if (held.has(key)) {
      throw new CliError(
        "internal_error",
        `Configuration lock ${key} is already held by this operation.`,
      );
    }
    const nested = new Set(held).add(key);
    const previous = this.queue.get(key) ?? Promise.resolve();
    const run = previous.then(async () =>
      heldLockKeys.run(nested, () => this.locks.withLock(key, operation)),
    );
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queue.set(key, settled);
    void settled.then(() => {
      if (this.queue.get(key) === settled) this.queue.delete(key);
    });
    return run;
  }

  private async writeDocument(document: ConfigDocument): Promise<void> {
    await atomicWriteFile(
      this.configFile,
      serializeConfigDocument(document),
      this.security,
    );
  }
}
