// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { HistoryStore } from "../dist/history/index.js";
import { historyClient } from "../dist/history/client.js";
import { withPushHistory } from "../dist/operation-context.js";
import { defaultFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { createPushExecutionService } from "../dist/web/services/push-execution.js";
import { renderPushJob, renderPushJobs } from "../dist/web/views/push-job.js";
import { renderHtml } from "../dist/web/html.js";
import { renderPushesPage } from "../dist/web/views/pushes.js";

test("Push history hides removed hosting profiles without deleting saved jobs", () => {
  const jobs = ["active", "removed"].map((profile) => ({
    confirmation: {
      id: profile,
      name: profile,
      profile,
      sourceUrl: `${profile}-source.example.com`,
      targetUrl: `${profile}-target.example.com`,
    },
    status: "completed",
    startedAt: 1000,
    finishedAt: 2000,
  }));
  const view = {
    profiles: [{ name: "active", provider: "instawp" }],
    pushes: [],
    version: "test",
    configFile: "test",
  };
  const render = (profiles) =>
    renderHtml(
      renderPushesPage(
        { ...view, profiles },
        { level: "neutral", message: "" },
        undefined,
        jobs,
      ),
    );
  const markup = render(view.profiles);
  assert.match(markup, /active-source.example.com/);
  assert.ok(!markup.includes("removed-source.example.com"));
  assert.ok(!render([]).includes("Push history"));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].confirmation.profile, "removed");
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hq-push-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = platformPaths({ NOVAMIRA_HQ_HOME: root });
  const security = defaultFileSecurity();
  let now = Date.parse("2026-09-18T12:00:00.000Z");
  const fresh = () =>
    new HistoryStore(
      paths,
      new ProfileLockManager(paths.stateDir, security),
      security,
      () => now,
    );
  let mode = "running";
  let providerKind = "kinsta";
  let writes = 0;
  let reads = 0;
  const client = {
    provider: "kinsta",
    action: async () => {
      writes++;
      return {
        provider: "kinsta",
        status: 202,
        operationId: "operation-1",
        raw: {},
      };
    },
    operationStatus: async (operationId) => {
      reads++;
      if (mode === "offline") throw new Error("network error");
      return {
        provider: "kinsta",
        operationId,
        status: mode === "completed" ? 200 : mode === "failed" ? 500 : 202,
        done: mode === "completed",
        failed: mode === "failed",
        raw: {},
      };
    },
  };
  const first = fresh();
  await withPushHistory(
    {
      pushJobId: "job-1",
      pushName: "Staging to live",
      sourceUrl: "https://stage.example.com",
      targetUrl: "https://live.example.com",
    },
    () =>
      historyClient(client, "production", first, () => "dashboard").action({
        kind: "push-environment",
        siteId: "site",
        body: {
          source_env_id: "source",
          target_env_id: "target",
          push_db: true,
          push_files: true,
          push_files_option: "ALL_FILES",
        },
      }),
  );
  const create = () => {
    const history = fresh();
    const service = createPushExecutionService(
      {},
      {
        clientFromProfile: async () => ({
          ...historyClient(client, "production", history, () => "dashboard"),
          provider: providerKind,
        }),
      },
      () => now,
      history,
    );
    t.after(() => service.shutdown());
    return service;
  };
  return {
    create,
    fresh,
    advance: () => {
      now += 20 * 60_000;
    },
    mode: (value) => {
      mode = value;
    },
    provider: (value) => {
      providerKind = value;
    },
    counts: () => ({ reads, writes }),
  };
}

test("push history survives restart, observes a 20-minute job and never replays the write", async (t) => {
  const f = await fixture(t);
  const service = f.create();
  await service.refresh(false);
  assert.deepEqual(f.counts(), { reads: 0, writes: 1 });
  const recovered = service.snapshot("job-1");
  assert.equal(recovered.status, "needs_verification");
  assert.equal(recovered.finishedAt, null);
  assert.equal(recovered.confirmation.sourceUrl, "https://stage.example.com");
  assert.equal(recovered.confirmation.scope, "database, all files");
  f.advance();
  await service.refresh();
  assert.equal(service.snapshot("job-1").status, "running");
  assert.equal(service.snapshot("job-1").startedAt, recovered.startedAt);
  await service.shutdown();
  const restarted = f.create();
  f.mode("completed");
  await restarted.refresh();
  assert.equal(restarted.snapshot("job-1").status, "completed");
  assert.equal((await f.fresh().list())[0].status, "succeeded");
  const again = f.create();
  await again.refresh();
  assert.equal(again.snapshot("job-1").status, "completed");
  assert.deepEqual(f.counts(), { reads: 2, writes: 1 });
  const markup = renderHtml(renderPushJob(again.snapshot("job-1")));
  assert.match(markup, /Observed duration/);
  assert.match(markup, /20 min 0 s/);
  assert.doesNotMatch(markup, /data-init/);
});

test("offline status stays unverified without a false finish time; failure requires provider evidence", async (t) => {
  const f = await fixture(t);
  const service = f.create();
  f.mode("offline");
  await service.refresh();
  assert.equal(service.snapshot("job-1").status, "needs_verification");
  assert.equal(service.snapshot("job-1").finishedAt, null);
  assert.equal((await f.fresh().list())[0].status, "needs_verification");
  assert.doesNotMatch(
    renderHtml(renderPushJob(service.snapshot("job-1"))),
    /Outcome confirmed:/,
  );
  f.mode("failed");
  await service.refresh();
  assert.equal(service.snapshot("job-1").status, "failed");
  assert.equal((await f.fresh().list())[0].status, "failed");
  assert.equal(f.counts().writes, 1);
});

test("changed provider and missing operation IDs cannot be probed or replayed", async (t) => {
  const f = await fixture(t);
  f.provider("instawp");
  const service = f.create();
  await service.refresh();
  assert.deepEqual(f.counts(), { reads: 0, writes: 1 });
  const id = await f.fresh().begin({
    profile: "production",
    provider: "kinsta",
    channel: "dashboard",
    action: "push-environment",
    sourceEnvironmentId: "older-source",
    environmentId: "older-target",
  });
  await service.refresh();
  assert.equal(service.snapshot(id).status, "needs_verification");
  assert.equal(
    service.snapshot(id).confirmation.sourceUrl,
    "Source environment (name unavailable)",
  );
  assert.deepEqual(f.counts(), { reads: 0, writes: 1 });
  assert.match(renderHtml(renderPushJobs(service.list())), /Push history/);
});

test("browser elapsed labels tick each second and freeze on the observed finish time", async () => {
  const source = await readFile(
    new URL("../src/web/static/relative-time.js", import.meta.url),
    "utf8",
  );
  let now = 125_000;
  const node = (end) => ({
    textContent: "",
    getAttribute: (name) => (name === "data-job-started-at" ? "1000" : end),
  });
  const running = node("");
  const finished = node("61000");
  let tick;
  runInNewContext(source, {
    Date: { now: () => now },
    document: {
      querySelectorAll: (selector) =>
        selector === "[data-job-started-at]" ? [running, finished] : [],
    },
    setInterval: (callback, ms) => {
      assert.equal(ms, 1000);
      tick = callback;
    },
  });
  assert.equal(running.textContent, "2 min 4 s");
  assert.equal(finished.textContent, "1 min 0 s");
  now += 1000;
  tick();
  assert.equal(running.textContent, "2 min 5 s");
  assert.equal(finished.textContent, "1 min 0 s");
});
