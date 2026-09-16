// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { createPushExecutionService } from "../dist/web/services/push-execution.js";
import { renderHtml } from "../dist/web/html.js";
import { renderPushConfirmation } from "../dist/web/views/push-confirmation.js";

function fixture(targetDomain = "live.example.com") {
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
  const service = createPushExecutionService(
    { requireSavedPush: async () => ({ ...path }) },
    {
      clientFromProfile: async () => ({
        provider: "kinsta",
        read: async () => [{ name: "envs.push", supported: true }],
        listEnvironments: async () => [
          {
            id: "source",
            displayName: "Stage",
            primaryDomain: "stage.example.com",
          },
          { id: "target", displayName: "Live", primaryDomain: targetDomain },
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

test("dashboard push plans are read-only, explicit and one-use", async () => {
  const f = fixture();
  const plan = await f.service.plan("stage-live");
  assert.deepEqual(f.calls, []);
  assert.equal(plan.scope, "database");
  assert.match(plan.target, /Live.*target/);
  assert.equal(plan.sourceUrl, "https://stage.example.com");
  assert.equal(plan.targetUrl, "https://live.example.com");
  const markup = renderHtml(renderPushConfirmation(plan));
  assert.ok(markup.startsWith('<section class="page">'));
  assert.ok(
    markup.includes(
      'class="push-review-url">https://live.example.com</strong>',
    ),
  );
  assert.ok(
    markup.includes("Destination — selected content will be overwritten"),
  );
  assert.ok(
    markup.indexOf("https://live.example.com") <
      markup.indexOf("Technical details"),
  );
  assert.ok(
    markup.indexOf("Live (target)") > markup.indexOf("Technical details"),
  );
  await f.service.apply(plan.id);
  assert.deepEqual(
    f.calls.map((call) => call.kind ?? call.operationId),
    ["push-environment", "push-environment"],
  );
  await assert.rejects(f.service.apply(plan.id), { code: "not_found" });
  await f.service.shutdown();
});

test("dashboard cannot confirm a push with a missing or ambiguous destination URL", async () => {
  for (const domain of ["", "stage.example.com"]) {
    const f = fixture(domain);
    await assert.rejects(f.service.plan("stage-live"));
    assert.deepEqual(f.calls, []);
    await f.service.shutdown();
  }
});

test("changed and expired push plans cannot mutate targets", async () => {
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
