// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { instaWpVersions } from "../dist/hosting/providers/instawp-versions.js";
import { createInstaWpClient } from "../dist/hosting/providers/instawp.js";
import {
  executeBackupRestore,
  prepareBackupRestore,
} from "../dist/hosting/backup-restore.js";
import { SecretValue } from "../dist/credentials/store.js";
import { renderBackupCreate } from "../dist/web/views/backup-create.js";
import { renderHtml } from "../dist/web/html.js";
import { backupChoices } from "../dist/web/services/restore.js";

const row = (extra = {}) => ({
  id: 12,
  site_id: 42,
  name: "Before update",
  created_at: "2026-09-17T12:00:00Z",
  status: "completed",
  password: "never-expose-this",
  ...extra,
});
function fixture({
  rows = [row()],
  created = { id: 13, task_id: 100 },
  state = "completed",
  nameFails = false,
} = {}) {
  const calls = [];
  const http = {
    async json(request) {
      calls.push(request);
      if (request.path === "/site-versions")
        return { status: true, data: rows };
      if (request.path === "/site-versions/13") {
        if (nameFails) throw new Error("label failed");
        return { status: true, data: {} };
      }
      if (/^\/tasks\/(100|101)\/status$/.test(request.path))
        return {
          status: true,
          data: { status: state, password: "never-expose-this" },
        };
      assert.fail(`Unexpected read ${request.path}`);
    },
    async request(request) {
      calls.push(request);
      if (request.path === "/site-versions")
        return { status: 200, data: { status: true, data: created } };
      if (request.path === "/sites/42/restore-versions/12")
        return { status: 200, data: { status: true, data: { task_id: 101 } } };
      assert.fail(`Unexpected write ${request.path}`);
    },
  };
  const client = createInstaWpClient({
    secret: new SecretValue("fake"),
    createHttpClient: () => http,
  });
  return { calls, http, client, versions: instaWpVersions(http) };
}

test("Site Versions create uses exact API and retains task when optional naming fails", async () => {
  const { versions, calls } = fixture({ nameFails: true });
  const result = await versions.create("42", { tag: "a".repeat(40) });
  assert.deepEqual(calls[0], {
    path: "/site-versions",
    method: "POST",
    body: { kind: "json", value: { site_id: "42" } },
  });
  assert.equal(calls[1].body.value.name.length, 25);
  assert.equal(result.operationId, "version-task:100");
  assert.match(result.message, /label could not/);
  assert.equal(calls.length, 2);
});

test("Site Versions catalog is site scoped and never returns secrets", async () => {
  const { versions, calls } = fixture({
    rows: [
      row(),
      row({ id: 99, site_id: 99 }),
      row({ id: 14, site_id: undefined }),
    ],
  });
  const result = await versions.list("42");
  assert.deepEqual(
    result.backups.map((r) => r.id),
    ["12", "14"],
  );
  assert.equal(result.backups[0].kind, "site_version");
  assert.ok(!JSON.stringify(result).includes("never-expose-this"));
  assert.deepEqual(Object.fromEntries(calls[0].query), {
    site_id: "42",
    per_page: "100",
    page: "1",
  });
});

test("Site Versions rejects arbitrary body, IDs and incomplete or foreign restore targets", async () => {
  for (const body of [
    { tag: 1 },
    { tag: "a\nb" },
    { site_id: 99 },
    { mark_as_public: true },
    null,
  ]) {
    const { versions, calls } = fixture();
    await assert.rejects(versions.create("42", body), { code: "usage_error" });
    assert.equal(calls.length, 0);
  }
  for (const rows of [
    [],
    [row({ status: "progress" })],
    [row({ site_id: 99 })],
  ]) {
    const { versions, calls } = fixture({ rows });
    await assert.rejects(versions.restore("42", { backup_id: "12" }), {
      code: "not_found",
    });
    assert.equal(calls.length, 1);
  }
  const { versions, calls } = fixture();
  await assert.rejects(versions.restore("42", { backup_id: "../12" }), {
    code: "usage_error",
  });
  await assert.rejects(
    versions.restore("42", { backup_id: "12", site_id: "99" }),
    { code: "usage_error" },
  );
  assert.equal(calls.length, 0);
});

