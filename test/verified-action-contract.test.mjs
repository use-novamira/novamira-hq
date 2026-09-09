// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  waitForVerifiedAction,
  sendGuardedAction,
} from "../dist/hosting/verified-action.js";
import { CliError } from "../dist/errors.js";
import {
  executeEnvironmentPush,
  prepareEnvironmentPush,
} from "../dist/hosting/environment-push.js";

const action = {
  provider: "kinsta",
  action: "backups.create",
  status: 202,
  operationId: "backup-1",
  raw: null,
};

test("transport errors on guarded mutations are never marked retryable", async () => {
  let calls = 0;
  await assert.rejects(
    sendGuardedAction(
      {
        action: async () => {
          calls++;
          throw new CliError("network_error", "Connection lost", {
            retryable: true,
          });
        },
      },
      {
        kind: "restore-backup",
        targetEnvId: "target",
        body: { backup_id: "backup" },
      },
    ),
    (error) =>
      error.code === "network_error" &&
      error.retryable === false &&
      error.details.completionVerified === false,
  );
  assert.equal(calls, 1);
});
const completed = {
  provider: "kinsta",
  operationId: "backup-1",
  status: 200,
  done: true,
  failed: false,
  raw: { status: "completed" },
};
const budget = {
  intervalSeconds: 1,
  timeoutSeconds: 1,
  now: () => 0,
  sleep: async () => {},
};

test("HTTP acceptance and synthetic completion cannot prove a safety backup", async () => {
  for (const [request, status] of [
    [{ ...action, operationId: undefined }, completed],
    [action, { ...completed, raw: null }],
    [action, { ...completed, operationId: "another-operation" }],
    [action, { ...completed, failed: undefined }],
    [action, { ...completed, status: 500 }],
  ]) {
    const client = { provider: "kinsta", operationStatus: async () => status };
    await assert.rejects(
      waitForVerifiedAction(client, request, budget),
      (error) => {
        assert.equal(error.code, "provider_error");
        assert.equal(error.retryable, false);
        assert.equal(error.details.completionVerified, false);
        return true;
      },
    );
  }
});

test("a genuine completed operation supplies the completion evidence", async () => {
  assert.deepEqual(
    await waitForVerifiedAction(
      { provider: "kinsta", operationStatus: async () => completed },
      action,
      budget,
    ),
    completed,
  );
});

test("push revalidates target membership before sending any mutation", async () => {
  let environments = [{ id: "source" }, { id: "target" }];
  const actions = [];
  const client = {
    provider: "kinsta",
    read: async () => [
      { name: "envs.push", supported: true },
      { name: "backups.create", supported: true },
    ],
    listEnvironments: async () => environments,
    action: async (request) => {
      actions.push(request);
      return action;
    },
  };
  const plan = await prepareEnvironmentPush(client, {
    siteId: "site",
    sourceEnvironmentId: "source",
    targetEnvironmentId: "target",
    database: true,
    allFiles: false,
    files: [],
    searchReplace: false,
  });
  environments = [{ id: "source" }];
  await assert.rejects(executeEnvironmentPush(client, plan));
  assert.deepEqual(actions, []);
});
