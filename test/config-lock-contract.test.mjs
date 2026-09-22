// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UnixFileSecurity } from "../dist/config/file-security.js";
import {
  lockDirectory,
  lockFilePath,
  ProfileLockManager,
} from "../dist/config/lock.js";

async function isolatedLocks() {
  const stateDir = await mkdtemp(join(tmpdir(), "novamira-hq-lock-"));
  const security = new UnixFileSecurity();
  await mkdir(lockDirectory(stateDir), { recursive: true, mode: 0o700 });
  return { stateDir, security };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("independent managers serialize recovery of the same stale lock", async () => {
  const state = await isolatedLocks();
  const key = "shared-profile";
  const path = lockFilePath(state.stateDir, key);
  try {
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, host: "another-host" }),
      { mode: 0o600 },
    );
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);

    const inspected = deferred();
    const permitRecovery = deferred();
    let inspectionCount = 0;
    const hooks = {
      beforeRecoveryClaim: async () => {
        inspectionCount += 1;
        if (inspectionCount === 2) inspected.resolve();
        await permitRecovery.promise;
      },
    };
    const first = new ProfileLockManager(state.stateDir, state.security, hooks);
    const second = new ProfileLockManager(
      state.stateDir,
      state.security,
      hooks,
    );
    const entered = deferred();
    const releaseFirst = deferred();
    const order = [];
    let active = 0;

    const operation = async (name) => {
      active += 1;
      assert.equal(active, 1);
      order.push(`${name}:start`);
      if (order.length === 1) {
        entered.resolve();
        await releaseFirst.promise;
      }
      order.push(`${name}:end`);
      active -= 1;
    };

    const attempts = [
      first.withLock(key, () => operation("first"), {
        staleMs: 100,
        pollMs: 1,
      }),
      second.withLock(key, () => operation("second"), {
        staleMs: 100,
        pollMs: 1,
      }),
    ];
    await inspected.promise;
    assert.equal(inspectionCount, 2);
    permitRecovery.resolve();
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(order.filter((event) => event.endsWith(":start")).length, 1);
    releaseFirst.resolve();
    await Promise.all(attempts);
    assert.equal(order.filter((event) => event.endsWith(":start")).length, 2);
  } finally {
    await rm(state.stateDir, { recursive: true, force: true });
  }
});

test("an old malformed lock is recoverable but a fresh one is not", async () => {
  const state = await isolatedLocks();
  const key = "malformed-profile";
  const path = lockFilePath(state.stateDir, key);
  try {
    await writeFile(path, '{"pid":', { mode: 0o600 });
    const manager = new ProfileLockManager(state.stateDir, state.security);
    await assert.rejects(
      manager.acquire(key, { staleMs: 10_000, timeoutMs: 10, pollMs: 1 }),
      { code: "internal_error", message: /Timed out waiting/ },
    );

    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);
    const release = await manager.acquire(key, {
      staleMs: 100,
      timeoutMs: 1_000,
      pollMs: 1,
    });
    await release();
  } finally {
    await rm(state.stateDir, { recursive: true, force: true });
  }
});

test("stale malformed lock metadata is recovered by age", async () => {
  const state = await isolatedLocks();
  const key = "malformed-metadata-profile";
  const path = lockFilePath(state.stateDir, key);
  try {
    await writeFile(path, JSON.stringify({ pid: 0, host: hostname() }), {
      mode: 0o600,
    });
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);

    const manager = new ProfileLockManager(state.stateDir, state.security);
    const release = await manager.acquire(key, {
      staleMs: 100,
      timeoutMs: 1_000,
      pollMs: 1,
    });
    await release();

    await writeFile(path, "null", { mode: 0o600 });
    await utimes(path, old, old);
    const releaseNull = await manager.acquire(key, {
      staleMs: 100,
      timeoutMs: 1_000,
      pollMs: 1,
    });
    await releaseNull();
  } finally {
    await rm(state.stateDir, { recursive: true, force: true });
  }
});

test("an acquirer verifies ownership again before entering", async () => {
  const state = await isolatedLocks();
  const key = "creation-race-profile";
  const path = lockFilePath(state.stateDir, key);
  try {
    const replacement = new ProfileLockManager(state.stateDir, state.security);
    const replaced = deferred();
    let releaseReplacement;
    let intercept = true;
    const delayedSecurity = {
      secureDirectory: (target) => state.security.secureDirectory(target),
      secureFile: async (target) => {
        await state.security.secureFile(target);
        if (!intercept || target !== path) return;
        intercept = false;
        await unlink(path);
        releaseReplacement = await replacement.acquire(key);
        replaced.resolve();
      },
    };
    const original = new ProfileLockManager(state.stateDir, delayedSecurity);
    let acquired = false;
    const pending = original
      .acquire(key, { timeoutMs: 1_000, pollMs: 1 })
      .then((release) => {
        acquired = true;
        return release;
      });

    await replaced.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(acquired, false);
    await releaseReplacement();
    const releaseOriginal = await pending;
    await releaseOriginal();
  } finally {
    await rm(state.stateDir, { recursive: true, force: true });
  }
});

test("a former owner cannot release a replacement lock", async () => {
  const state = await isolatedLocks();
  const key = "replacement-profile";
  const path = lockFilePath(state.stateDir, key);
  try {
    const first = new ProfileLockManager(state.stateDir, state.security);
    const second = new ProfileLockManager(state.stateDir, state.security);
    const observer = new ProfileLockManager(state.stateDir, state.security);
    const releaseFirst = await first.acquire(key);

    await unlink(path);
    const releaseSecond = await second.acquire(key);
    await releaseFirst();

    await assert.rejects(observer.acquire(key, { timeoutMs: 10, pollMs: 1 }), {
      code: "internal_error",
      message: /Timed out waiting/,
    });
    await releaseSecond();
    const releaseObserver = await observer.acquire(key);
    await releaseObserver();
  } finally {
    await rm(state.stateDir, { recursive: true, force: true });
  }
});
