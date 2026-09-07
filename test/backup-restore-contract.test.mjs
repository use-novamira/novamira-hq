// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  backupCatalogContains,
  executeBackupRestore,
  prepareBackupRestore,
} from "../dist/hosting/backup-restore.js";

function client({
  provider = "kinsta",
  capabilities,
  catalog,
  operationStatus,
  action,
} = {}) {
  const calls = [];
  return {
    calls,
    provider,
    async read(request) {
      calls.push(request);
      if (request.kind === "capabilities")
        return (
          capabilities ?? [
            { name: "backups.list", supported: true },
            { name: "backups.create", supported: true },
            { name: "backups.restore", supported: true },
          ]
        );
      return catalog ?? { backups: [{ id: 42 }] };
    },
    async action(request) {
      calls.push(request);
      return (
        action?.(request) ?? {
          provider,
          action: request.kind,
          status: 200,
          raw: null,
        }
      );
    },
    async operationStatus(operationId) {
      calls.push({ operationStatus: operationId });
      return (
        operationStatus?.(operationId) ?? {
          provider,
          operationId,
          status: 200,
          done: true,
          failed: false,
          raw: null,
        }
      );
    },
  };
}

const SELECTION = {
  targetEnvironmentId: "target",
  backupId: "42",
  allContent: true,
  notifiedUserId: "user-7",
};

test("backup catalogs match ids only inside known collection shapes", () => {
  for (const catalog of [
    [{ id: 42 }],
    { backups: [{ backup_id: "42" }] },
    { environment: { data: [{ uuid: "42" }] } },
    { success: true, result: [{ backupId: "42" }] },
    { results: [{ id: "42" }] },
  ])
    assert.equal(backupCatalogContains(catalog, "42"), true);

  assert.equal(backupCatalogContains({ id: "42", backups: [] }, "42"), false);
  assert.equal(backupCatalogContains({ backups: [{ id: "43" }] }, "42"), false);
});

test("restore planning validates destructive acknowledgement before provider reads", async () => {
  const provider = client();
  await assert.rejects(
    prepareBackupRestore(provider, { ...SELECTION, allContent: false }),
    { code: "usage_error" },
  );
  await assert.rejects(
    prepareBackupRestore(provider, { ...SELECTION, notifiedUserId: undefined }),
    { code: "usage_error" },
  );
  assert.deepEqual(provider.calls, []);
});

test("restore planning requires list, create, and restore capabilities", async () => {
  for (const missing of ["backups.list", "backups.create", "backups.restore"]) {
    const provider = client({
      provider: "wpengine",
      capabilities: [
        { name: "backups.list", supported: missing !== "backups.list" },
        { name: "backups.create", supported: missing !== "backups.create" },
        { name: "backups.restore", supported: missing !== "backups.restore" },
      ],
    });
    await assert.rejects(
      prepareBackupRestore(provider, {
        ...SELECTION,
        notifiedUserId: undefined,
      }),
      (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.equal(error.details.capability, missing);
        return true;
      },
    );
    assert.deepEqual(provider.calls, [{ kind: "capabilities" }]);
  }
});

test("restore planning refuses an id absent from the target catalog", async () => {
  const provider = client({
    provider: "wpengine",
    catalog: { results: [{ id: "another-backup" }] },
  });
  await assert.rejects(
    prepareBackupRestore(provider, {
      ...SELECTION,
      notifiedUserId: undefined,
    }),
    { code: "not_found" },
  );
  assert.deepEqual(provider.calls, [
    { kind: "capabilities" },
    { kind: "backups", envId: "target" },
  ]);
});

test("a failed pre-restore safety backup prevents the restore", async () => {
  const provider = client({
    action: () => ({
      provider: "kinsta",
      action: "backups.create",
      status: 202,
      operationId: "safety-operation",
      raw: null,
    }),
    operationStatus: (operationId) => ({
      provider: "kinsta",
      operationId,
      status: 500,
      done: true,
      failed: true,
      message: "backup failed",
      raw: null,
    }),
  });
  const plan = await prepareBackupRestore(provider, SELECTION);
  provider.calls.length = 0;
  await assert.rejects(
    executeBackupRestore(provider, plan, {
      intervalSeconds: 1,
      timeoutSeconds: 10,
      now: () => 0,
      sleep: async () => undefined,
    }),
    { code: "provider_error" },
  );
  assert.deepEqual(provider.calls, [
    {
      kind: "create-backup",
      envId: "target",
      body: { tag: "novamira-hq pre-restore safety backup" },
    },
    { operationStatus: "safety-operation" },
  ]);
});

test("successful restore always creates a safety backup first", async () => {
  const provider = client();
  const plan = await prepareBackupRestore(provider, SELECTION);
  provider.calls.length = 0;
  await executeBackupRestore(provider, plan);
  assert.deepEqual(provider.calls, [
    {
      kind: "create-backup",
      envId: "target",
      body: { tag: "novamira-hq pre-restore safety backup" },
    },
    {
      kind: "restore-backup",
      targetEnvId: "target",
      body: { backup_id: 42, notified_user_id: "user-7" },
    },
  ]);
});

test("non-Kinsta restore ids remain opaque strings", async () => {
  const provider = client({
    provider: "wpengine",
    catalog: { results: [{ id: "backup-uuid" }] },
  });
  const plan = await prepareBackupRestore(provider, {
    targetEnvironmentId: "install-1",
    backupId: "backup-uuid",
    allContent: true,
  });
  provider.calls.length = 0;
  await executeBackupRestore(provider, plan);
  assert.deepEqual(provider.calls[1], {
    kind: "restore-backup",
    targetEnvId: "install-1",
    body: { backup_id: "backup-uuid" },
  });
});
