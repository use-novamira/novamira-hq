// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { createDeployExecutionService } from "../dist/web/services/deploy-execution.js";

function fixture() {
  const calls = [];
  let path = {
    name: "stage-live",
    hostingProfile: "production",
    siteId: "site",
    sourceEnvId: "source",
    targetEnvId: "target",
    pushDb: true,
    pushFiles: false,
    searchReplace: false,
  };
  let now = 1000;
  const service = createDeployExecutionService(
    { requireDeployPath: async () => ({ ...path }) },
    {
      clientFromProfile: async () => ({
        provider: "kinsta",
        read: async () => [
          { name: "envs.push", supported: true },
          { name: "backups.create", supported: true },
        ],
        listEnvironments: async () => [
          { id: "source", displayName: "Stage" },
          { id: "target", displayName: "Live" },
        ],
        action: async (request) => {
          calls.push(request);
          return {
            provider: "kinsta",
            action: request.kind,
            status: 202,
            operationId: request.kind,
            raw: {},
          };
        },
        operationStatus: async (operationId) => {
          calls.push({ operationId });
          return {
            provider: "kinsta",
            operationId,
            status: 200,
            done: true,
            failed: false,
            raw: { status: 200 },
          };
        },
      }),
    },
    () => now,
  );
  return {
    service,
    calls,
    change: () => {
      path.pushFiles = true;
    },
    expire: () => {
      now += 300001;
    },
  };
}

test("dashboard deploy plans are read-only, explicit and one-use", async () => {
  const f = fixture();
  const plan = await f.service.plan("stage-live");
  assert.deepEqual(f.calls, []);
  assert.equal(plan.scope, "database");
  assert.match(plan.target, /Live.*target/);
  await f.service.apply(plan.id);
  assert.deepEqual(
    f.calls.map((call) => call.kind ?? call.operationId),
    ["create-backup", "create-backup", "push-environment", "push-environment"],
  );
  await assert.rejects(f.service.apply(plan.id), { code: "not_found" });
  await f.service.shutdown();
});

test("changed and expired deploy plans cannot mutate targets", async () => {
  for (const change of ["change", "expire"]) {
    const f = fixture();
    const plan = await f.service.plan("stage-live");
    f[change]();
    await assert.rejects(f.service.apply(plan.id));
    assert.deepEqual(f.calls, []);
    await assert.rejects(f.service.apply(plan.id), { code: "not_found" });
    await f.service.shutdown();
  }
});
