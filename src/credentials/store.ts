// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "../config/atomic-write.js";
import type { VerifiedFileSecurity } from "../config/file-security.js";
import type { ProviderKind } from "../config/schema.js";
import { CliError } from "../errors.js";
import {
  osCredentialBackend,
  type CommandExecutor,
  type CredentialBackend,
  type CredentialDiagnostic,
} from "./keychain-backends.js";

export const CREDENTIAL_RECORD_VERSION = 1;

/** The credential field a provider profile stores when it has only one secret. */
export const DEFAULT_CREDENTIAL_FIELD = "apiKey";

const CREDENTIAL_FILE_VERSION_DIR = "v1";
const CREDENTIAL_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Marker printed instead of a secret by every accidental stringification. */
export const SECRET_PLACEHOLDER = "[REDACTED]";

const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

export type SecretSource = "env" | "file" | "stored" | "stdin";

/**
 * An opaque carrier for a provider secret. `toString`, template interpolation,
 * `JSON.stringify` and `util.inspect` all yield {@link SECRET_PLACEHOLDER}; the
 * value is only obtainable through {@link SecretValue.reveal}.
 */
export class SecretValue {
  readonly source: SecretSource;
  /** Non-secret description of where the value came from, e.g. `env:KINSTA_API_KEY`. */
  readonly description: string;
  readonly length: number;
  #value: string;

  constructor(value: string, source: SecretSource, description: string) {
    this.#value = value;
    this.source = source;
    this.description = description;
    this.length = value.length;
    Object.freeze(this);
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return SECRET_PLACEHOLDER;
  }

  toJSON(): string {
    return SECRET_PLACEHOLDER;
  }

  [Symbol.toPrimitive](): string {
    return SECRET_PLACEHOLDER;
  }

  [INSPECT_CUSTOM](): string {
    return `SecretValue<${this.source}> ${SECRET_PLACEHOLDER}`;
  }
}

/**
 * Identifies the keychain record for one credential field of one hosting
 * profile. The account is derived from these three parts, so replacing or
 * deleting a profile deterministically replaces or deletes its secret.
 */
export interface CredentialTarget {
  /** Provider kind, e.g. `kinsta`. */
  readonly provider: ProviderKind;
  /** Hosting-profile name as it appears in `config.json`. */
  readonly profile: string;
  /** Credential field; defaults to {@link DEFAULT_CREDENTIAL_FIELD}. */
  readonly field?: string;
}

/** Opaque, deterministic credential identifier stored in `config.json`. */
export type CredentialId = string;

export function credentialId(target: CredentialTarget): CredentialId {
  return createHash("sha256")
    .update(target.provider)
    .update("\0")
    .update(target.profile)
    .update("\0")
    .update(target.field ?? DEFAULT_CREDENTIAL_FIELD)
    .digest("hex");
}

export function isCredentialId(value: string): boolean {
  return CREDENTIAL_ID_PATTERN.test(value);
}

function requireCredentialId(id: CredentialId): CredentialId {
  if (!isCredentialId(id)) {
    throw new CliError(
      "usage_error",
      "The credential identifier is not a valid credential ID.",
    );
  }
  return id;
}

interface CredentialRecord {
  readonly version: typeof CREDENTIAL_RECORD_VERSION;
  readonly secret: string;
}

function corruptCredential(cause?: unknown): CliError {
  return new CliError(
    "credential_invalid",
    "The stored credential record is corrupt; store the provider secret again.",
    { ...(cause === undefined ? {} : { cause }) },
  );
}

function validateCredentialRecord(value: unknown): CredentialRecord {
  if (value === null || typeof value !== "object") throw corruptCredential();
  const record = value as Partial<CredentialRecord>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["secret", "version"])) {
    throw corruptCredential();
  }
  if (
    record.version !== CREDENTIAL_RECORD_VERSION ||
    typeof record.secret !== "string" ||
    record.secret === ""
  ) {
    throw corruptCredential();
  }
  return record as CredentialRecord;
}

