// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { createPushExecutionService } from "../dist/web/services/push-execution.js";
import { renderHtml } from "../dist/web/html.js";
import { renderPushConfirmation } from "../dist/web/views/push-confirmation.js";
import { renderPushJob } from "../dist/web/views/push-job.js";

function fixture(
  targetDomain = "live.example.com",
  operation = async () => {},
) {
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
          await operation();
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

test("push jobs acknowledge immediately, survive observer disconnect and never replay", async () => {
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture("live.example.com", () => gate);
  const plan = await f.service.plan("stage-live");
  const job = f.service.start(plan.id);
  assert.equal(job.status, "running");
  assert.equal(f.service.start(plan.id), job);
  const markup = renderHtml(renderPushJob(job));
  assert.ok(markup.includes("/_dashboard/pushes/status"));
  assert.ok(markup.includes(plan.sourceUrl.replace(/^https?:\/\//, "")));
  assert.ok(markup.includes(plan.targetUrl.replace(/^https?:\/\//, "")));
  const controller = new AbortController();
  const observer = f.service.wait(plan.id, controller.signal);
  controller.abort();
  await observer;
  assert.equal(f.service.snapshot(plan.id).status, "running");
  finish();
  await f.service.wait(plan.id);
  assert.equal(f.service.start(plan.id).status, "completed");
  assert.equal(
    f.calls.filter((call) => call.kind === "push-environment").length,
    1,
  );
  assert.ok(
    !renderHtml(renderPushJob(f.service.snapshot(plan.id))).includes(
      "data-init",
    ),
  );
  await f.service.shutdown();
});

test("push jobs distinguish pre-dispatch failure from uncertain provider outcomes", async () => {
  const failed = fixture();
  const plan = await failed.service.plan("stage-live");
  failed.change();
  failed.service.start(plan.id);
  await failed.service.wait(plan.id);
  assert.equal(failed.service.snapshot(plan.id).status, "failed");
  assert.equal(failed.calls.length, 0);
  await failed.service.shutdown();
  const uncertain = fixture("live.example.com", async () => {
    throw new Error("Lost response");
  });
  const other = await uncertain.service.plan("stage-live");
  uncertain.service.start(other.id);
  await uncertain.service.wait(other.id);
  assert.equal(
    uncertain.service.snapshot(other.id).status,
    "needs_verification",
  );
  assert.equal(uncertain.service.start(other.id).status, "needs_verification");
  assert.equal(
    uncertain.calls.filter((call) => call.kind === "push-environment").length,
    1,
  );
  await uncertain.service.shutdown();
});

test("a second pre-approved plan cannot replay a push after an uncertain outcome", async () => {
  const f = fixture("live.example.com", async () => {
    throw new Error("Lost response");
  });
  const first = await f.service.plan("stage-live");
  const second = await f.service.plan("stage-live");
  await assert.rejects(f.service.apply(first.id));
  await assert.rejects(f.service.apply(second.id), { code: "conflict" });
  assert.equal(
    f.calls.filter((call) => call.kind === "push-environment").length,
    1,
  );
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
