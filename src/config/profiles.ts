// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { CliError } from "../errors.js";
import { atomicWriteFile } from "./atomic-write.js";
import type { VerifiedFileSecurity } from "./file-security.js";
import { CONFIG_LOCK_KEY, type ProfileLockManager } from "./lock.js";
import {
  emptyConfigDocument,
  emptyNameMap,
  parseConfigDocument,
  parseSavedPush,
  parseHostingProfile,
  serializeConfigDocument,
  validateSavedPushName,
  validateProfileName,
  type ConfigDocument,
  type SavedPush,
  type HostingProfile,
} from "./schema.js";

/**
 * Lock key prefixes. The whole-document key is `CONFIG_LOCK_KEY`, so profile
 * and push keys are namespaced: a hosting profile that happened to be
 * named `config` must not collide with the document lock (one
 * `ProfileLockManager` refuses to hold the same key twice).
 */
export const HOSTING_PROFILE_LOCK_PREFIX = "hosting-profile:";
export const PUSH_LOCK_PREFIX = "push:";

export function hostingProfileLockKey(name: string): string {
  return `${HOSTING_PROFILE_LOCK_PREFIX}${name}`;
}

export function pushLockKey(name: string): string {
  return `${PUSH_LOCK_PREFIX}${name}`;
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
 * Own-property lookup. Profile and push names are user-chosen and the
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

function pushNotFound(name: string, pushes: readonly string[]): CliError {
  // `profile_not_found` is the taxonomy's exit-2 "named local entry is
  // missing" code; a mistyped push name is the same class of mistake.
  return new CliError("profile_not_found", `Push ${name} was not found.`, {
    details: { pushes },
  });
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
    private readonly security: VerifiedFileSecurity,
  ) {}

  /** Load the document, or an empty version-1 document when no file exists. */
  async load(): Promise<ConfigDocument> {
    const exists = await this.assertTrustedStorage();
    if (!exists) return emptyConfigDocument();

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
    await this.assertTrustedStorage();
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

  async withSavedPushLock<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runExclusive(
      pushLockKey(validateSavedPushName(name)),
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

  async listPushes(): Promise<SavedPush[]> {
    const document = await this.load();
    return sortedNames(document.pushes).flatMap((name) => {
      const push = lookup(document.pushes, name);
      return push === undefined ? [] : [push];
    });
  }

  async getSavedPush(name: string): Promise<SavedPush | undefined> {
    return lookup((await this.load()).pushes, name);
  }

  async requireSavedPush(name: string): Promise<SavedPush> {
    const document = await this.load();
    const push = lookup(document.pushes, name);
    if (push === undefined)
      throw pushNotFound(name, sortedNames(document.pushes));
    return push;
  }

  /**
   * Upsert a push, keyed by its own `name`. The referenced hosting
   * profile is not required to exist: a saved push may outlive a profile that is
   * about to be recreated, exactly as in the Go dashboard.
   */
  async upsertSavedPush(push: SavedPush): Promise<SavedPush> {
    return this.withSavedPushLock(push.name, () =>
      this.upsertSavedPushWithLockHeld(push),
    );
  }

  /** Upsert without taking the push lock; the caller must hold it. */
  async upsertSavedPushWithLockHeld(push: SavedPush): Promise<SavedPush> {
    const key = validateSavedPushName(push.name);
    const validated = parseSavedPush(push, `pushes.${key}`, key);
    await this.mutate((document) => ({
      document: {
        ...document,
        pushes: withKey(document.pushes, key, validated),
      },
      result: undefined,
    }));
    return validated;
  }

  async removeSavedPush(name: string): Promise<SavedPush> {
    return this.withSavedPushLock(name, () =>
      this.removeSavedPushWithLockHeld(name),
    );
  }

  /** Remove without taking the push lock; the caller must hold it. */
  async removeSavedPushWithLockHeld(name: string): Promise<SavedPush> {
    const key = validateSavedPushName(name);
    return this.mutate((document) => {
      const existing = lookup(document.pushes, key);
      if (existing === undefined)
        throw pushNotFound(key, sortedNames(document.pushes));
      return {
        document: {
          ...document,
          pushes: withoutKey(document.pushes, key),
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
    await this.assertTrustedStorage();
    await atomicWriteFile(
      this.configFile,
      serializeConfigDocument(document),
      this.security,
    );
  }

  /**
   * Refuse configuration that another local principal could replace or edit.
   * Missing storage is safe because the atomic writer creates it owner-only.
   */
  private async assertTrustedStorage(): Promise<boolean> {
    const directory = dirname(this.configFile);
    const directoryExists = await this.verifyStoragePath(
      directory,
      "directory",
    );
    if (!directoryExists) return false;
    return this.verifyStoragePath(this.configFile, "file");
  }

  private async verifyStoragePath(
    path: string,
    kind: "directory" | "file",
  ): Promise<boolean> {
    let info;
    try {
      info = await lstat(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new CliError(
        "config_error",
        `Failed to inspect configuration storage at ${path}.`,
        { cause },
      );
    }

    const typeMatches =
      kind === "directory" ? info.isDirectory() : info.isFile();
    if (!typeMatches) {
      throw new CliError(
        "config_error",
        `Configuration storage at ${path} must be a regular ${kind}.`,
      );
    }

    let safe: boolean;
    try {
      safe =
        kind === "directory"
          ? await this.security.verifyDirectory(path)
          : await this.security.verifyFile(path);
    } catch (cause) {
      throw new CliError(
        "config_error",
        `Failed to verify configuration storage at ${path}.`,
        { cause },
      );
    }
    if (!safe) {
      throw new CliError(
        "config_error",
        `Configuration storage at ${path} has unsafe ownership or permissions.`,
      );
    }
    return true;
  }
}
