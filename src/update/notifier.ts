// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The cached update check, the 24-hour background notice, and the record they
 * share.
 *
 * **What the Go did.** Nothing like this existed. `internal/update` had a
 * `Check` that hit GitHub on every call and no cache at all, so the only reason
 * a Go invocation did not make a network request per command was that nothing
 * ever called it in the background. HQ mirrors `@novamira/cli`'s
 * `src/update/notifier.ts` instead, so both tools cache identically and both
 * can be reasoned about with one sentence: *at most one registry request per
 * 24 hours per registry, whatever else happens.*
 *
 * **Where the record lives, and where it does not.** `<stateDir>/update-check.json`,
 * with `stateDir` resolved by `src/config/paths.ts` from HQ's own namespace —
 * `NOVAMIRA_HQ_HOME`, `novamira-hq` under the XDG roots, `Novamira HQ` on macOS
 * and Windows. **`NOVAMIRA_HOME` is never read**, here or anywhere in HQ, and no
 * segment of the path is joined by hand: this module is handed a `stateDir` and
 * appends one file name to it.
 *
 * **The lock is held across the request, not only across the write.** Go's
 * absent cache aside, the obvious implementation — check freshness, release,
 * fetch, re-acquire, write — lets two HQ invocations that start together both
 * miss the cache and both make a request. Holding `__update_check__` for the
 * whole operation makes the second one wait, re-read the record the first just
 * wrote, and find it fresh. That is why the lock manager appears in this file at
 * all, and it is also why `CommandDependencies` grew a `locks` field in 7-2.
 *
 * **Every failure is silent, by design.** {@link UpdateChecker.notice} swallows
 * its own errors and returns `undefined`; a failed check still writes a record
 * with `latest: null` so an unreachable registry is not retried on every
 * invocation for the next 24 hours. An update check must never change a
 * command's outcome, its exit code, or its stdout. Only {@link UpdateChecker.check}
 * — the *explicit* `novamira-hq update` path and the dashboard's Check now
 * button — propagates failures, because there the operator asked.
 *
 * **A record from a different registry is never reused.** {@link normalizeRegistry}
 * reduces a registry URL to origin + path, and a mismatch is treated as no
 * record at all: pointing `NOVAMIRA_HQ_REGISTRY` at a mirror must not inherit
 * the public registry's answer, and vice versa.
 *
 * **A record whose permissions do not verify is deleted, not read.** It lives in
 * the same owner-only tree as the credential fallback; a world-writable
 * `update-check.json` could name any `latest` it liked, and `latest` is what the
 * install specifier is built from.
 *
 * **Opt-out and override are HQ's own variables.** `NOVAMIRA_HQ_UPDATE_CHECK=0`
 * (or `false`) disables the background notice; `NOVAMIRA_HQ_REGISTRY` picks a
 * registry. HQ never reads `NOVAMIRA_UPDATE_CHECK` or `NOVAMIRA_REGISTRY` —
 * those belong to the site CLI, and one tool silently obeying the other's
 * configuration is exactly the namespace collision `CLAUDE.md` forbids.
 */

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "../config/atomic-write.js";
import type { VerifiedFileSecurity } from "../config/file-security.js";
import type { ProfileLockManager } from "../config/lock.js";
import { compareSemverStrings, isSemver } from "../semver.js";
import {
  DEFAULT_REGISTRY,
  fetchLatestVersion,
  type RegistryOptions,
} from "./registry.js";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 3_000;
/** The `ProfileLockManager` key. Double-underscored so no profile name can be it. */
export const UPDATE_CHECK_LOCK = "__update_check__";
/** The file name appended to `paths.stateDir`; the only path segment here. */
export const UPDATE_CHECK_FILE = "update-check.json";
const RECORD_VERSION = 1;

export interface UpdateCheckEnvironment {
  readonly NOVAMIRA_HQ_UPDATE_CHECK?: string;
  readonly NOVAMIRA_HQ_REGISTRY?: string;
}

export interface UpdateStatus {
  readonly current: string;
  readonly latest: string;
  readonly updateAvailable: boolean;
  readonly checkedAt: string;
}

/** The frozen on-disk shape. `latest: null` records a check that failed. */
export interface UpdateRecord {
  readonly version: 1;
  /** The registry the record came from; a different one is never reused. */
  readonly registry: string;
  readonly latest: string | null;
  readonly checkedAt: string;
}