test("only explicit task completion proves success, with safe normalized output", async () => {
  for (const state of [
    "completed",
    "error",
    "failed",
    "progress",
    "queued",
    "unexpected",
    undefined,
  ]) {
    const { versions } = fixture({ state: state ?? null });
    const result = await versions.status("version-task:100");
    assert.equal(result.done, ["completed", "error", "failed"].includes(state));
    assert.equal(result.failed, ["error", "failed"].includes(state));
    assert.ok(!JSON.stringify(result).includes("never-expose-this"));
  }
  for (const created of [
    { id: 13 },
    { task_id: 100 },
    { id: 13, task_id: "bad" },
    { id: 13, task_id: 100, site_id: 99 },
  ]) {
    await assert.rejects(fixture({ created }).versions.create("42", {}), {
      code: "provider_error",
    });
  }
});

test("guarded InstaWP restore waits for fresh safety version before non-retrying restore", async () => {
  const { client, calls } = fixture();
  const plan = await prepareBackupRestore(client, {
    targetEnvironmentId: "42",
    backupId: "12",
    allContent: true,
  });
  const result = await executeBackupRestore(client, plan, {
    intervalSeconds: 1,
    timeoutSeconds: 1,
  });
  assert.equal(result.restoreStatus.done, true);
  const safety = calls.findIndex((c) => c.path === "/tasks/100/status");
  const restore = calls.findIndex(
    (c) => c.path === "/sites/42/restore-versions/12",
  );
  assert.ok(safety >= 0 && restore > safety);
  assert.equal(calls[restore].method, "PUT");
  assert.equal(calls[restore].idempotent, false);
  assert.equal(calls.at(-1).path, "/tasks/101/status");
});

test("failed safety version blocks the restore", async () => {
  const { client, calls } = fixture({ state: "failed" });
  const plan = await prepareBackupRestore(client, {
    targetEnvironmentId: "42",
    backupId: "12",
    allContent: true,
  });
  await assert.rejects(
    executeBackupRestore(client, plan, {
      intervalSeconds: 1,
      timeoutSeconds: 1,
    }),
  );
  assert.ok(!calls.some((c) => c.path.includes("restore-versions")));
});

test("incomplete versions cannot be planned or selected in the dashboard", async () => {
  const { client } = fixture({ rows: [row({ status: "progress" })] });
  await assert.rejects(
    prepareBackupRestore(client, {
      targetEnvironmentId: "42",
      backupId: "12",
      allContent: true,
    }),
    { code: "not_found" },
  );
  const catalog = await client.read({ kind: "backups", envId: "42" });
  assert.deepEqual(backupChoices(catalog), []);
  const { client: ready } = fixture();
  const labels = backupChoices(
    await ready.read({ kind: "backups", envId: "42" }),
  );
  assert.match(labels[0].label, /2026-09-17.*Before update.*ID 12/);
});

test("Site Versions catalog pagination is bounded and malformed envelopes fail closed", async () => {
  let pages = 0;
  const versions = instaWpVersions({
    async json() {
      pages++;
      return { status: true, data: [row()], meta: { last_page: 2 } };
    },
  });
  assert.equal((await versions.list("42")).backups.length, 2);
  assert.equal(pages, 2);
  for (const value of [{ status: false }, { status: true, data: {} }]) {
    await assert.rejects(
      instaWpVersions({
        async json() {
          return value;
        },
      }).list("42"),
      { code: "provider_error" },
    );
  }
});

test("dashboard explains restorable versions rather than reusable snapshots", () => {
  const target = { profile: "account", site: "42", env: "42" };
  const markup = renderHtml(
    renderBackupCreate({
      create: true,
      target,
      review: {
        ...target,
        id: "review",
        operation: "create",
        provider: "instawp",
        targetUrl: "https://example.test",
        backupId: "Safety",
        expiresAt: 1000,
      },
    }),
  );
  assert.match(markup, /Site Version/);
  assert.match(markup, /restored onto the same site/);
  assert.ok(!markup.includes("private snapshot"));
});
