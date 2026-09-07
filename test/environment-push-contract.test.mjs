// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeEnvironmentPush,
  prepareEnvironmentPush,
} from "../dist/hosting/environment-push.js";

const SOURCE = {
  id: "source",
  name: "source",
  displayName: "Source",
  isBlocked: false,
  isPremium: false,
};
const TARGET = {
  id: "target",
  name: "target",
  displayName: "Target",
  isBlocked: false,
  isPremium: false,
};

function client({ capabilities, operationStatus, action } = {}) {
  const calls = [];
  return {
    calls,
    provider: "kinsta",
    async read(request) {
      calls.push(request);
      return (
        capabilities ?? [
          { name: "envs.push", supported: true },
          { name: "backups.create", supported: true },
        ]
      );
    },
    async listEnvironments(siteId) {
      calls.push({ listEnvironments: siteId });
      return [SOURCE, TARGET];
    },
    async action(request) {
      calls.push(request);
      return (
        action?.(request) ?? {
          provider: "kinsta",
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
          provider: "kinsta",
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
  siteId: "site-1",
  sourceEnvironmentId: "source",
  targetEnvironmentId: "target",
  database: true,
  allFiles: false,
  files: [],
  searchReplace: false,
};

test("push planning validates scope before reading provider state", async () => {
  const provider = client();
  await assert.rejects(
    prepareEnvironmentPush(provider, { ...SELECTION, database: false }),
    { code: "usage_error" },
  );
  await assert.rejects(
    prepareEnvironmentPush(provider, {
      ...SELECTION,
      allFiles: true,
      files: ["wp-content/uploads"],
    }),
    { code: "usage_error" },
  );
  await assert.rejects(
    prepareEnvironmentPush(provider, {
      ...SELECTION,
      targetEnvironmentId: "source",
    }),
    { code: "usage_error" },
  );
  assert.deepEqual(provider.calls, []);
});

test("push planning requires both push and backup capabilities", async () => {
  for (const missing of ["envs.push", "backups.create"]) {
    const provider = client({
      capabilities: [
        { name: "envs.push", supported: missing !== "envs.push" },
        { name: "backups.create", supported: missing !== "backups.create" },
      ],
    });
    await assert.rejects(
      prepareEnvironmentPush(provider, SELECTION),
      (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.equal(error.details.capability, missing);
        return true;
      },
    );
    assert.deepEqual(provider.calls, [{ kind: "capabilities" }]);
  }
});

test("a failed safety backup prevents the push", async () => {
  const provider = client({
    action: (request) => ({
      provider: "kinsta",
      action: request.kind,
      status: 202,
      operationId: "backup-operation",
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
  const plan = await prepareEnvironmentPush(provider, SELECTION);
  provider.calls.length = 0;
  await assert.rejects(
    executeEnvironmentPush(provider, plan, {
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
      body: { tag: "novamira-hq pre-push safety backup" },
    },
    { operationStatus: "backup-operation" },
  ]);
});

test("a successful execution always orders backup before push", async () => {
  const provider = client();
  const plan = await prepareEnvironmentPush(provider, {
    ...SELECTION,
    database: false,
    files: ["wp-content/uploads"],
  });
  provider.calls.length = 0;
  await executeEnvironmentPush(provider, plan);
  assert.deepEqual(provider.calls, [
    {
      kind: "create-backup",
      envId: "target",
      body: { tag: "novamira-hq pre-push safety backup" },
    },
    {
      kind: "push-environment",
      siteId: "site-1",
      body: {
        source_env_id: "source",
        target_env_id: "target",
        push_db: false,
        push_files: true,
        run_search_and_replace: false,
        push_files_option: "SPECIFIC_FILES",
        file_list: ["wp-content/uploads"],
      },
    },
  ]);
});
