// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { CliError } from "../errors.js";
import type { FileSecurity } from "./file-security.js";
import { secureDirectory } from "./file-security.js";

export interface LockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly pollMs?: number;
}

export interface LockManagerHooks {
  readonly beforeRecoveryClaim?: () => Promise<void>;
}

/**
 * Lock key that serialises whole-config reads and writes (as opposed to the
 * per-hosting-profile keys). `platformPaths().lockFile` resolves to the file
 * this key produces.
 */
export const CONFIG_LOCK_KEY = "config";

/** Name of the lock directory below a state directory. */
export const LOCK_DIRECTORY_NAME = "locks";

/**
 * Lock file name for a key. The name is a digest so that arbitrary keys —
 * including profile names with separators or characters the platform rejects —
 * always map to one safe, deterministic file name.
 */
export function lockFileName(key: string): string {
  return `${createHash("sha256").update(key).digest("hex")}.lock`;
}

/** Directory holding every lock file below a state directory. */
export function lockDirectory(stateDir: string): string {
  return join(stateDir, LOCK_DIRECTORY_NAME);
}

/** Lock file a key resolves to below a state directory. */
export function lockFilePath(stateDir: string, key: string): string {
  return join(lockDirectory(stateDir), lockFileName(key));
}

interface LockIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface LockInspection {
  readonly identity: LockIdentity;
  readonly recoverable: boolean;
}

interface RecoveryClaim {
  readonly pid: number;
  readonly host: string;
  readonly owner: string;
}