export interface UpdateCheckerOptions extends RegistryOptions {
  readonly currentVersion: string;
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export class UpdateChecker {
  private readonly path: string;
  private readonly currentVersion: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly registryOptions: RegistryOptions;
  private readonly registry: string;

  constructor(
    stateDir: string,
    private readonly locks: ProfileLockManager,
    private readonly security: VerifiedFileSecurity,
    options: UpdateCheckerOptions,
  ) {
    this.path = join(stateDir, UPDATE_CHECK_FILE);
    this.currentVersion = options.currentVersion;
    this.intervalMs = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.registry = normalizeRegistry(options.registry ?? DEFAULT_REGISTRY);
    this.registryOptions = {
      timeoutMs: options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.registry === undefined ? {} : { registry: options.registry }),
      ...(options.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: options.allowInsecureHttp }),
    };
  }

  /** The registry the records are keyed by; the update card renders it. */
  get registryIdentity(): string {
    return this.registry;
  }

  /** Where the record lives. Exported for the doctor's evidence and the tests. */
  get recordPath(): string {
    return this.path;
  }

  /** Contact the registry and record the result. Failures propagate. */
  async check(): Promise<UpdateStatus> {
    const latest = await fetchLatestVersion(this.registryOptions);
    const checkedAt = new Date(this.now()).toISOString();
    await this.locks.withLock(UPDATE_CHECK_LOCK, () =>
      this.write({
        version: RECORD_VERSION,
        registry: this.registry,
        latest,
        checkedAt,
      }),
    );
    return this.status(latest, checkedAt);
  }

  /**
   * A status without forcing a request when the cached record is still fresh.
   * `undefined` only when the registry could not be consulted.
   */
  async refresh(): Promise<UpdateStatus | undefined> {
    const cached = await this.read();
    if (this.isFresh(cached)) return this.fromRecord(cached);
    // The lock spans the request as well as the write, so two commands starting
    // at once still make at most one request per interval.
    return this.locks.withLock(UPDATE_CHECK_LOCK, async () => {
      const current = await this.read();
      if (this.isFresh(current)) return this.fromRecord(current);
      const checkedAt = new Date(this.now()).toISOString();
      let latest: string | null = null;
      try {
        latest = await fetchLatestVersion(this.registryOptions);
      } catch {
        // Record the attempt so an unreachable registry is not retried on every
        // invocation, then stay silent.
      }
      await this.write({
        version: RECORD_VERSION,
        registry: this.registry,
        latest,
        checkedAt,
      }).catch(() => undefined);
      return latest === null ? undefined : this.status(latest, checkedAt);
    });
  }

  /** The message shown when a newer release exists, otherwise `undefined`. */
  async notice(): Promise<string | undefined> {
    let status: UpdateStatus | undefined;
    try {
      status = await this.refresh();
    } catch {
      return undefined;
    }
    if (status?.updateAvailable !== true) return undefined;
    return updateNotice(status);
  }

  private isFresh(record: UpdateRecord | undefined): record is UpdateRecord {
    return (
      record?.registry === this.registry &&
      this.now() - Date.parse(record.checkedAt) < this.intervalMs
    );
  }

  private fromRecord(record: UpdateRecord): UpdateStatus | undefined {
    return record.latest === null
      ? undefined
      : this.status(record.latest, record.checkedAt);
  }

  private status(latest: string, checkedAt: string): UpdateStatus {
    return {
      current: this.currentVersion,
      latest,
      updateAvailable: isNewer(latest, this.currentVersion),
      checkedAt,
    };
  }

  private async read(): Promise<UpdateRecord | undefined> {
    try {
      const raw = await readFile(this.path, "utf8");
      if (!(await this.security.verifyFile(this.path))) {
        throw new Error("unsafe update-check permissions");
      }
      const value = JSON.parse(raw) as unknown;
      if (value === null || typeof value !== "object") {
        throw new Error("invalid update-check record");
      }
      const record = value as Partial<UpdateRecord>;
      if (
        record.version !== RECORD_VERSION ||
        typeof record.registry !== "string" ||
        typeof record.checkedAt !== "string" ||
        !Number.isFinite(Date.parse(record.checkedAt)) ||
        !(record.latest === null || isSemver(record.latest))
      ) {
        throw new Error("invalid update-check record");
      }
      return record as UpdateRecord;
    } catch (error) {
      // Anything but "absent" means the record is unusable: delete it rather
      // than read it again next time. A world-readable record could name any
      // `latest` it liked, and `latest` becomes an install specifier.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await unlink(this.path).catch(() => undefined);
      }
      return undefined;
    }
  }

  /** Callers hold the update-check lock. */
  private async write(record: UpdateRecord): Promise<void> {
    await atomicWriteFile(
      this.path,
      `${JSON.stringify(record)}\n`,
      this.security,
    );
  }
}

/** Registry identity for the cached record; only the origin and path matter. */
export function normalizeRegistry(registry: string): string {
  try {
    const url = new URL(registry);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return registry;
  }
}

export function isNewer(candidate: string, current: string): boolean {
  try {
    return compareSemverStrings(candidate, current) > 0;
  } catch {
    return false;
  }
}

export function updateNotice(status: UpdateStatus): string {
  return `A new novamira-hq release is available: ${status.current} -> ${status.latest}. Run "novamira-hq update" to install it.`;
}

/** The automatic notice is opt-out through `NOVAMIRA_HQ_UPDATE_CHECK=0`. */
export function updateCheckEnabled(
  environment: UpdateCheckEnvironment,
): boolean {
  const value = environment.NOVAMIRA_HQ_UPDATE_CHECK;
  return value !== "0" && value !== "false";
}
