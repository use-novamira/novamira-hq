// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import {
  createRestoreService,
  backupChoices,
} from "../dist/web/services/restore.js";
import { renderRestore } from "../dist/web/views/restore.js";
import { renderHtml } from "../dist/web/html.js";
import { parseRestoreForm } from "../dist/web/signals-input.js";

const target = { profile: "account", site: "site", env: "live" };
function fixture(createOnly = false) {
  const calls = [];
  let clock = 0;
  let config = "original";
  let domain = "https://example.test";
  let restoreFailed = false;
  let supported = true;
  const client = {
    provider: "kinsta",
    async listEnvironments() {
      return [{ id: "live", primaryDomain: domain }];
    },
    async read(request) {
      if (request.kind === "capabilities")
        return ["backups.list", "backups.create", "backups.restore"].map(
          (name) => ({
            name,
            supported: supported && (!createOnly || name === "backups.create"),
          }),
        );
      return { backups: [{ id: 42, created_at: "2026-09-17T10:00:00Z" }] };
    },
    async action(request) {
      calls.push(request.kind);
      return {
        provider: "kinsta",
        status: 202,
        operationId: request.kind,
        raw: {},
      };
    },
    async operationStatus(operationId) {
      return {
        provider: "kinsta",
        operationId,
        status: 200,
        done: true,
        failed: restoreFailed,
        raw: { done: true },
      };
    },
  };
  const service = createRestoreService(
    {
      async requireHostingProfile() {
        return { config };
      },
    },
    {
      async clientFromProfile() {
        return client;
      },
    },
    () => clock,
  );
  return {
    service,
    calls,
    advance: () => (clock = 300_001),
    change: () => (config = "changed"),
    move: () => (domain = "https://other.test"),
    fail: () => (restoreFailed = true),
    disable: () => (supported = false),
  };
}
test("Kinsta millisecond timestamps become readable UTC dates", () => {
  assert.deepEqual(
    backupChoices({
      environment: {
        backups: [{ id: 123, created_at: Date.UTC(2026, 8, 21, 9, 4) }],
      },
    }),
    [{ id: "123", label: "21 Sept 2026, 09:04 UTC" }],
  );
});
test("dashboard restore catalog is read-only and shows only backup entries", async () => {
  const f = fixture();
  const catalog = await f.service.catalog(target);
  assert.equal(catalog.targetUrl, "https://example.test");
  assert.equal(catalog.backups[0].id, "42");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(backupChoices({ id: "account", backups: [] }), []);
  f.disable();
  await assert.rejects(f.service.catalog(target), {
    code: "provider_unsupported",
  });
});

test("dashboard backup creation needs only create capability and never restores", async () => {
  const f = fixture(true);
  const review = await f.service.planCreate(target);
  assert.equal(review.operation, "create");
  assert.deepEqual(f.calls, []);
  assert.match(
    renderHtml(renderRestore({ target, review })),
    />Create backup<\/button>/,
  );
  const job = f.service.start(review.id);
  assert.equal(f.service.start(review.id), job);
  await f.service.wait(review.id, new AbortController().signal);
  assert.equal(f.service.snapshot(review.id).status, "completed");
  f.service.start(review.id);
  assert.deepEqual(f.calls, ["create-backup"]);
  await f.service.shutdown();
});

test("backup creation rejects unsupported or changed targets and expired plans", async () => {
  for (const change of ["advance", "change", "move"]) {
    const f = fixture(true);
    const review = await f.service.planCreate(target);
    f[change]();
    if (change === "advance") assert.throws(() => f.service.start(review.id));
    else {
      f.service.start(review.id);
      await f.service.wait(review.id, new AbortController().signal);
    }
    assert.deepEqual(f.calls, []);
    await f.service.shutdown();
  }
  const f = fixture(true);
  f.disable();
  await assert.rejects(f.service.planCreate(target), {
    code: "provider_unsupported",
  });
});

test("backup creation does not report completion without provider evidence", async () => {
  const f = fixture(true);
  f.fail();
  const review = await f.service.planCreate(target);
  f.service.start(review.id);
  await f.service.wait(review.id, new AbortController().signal);
  assert.equal(f.service.snapshot(review.id).status, "needs_verification");
  assert.deepEqual(f.calls, ["create-backup"]);
});
test("dashboard restore refuses missing acknowledgement, notification user, wrong environment and backup", async () => {
  const f = fixture();
  await assert.rejects(f.service.plan(target, "42", false, "user"));
  await assert.rejects(f.service.plan(target, "42", true, ""));
  await assert.rejects(f.service.plan(target, "wrong", true, "user"));
  await assert.rejects(
    f.service.plan({ ...target, env: "other" }, "42", true, "user"),
  );
  assert.deepEqual(f.calls, []);
});
test("dashboard restore is one-use and polling never replays it", async () => {
  const f = fixture();
  const review = await f.service.plan(target, "42", true, "user");
  assert.deepEqual(f.calls, []);
  const job = f.service.start(review.id);
  assert.equal(job.status, "running");
  assert.equal(f.service.start(review.id), job);
  await f.service.wait(review.id, new AbortController().signal);
  assert.equal(f.service.snapshot(review.id).status, "completed");
  f.service.start(review.id);
  assert.deepEqual(f.calls, ["restore-backup"]);
  await f.service.shutdown();
});
test("expired, changed-profile and changed-destination plans cannot mutate", async () => {
  for (const change of ["advance", "change", "move"]) {
    const f = fixture();
    const review = await f.service.plan(target, "42", true, "user");
    f[change]();
    if (change === "advance") assert.throws(() => f.service.start(review.id));
    else {
      f.service.start(review.id);
      await f.service.wait(review.id, new AbortController().signal);
    }
    assert.deepEqual(f.calls, []);
    await f.service.shutdown();
  }
});
test("failed restore remains unverified without creating a backup", async () => {
  const f = fixture();
  f.fail();
  const review = await f.service.plan(target, "42", true, "user");
  f.service.start(review.id);
  await f.service.wait(review.id, new AbortController().signal);
  assert.deepEqual(f.calls, ["restore-backup"]);
  assert.equal(f.service.snapshot(review.id).status, "needs_verification");
});
test("restore form uses explicit boolean acknowledgement and escaped labels", async () => {
  assert.equal(
    parseRestoreForm({ restoreForm: { allContent: "true" } }).allContent,
    false,
  );
  const f = fixture();
  const catalog = await f.service.catalog(target);
  const markup = renderHtml(renderRestore({ target, catalog }));
  assert.match(markup, /Kinsta user ID/);
  assert.match(markup, /restoreForm.allContent/);
  assert.match(markup, /!\$restoreForm.allContent/);
  assert.match(markup, /!\$restoreForm.backupId/);
  assert.match(markup, /!\$restoreForm.notifiedUserId/);
  assert.match(markup, /Continue/);
  const review = await f.service.plan(target, "42", true, "user");
  assert.match(
    renderHtml(renderRestore({ target, review })),
    /Confirm and restore/,
  );
  assert.match(
    renderHtml(
      renderRestore({ target, review: { ...review, targetUrl: "<script>" } }),
    ),
    /&lt;script&gt;/,
  );
});