/**
 * What was observed at a credential id immediately before it was mutated.
 *
 * Three states on purpose. "The backend could not be read" must never collapse
 * into "nothing was there", because a rollback maps a positively observed
 * absence to a delete: conflating them turns a transient read failure (unsafe
 * fallback permissions, a locked keyring) into the silent destruction of the
 * operator's real secret.
 */
export type CredentialPriorState =
  | { readonly state: "absent" }
  /** The raw backend payload, kept verbatim so a rollback restores it byte for byte. */
  | { readonly state: "present"; readonly record: SecretValue }
  | { readonly state: "unknown"; readonly cause: unknown };

/**
 * The prior state of one credential, retained in memory so a failed config save
 * can restore it. The record itself stays wrapped in a {@link SecretValue}.
 */
export interface CredentialSnapshot {
  readonly id: CredentialId;
  readonly previous: CredentialPriorState;
}

export interface CredentialStore {
  /** Reads the secret, or `undefined` when no record exists. */
  read(id: CredentialId): Promise<SecretValue | undefined>;
  /** Reads the secret, failing with `credential_missing` when absent. */
  require(id: CredentialId): Promise<SecretValue>;
  /** Writes the secret and returns the state it replaced. */
  replace(id: CredentialId, secret: string): Promise<CredentialSnapshot>;
  /** Removes the secret and returns the state it replaced. */
  delete(id: CredentialId): Promise<CredentialSnapshot>;
  /** Restores a snapshot taken by {@link replace} or {@link delete}. */
  restore(snapshot: CredentialSnapshot): Promise<void>;
  diagnostic(): CredentialDiagnostic;
}

/**
 * Credential store over a single backend.
 *
 * The store never acquires a lock of its own: every mutating call must run
 * inside the caller's hosting-profile lock so that a config write and its
 * credential write form one critical section. Use
 * {@link withLockedCredentialTransaction} to get that for free.
 */
export class BackendCredentialStore implements CredentialStore {
  #warned = false;

  constructor(
    private readonly backend: CredentialBackend,
    private readonly onWarning?: (message: string) => void,
  ) {}

  async read(id: CredentialId): Promise<SecretValue | undefined> {
    this.warnOnce();
    const serialized = await this.backend.read(requireCredentialId(id));
    if (serialized === undefined) return undefined;
    return new SecretValue(
      this.deserialize(serialized).secret,
      "stored",
      `stored:${id}`,
    );
  }

  async require(id: CredentialId): Promise<SecretValue> {
    const secret = await this.read(id);
    if (secret === undefined) {
      throw new CliError(
        "credential_missing",
        "No stored provider secret was found for this profile.",
        { details: { storedId: id } },
      );
    }
    return secret;
  }

  async replace(id: CredentialId, secret: string): Promise<CredentialSnapshot> {
    this.warnOnce();
    if (secret === "") {
      throw new CliError(
        "usage_error",
        "The provider secret must not be empty.",
      );
    }
    const snapshot = await this.snapshot(id);
    await this.backend.replace(id, this.serialize(secret));
    return snapshot;
  }

  async delete(id: CredentialId): Promise<CredentialSnapshot> {
    this.warnOnce();
    const snapshot = await this.snapshot(id);
    await this.backend.delete(id);
    return snapshot;
  }

  async restore(snapshot: CredentialSnapshot): Promise<void> {
    const id = requireCredentialId(snapshot.id);
    const previous = snapshot.previous;
    switch (previous.state) {
      case "absent":
        // Only a positively observed absence may delete.
        await this.backend.delete(id);
        return;
      case "present":
        await this.backend.replace(id, previous.record.reveal());
        return;
      case "unknown":
        // The record is left exactly as the mutation left it: destroying a
        // record whose prior content was merely unreadable is never a
        // rollback. The caller surfaces this through `onRollbackFailure`.
        throw new CliError(
          "credential_invalid",
          "The prior provider secret could not be read before it was replaced, so it cannot be restored; the stored record was left untouched.",
          { details: { storedId: id }, cause: previous.cause },
        );
      default: {
        const exhaustive: never = previous;
        return exhaustive;
      }
    }
  }

  diagnostic(): CredentialDiagnostic {
    return this.backend.diagnostic();
  }