function sameIdentity(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export class ProfileLockManager {
  private readonly heldKeys = new Set<string>();

  constructor(
    private readonly stateDir: string,
    private readonly security: FileSecurity,
    private readonly hooks: LockManagerHooks = {},
  ) {}

  async withLock<T>(
    profileName: string,
    operation: () => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    const release = await this.acquire(profileName, options);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async acquire(
    profileName: string,
    options: LockOptions = {},
  ): Promise<() => Promise<void>> {
    if (this.heldKeys.has(profileName)) {
      throw new CliError(
        "internal_error",
        `Profile lock ${profileName} is already held by this lock manager.`,
      );
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    const staleMs = options.staleMs ?? 60_000;
    const pollMs = options.pollMs ?? 25;
    const lockDir = lockDirectory(this.stateDir);
    await secureDirectory(lockDir, this.security);
    const lockPath = lockFilePath(this.stateDir, profileName);
    const started = Date.now();
    const owner = randomUUID();

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- acquisition retries until success or timeout
    while (true) {
      if (await this.recoveryInProgress(lockDir, lockPath, staleMs)) {
        await this.waitToRetry(profileName, started, timeoutMs, pollMs);
        continue;
      }

      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (handle !== undefined) {
        try {
          try {
            await handle.writeFile(
              JSON.stringify({
                pid: process.pid,
                host: hostname(),
                createdAt: Date.now(),
                owner,
              }),
            );
            await handle.sync();
          } finally {
            await handle.close();
          }
          await this.security.secureFile(lockPath);
          if (
            !(await this.isOwned(lockPath, owner)) ||
            (await this.recoveryInProgress(lockDir, lockPath, staleMs))
          ) {
            await this.releaseOwned(lockPath, owner);
            await this.waitToRetry(profileName, started, timeoutMs, pollMs);
            continue;
          }
        } catch (error) {
          await this.releaseOwned(lockPath, owner);
          throw error;
        }
        this.heldKeys.add(profileName);
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try {
            await this.releaseOwned(lockPath, owner);
          } finally {
            this.heldKeys.delete(profileName);
          }
        };
      }

      const inspection = await this.inspect(lockPath, staleMs);
      if (
        inspection?.recoverable === true &&
        (await this.recover(lockPath, inspection, staleMs))
      )
        continue;
      await this.waitToRetry(profileName, started, timeoutMs, pollMs);
    }
  }

  private async inspect(
    lockPath: string,
    staleMs: number,
  ): Promise<LockInspection | undefined> {
    try {
      const info = await stat(lockPath);
      const expired = Date.now() - info.mtimeMs >= staleMs;
      const identity = { dev: info.dev, ino: info.ino };
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        if (error instanceof SyntaxError)
          return { identity, recoverable: expired };
        throw error;
      }
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("host" in raw) ||
        !("pid" in raw) ||
        raw.host !== hostname() ||
        typeof raw.pid !== "number" ||
        !Number.isSafeInteger(raw.pid) ||
        raw.pid <= 0
      )
        return { identity, recoverable: expired };
      try {
        process.kill(raw.pid, 0);
        return { identity, recoverable: false };
      } catch (error) {
        return {
          identity,
          recoverable: (error as NodeJS.ErrnoException).code === "ESRCH",
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async recover(
    lockPath: string,
    inspection: LockInspection,
    staleMs: number,
  ): Promise<boolean> {
    await this.hooks.beforeRecoveryClaim?.();
    const identityKey = `${String(inspection.identity.dev)}:${String(inspection.identity.ino)}`;
    const claimPath = `${lockPath}.${createHash("sha256").update(identityKey).digest("hex").slice(0, 16)}.recovery`;
    const claimOwner = randomUUID();
    const temporaryPath = `${claimPath}.${claimOwner}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          owner: claimOwner,
        } satisfies RecoveryClaim),
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.security.secureFile(temporaryPath);
      await link(temporaryPath, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }

    try {
      const claimed = await this.inspect(lockPath, staleMs);
      if (
        claimed === undefined ||
        !sameIdentity(claimed.identity, inspection.identity) ||
        !claimed.recoverable
      )
        return false;

      const current = await stat(lockPath).catch(() => undefined);
      if (current === undefined || !sameIdentity(current, inspection.identity))
        return false;
      if (!(await this.isOwned(claimPath, claimOwner))) return false;

      await unlink(lockPath);
      return true;
    } finally {
      await this.releaseOwned(claimPath, claimOwner);
    }
  }

  private async recoveryInProgress(
    lockDir: string,
    lockPath: string,
    staleMs: number,
  ): Promise<boolean> {
    const prefix = `${basename(lockPath)}.`;
    const names = await readdir(lockDir);
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".recovery")) continue;
      const claimPath = join(lockDir, name);
      const info = await stat(claimPath).catch(() => undefined);
      if (info === undefined) continue;
      const claim = await this.readRecoveryClaim(claimPath);
      if (claim?.host === hostname()) {
        try {
          process.kill(claim.pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
        }
      } else if (Date.now() - info.mtimeMs < staleMs) {
        return true;
      }
      if (claim === undefined) await unlink(claimPath).catch(() => undefined);
      else await this.releaseOwned(claimPath, claim.owner);
    }
    return false;
  }

  private async readRecoveryClaim(
    path: string,
  ): Promise<RecoveryClaim | undefined> {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (typeof value !== "object" || value === null) return undefined;
      if (!("pid" in value) || !("host" in value) || !("owner" in value))
        return undefined;
      if (
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        typeof value.host !== "string" ||
        typeof value.owner !== "string"
      )
        return undefined;
      return { pid: value.pid, host: value.host, owner: value.owner };
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return undefined;
      throw error;
    }
  }

  private async waitToRetry(
    profileName: string,
    started: number,
    timeoutMs: number,
    pollMs: number,
  ): Promise<void> {
    if (Date.now() - started >= timeoutMs) {
      throw new CliError(
        "internal_error",
        `Timed out waiting for profile lock ${profileName}.`,
        { retryable: true },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  private async releaseOwned(lockPath: string, owner: string): Promise<void> {
    if (!(await this.isOwned(lockPath, owner))) return;
    await unlink(lockPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  private async isOwned(lockPath: string, owner: string): Promise<boolean> {
    try {
      const raw = JSON.parse(await readFile(lockPath, "utf8")) as {
        owner?: unknown;
      };
      return raw.owner === owner;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return false;
      throw error;
    }
  }
}
