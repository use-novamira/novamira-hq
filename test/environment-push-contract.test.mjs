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
      return capabilities ?? [{ name: "envs.push", supported: true }];
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
          operationId: request.kind,
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
          raw: { state: "completed" },
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

test("push planning requires only the provider's native push capability", async () => {
  const provider = client({
    capabilities: [
      { name: "envs.push", supported: false },
      { name: "backups.create", supported: true },
    ],
  });
  await assert.rejects(prepareEnvironmentPush(provider, SELECTION), (error) => {
    assert.equal(error.code, "provider_unsupported");
    assert.equal(error.details.capability, "envs.push");
    return true;
  });
  assert.deepEqual(provider.calls, [{ kind: "capabilities" }]);
});

test("push planning does not require backup creation", async () => {
  const provider = client({
    capabilities: [{ name: "envs.push", supported: true }],
  });
  const plan = await prepareEnvironmentPush(provider, SELECTION);
  assert.equal(plan.provider, "kinsta");
  assert.ok(!("safetyBackup" in plan));
});

test("execution sends only the provider-native push and awaits it", async () => {
  const provider = client();
  const plan = await prepareEnvironmentPush(provider, {
    ...SELECTION,
    database: false,
    files: ["wp-content/uploads"],
  });
  provider.calls.length = 0;
  await executeEnvironmentPush(provider, plan);
  assert.deepEqual(provider.calls, [
    { kind: "capabilities" },
    { listEnvironments: "site-1" },
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
    { operationStatus: "push-environment" },
  ]);
});