  private async snapshot(id: CredentialId): Promise<CredentialSnapshot> {
    requireCredentialId(id);
    // Snapshotting the raw backend payload rather than the parsed record keeps
    // a corrupt prior record restorable — it must not block the replacement,
    // and it must not be mistaken for an absent one either.
    try {
      const serialized = await this.backend.read(id);
      return {
        id,
        previous:
          serialized === undefined
            ? { state: "absent" }
            : {
                state: "present",
                record: new SecretValue(serialized, "stored", `stored:${id}`),
              },
      };
    } catch (cause) {
      return { id, previous: { state: "unknown", cause } };
    }
  }

  private serialize(secret: string): string {
    const record: CredentialRecord = {
      version: CREDENTIAL_RECORD_VERSION,
      secret,
    };
    return JSON.stringify(record);
  }

  private deserialize(serialized: string): CredentialRecord {
    try {
      return validateCredentialRecord(JSON.parse(serialized) as unknown);
    } catch (cause) {
      if (cause instanceof CliError) throw cause;
      throw corruptCredential(cause);
    }
  }

  private warnOnce(): void {
    if (this.#warned) return;
    this.#warned = true;
    const warning = this.backend.diagnostic().warning;
    if (warning !== undefined) this.onWarning?.(warning);
  }
}

/**
 * Explicit owner-only file backend for embedders and isolated tests. It is
 * never selected because an OS credential service failed. Unsafe permissions
 * are an error, never a downgrade.
 */
export class FileCredentialBackend implements CredentialBackend {
  constructor(
    private readonly credentialsDir: string,
    private readonly security: VerifiedFileSecurity,
  ) {}

  async read(account: string): Promise<string | undefined> {
    const directory = this.directory();
    const path = this.path(account);
    try {
      if (
        !(await this.security.verifyDirectory(directory)) ||
        !(await this.security.verifyFile(path))
      ) {
        throw new CliError(
          "credential_invalid",
          "Credential fallback permissions are unsafe; store the provider secret again.",
        );
      }
      // The trailing newline is this backend's own framing, not part of the
      // record: stripping it keeps `read` -> `replace` byte-exact, so a
      // rollback restores the payload rather than growing it.
      return (await readFile(path, "utf8")).replace(/\r?\n$/, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async replace(account: string, serialized: string): Promise<void> {
    const path = this.path(account);
    await atomicWriteFile(path, `${serialized}\n`, this.security);
    const directorySafe = await this.security.verifyDirectory(this.directory());
    const fileSafe = await this.security.verifyFile(path);
    if (!directorySafe || !fileSafe) {
      await unlink(path).catch(() => undefined);
      throw new CliError(
        "credential_invalid",
        "Credential fallback permissions could not be verified.",
      );
    }
  }

  async delete(account: string): Promise<void> {
    await unlink(this.path(account)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  diagnostic(): CredentialDiagnostic {
    return {
      backend: "file",
      osBackedEncryption: false,
      warning:
        "Provider secrets use an owner-only file fallback and are not encrypted by an OS credential service.",
    };
  }

  private directory(): string {
    return join(this.credentialsDir, CREDENTIAL_FILE_VERSION_DIR);
  }

  private path(account: string): string {
    return join(this.directory(), `${requireCredentialId(account)}.json`);
  }
}

export interface CredentialStoreOptions {
  readonly platform?: NodeJS.Platform;
  /** `file` forces the owner-only file fallback and skips OS probing. */
  readonly preference?: "auto" | "file";
  readonly executor?: CommandExecutor;
  readonly onWarning?: (message: string) => void;
}

export async function createCredentialStore(
  credentialsDir: string,
  security: VerifiedFileSecurity,
  options: CredentialStoreOptions = {},
): Promise<CredentialStore> {
  if (options.preference !== "file") {
    const platform = options.platform ?? process.platform;
    const backend =
      options.executor === undefined
        ? osCredentialBackend(platform)
        : osCredentialBackend(platform, options.executor);
    // A missing helper/keyring is an installation error, never consent to
    // plaintext storage. Probe is non-interactive and does not read secrets.
    if (!(await backend.probe())) {
      throw new CliError(
        "integration_unavailable",
        platform === "darwin"
          ? "The Novamira HQ Keychain helper is unavailable. Reinstall HQ or build the development helper. No file fallback was used."
          : "The OS credential service is unavailable. Install or enable it before saving hosting credentials. No file fallback was used.",
      );
    }
    return new BackendCredentialStore(backend, options.onWarning);
  }
  return new BackendCredentialStore(
    new FileCredentialBackend(credentialsDir, security),
    options.onWarning,
  );
}

export interface RollbackFailure {
  readonly id: CredentialId;
  readonly error: unknown;
}

export interface RollbackResult {
  readonly restored: number;
  readonly failures: readonly RollbackFailure[];
}

/**
 * Groups credential mutations so a later failure — typically the config save —
 * can put every touched record back the way it was.
 */
export interface CredentialTransaction {
  replace(id: CredentialId, secret: string): Promise<void>;
  delete(id: CredentialId): Promise<void>;
  /** Undoes every mutation, newest first. Never throws. */
  rollback(): Promise<RollbackResult>;
  /** Drops the retained prior secrets; the mutations become permanent. */
  commit(): void;
}

class StoreCredentialTransaction implements CredentialTransaction {
  #snapshots: CredentialSnapshot[] = [];

  constructor(private readonly store: CredentialStore) {}

  async replace(id: CredentialId, secret: string): Promise<void> {
    this.#snapshots.push(await this.store.replace(id, secret));
  }

  async delete(id: CredentialId): Promise<void> {
    this.#snapshots.push(await this.store.delete(id));
  }

  async rollback(): Promise<RollbackResult> {
    const snapshots = this.#snapshots;
    this.#snapshots = [];
    const failures: RollbackFailure[] = [];
    let restored = 0;
    for (const snapshot of [...snapshots].reverse()) {
      try {
        await this.store.restore(snapshot);
        restored += 1;
      } catch (error) {
        failures.push({ id: snapshot.id, error });
      }
    }
    return { restored, failures };
  }

  commit(): void {
    this.#snapshots = [];
  }
}

export function beginCredentialTransaction(
  store: CredentialStore,
): CredentialTransaction {
  return new StoreCredentialTransaction(store);
}

export interface CredentialTransactionOptions {
  /** Reports records that could not be restored after a rollback. */
  readonly onRollbackFailure?: (result: RollbackResult) => void;
}

/**
 * Runs `operation` against a transaction, rolling every credential mutation
 * back when it throws. The original error is always the one propagated.
 */
export async function withCredentialTransaction<T>(
  store: CredentialStore,
  operation: (transaction: CredentialTransaction) => Promise<T>,
  options: CredentialTransactionOptions = {},
): Promise<T> {
  const transaction = beginCredentialTransaction(store);
  let result: T;
  try {
    result = await operation(transaction);
  } catch (error) {
    const rollback = await transaction.rollback();
    if (rollback.failures.length > 0) options.onRollbackFailure?.(rollback);
    throw error;
  }
  transaction.commit();
  return result;
}

/**
 * The slice of `ConfigStore` this module needs. Deliberately *not* the raw
 * `ProfileLockManager`: that would key the lock on the bare profile name while
 * `ConfigStore` keys it on `hosting-profile:<name>`, giving two different lock
 * files and leaving the credential write and the config write in separate
 * critical sections. Going through `ConfigStore` also inherits its in-process
 * queue, so overlapping dashboard requests wait instead of failing.
 */
export interface HostingProfileLock {
  withHostingProfileLock<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Takes the hosting-profile lock, then runs a credential transaction inside it.
 * `operation` should perform the config save as well — through the
 * `*WithProfileLockHeld` mutators, since the lock is already held — so a failed
 * save rolls the credential write back before the lock is released.
 */
export async function withLockedCredentialTransaction<T>(
  lock: HostingProfileLock,
  profileName: string,
  store: CredentialStore,
  operation: (transaction: CredentialTransaction) => Promise<T>,
  options: CredentialTransactionOptions = {},
): Promise<T> {
  return lock.withHostingProfileLock(profileName, async () =>
    withCredentialTransaction(store, operation, options),
  );
}
