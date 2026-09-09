// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { atomicWriteFile } from "../dist/config/atomic-write.js";
import { defaultFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths, historyFilePath } from "../dist/config/paths.js";
import {
  HistoryStore,
  HISTORY_LIMIT,
  needsAttention,
} from "../dist/history/index.js";
import { historyClient } from "../dist/history/client.js";
import { ACTION_REQUEST_KINDS } from "../dist/hosting/client.js";
import { CliError } from "../dist/errors.js";
import { main } from "../dist/main.js";
import { mcpMain } from "../dist/mcp/main.js";
import { renderHistoryPage } from "../dist/web/views/history.js";
import { runHostingWorkflow } from "../dist/operation-context.js";

test("a workflow failure records its fixed code without persisting its message", async (t) => {
  const f = await fixture(t);
  const client = historyClient(
    provider(),
    "production",
    f.history,
    () => "cli",
  );
  await assert.rejects(
    runHostingWorkflow("novamira-setup", async () => {
      await client.action({ kind: "run-wp-cli", envId: "env-1" });
      throw new CliError("server_unsupported", "private failure detail");
    }),
    { code: "server_unsupported" },
  );
  const [entry] = await f.history.list();
  assert.equal(entry.workflowErrorCode, "server_unsupported");
  assert.equal(entry.workflowStatus, "failed");
  assert.doesNotMatch(
    await readFile(f.history.file, "utf8"),
    /private failure detail/,
  );
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    NOVAMIRA_HQ_HOME: root,
    NOVAMIRA_HQ_UPDATE_CHECK: "0",
    KINSTA_API_KEY: "fixture-provider-secret",
  };
  const paths = platformPaths(env);
  const security = defaultFileSecurity();
  const fresh = () =>
    new HistoryStore(
      paths,
      new ProfileLockManager(paths.stateDir, security),
      security,
    );
  const history = fresh();
  return { root, env, paths, security, fresh, history };
}

const intent = {
  profile: "production",
  provider: "kinsta",
  channel: "cli",
  action: "create-backup",
  environmentId: "env-1",
};
const result = {
  provider: "kinsta",
  action: "backups.create",
  status: 202,
  operationId: "op-1",
  raw: { accepted: true },
};
function provider(overrides = {}) {
  return {
    provider: "kinsta",
    action: async () => result,
    operationStatus: async (operationId) => ({
      provider: "kinsta",
      operationId,
      status: 200,
      done: true,
      failed: false,
      raw: { done: true },
    }),
    validate: async () => ({}),
    listSites: async () => [],
    getSite: async () => ({}),
    listEnvironments: async () => [],
    read: async () => ({}),
    ...overrides,
  };
}

async function configure(f) {
  await atomicWriteFile(
    f.paths.configFile,
    JSON.stringify({
      version: 1,
      hostingProfiles: {
        production: {
          provider: "kinsta",
          credential: { type: "env", name: "KINSTA_API_KEY" },
          companyId: "company-1",
        },
      },
      deployPaths: {},
    }),
    f.security,
  );
}

test("history is lazy, durable, private, and never replays interrupted requests", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.history.list(), []);
  await assert.rejects(stat(f.history.file), { code: "ENOENT" });
  const id = await f.history.begin(intent);
  const [row] = await f.fresh().list();
  assert.equal(row.id, id);
  assert.equal(row.status, "needs_verification");
  assert.ok(needsAttention(row));
  assert.equal(f.history.file, historyFilePath(f.paths));
  if (process.platform !== "win32")
    assert.equal((await stat(f.history.file)).mode & 0o777, 0o600);
  await f.fresh().finish(id, "accepted", { operationId: "operation-1" });
  assert.equal((await f.history.list())[0].operationId, "operation-1");
});

test("same-process and independent writers preserve concurrent entries", async (t) => {
  const f = await fixture(t);
  const other = f.fresh();
  const ids = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? f.history : other).begin({ ...intent, profile: `profile-${i}` }),
    ),
  );
  assert.deepEqual(
    new Set((await f.history.list()).map((row) => row.id)),
    new Set(ids),
  );
  assert.equal((await f.history.list("profile-2")).length, 1);
});

test("retention bounds the journal to the newest 500 requests", async (t) => {
  const f = await fixture(t);
  await f.history.begin(intent);
  const [template] = await f.history.list();
  await atomicWriteFile(
    f.history.file,
    JSON.stringify({
      version: 1,
      entries: Array.from({ length: HISTORY_LIMIT }, (_, i) => ({
        ...template,
        status: "succeeded",
        id: `retained-${i}`,
      })),
    }),
    f.security,
  );
  const latest = await f.history.begin(intent);
  const rows = await f.history.list();
  assert.equal(rows.length, HISTORY_LIMIT);
  assert.equal(rows[0].id, latest);
  assert.equal(
    rows.some((row) => row.id === "retained-0"),
    false,
  );
});

test("retention never discards unresolved requests", async (t) => {
  const f = await fixture(t);
  await f.history.begin(intent);
  const [template] = await f.history.list();
  await atomicWriteFile(
    f.history.file,
    JSON.stringify({
      version: 1,
      entries: Array.from({ length: HISTORY_LIMIT }, (_, i) => ({
        ...template,
        id: `pending-${i}`,
      })),
    }),
    f.security,
  );
  await assert.rejects(f.history.begin(intent), { code: "conflict" });
  assert.equal((await f.history.list()).length, HISTORY_LIMIT);
  assert.ok((await f.history.list()).some((entry) => entry.id === "pending-0"));
});

test("workflow outcomes correlate child requests without claiming their HTTP acceptance is completion", async (t) => {
  const f = await fixture(t);
  const client = historyClient(
    provider(),
    "production",
    f.history,
    () => "dashboard",
  );
  await runHostingWorkflow("novamira-setup", async () => {
    await client.action({
      kind: "run-wp-cli",
      envId: "env-1",
      body: { wp_command: "private-command" },
    });
    await client.action({
      kind: "run-wp-cli",
      envId: "env-1",
      body: { wp_command: "private-command-2" },
    });
  });
  const entries = await f.fresh().list();
  assert.equal(new Set(entries.map((entry) => entry.workflowId)).size, 1);
  assert.ok(
    entries.every(
      (entry) =>
        entry.workflowStatus === "succeeded" && entry.status === "accepted",
    ),
  );
  assert.doesNotMatch(
    await readFile(f.history.file, "utf8"),
    /private-command/,
  );
});

test("every action is recorded before dispatch without command bodies, messages or secrets", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const client = historyClient(
    provider({
      action: async (request) => {
        calls++;
        const [before] = await f.history.list();
        assert.equal(before.action, request.kind);
        assert.equal(before.status, "needs_verification");
        return {
          ...result,
          message: "private-output",
          raw: { command: "private-php-code" },
        };
      },
    }),
    "production",
    f.history,
    () => "dashboard",
  );
  for (const kind of ACTION_REQUEST_KINDS)
    await client.action({
      kind,
      envId: "env-1",
      siteId: "site-1",
      body: { password: "private-password", command: "private-php-code" },
    });
  const rows = await f.fresh().list();
  assert.equal(calls, ACTION_REQUEST_KINDS.length);
  assert.ok(
    rows.every(
      (row) => row.channel === "dashboard" && row.status === "accepted",
    ),
  );
  const raw = await readFile(f.history.file, "utf8");
  assert.doesNotMatch(
    raw,
    /private-password|private-php-code|private-output|command|raw|password/,
  );
});

test("acceptance is not completion, synthetic status is not proof, real polling updates history", async (t) => {
  const f = await fixture(t);
  const client = historyClient(
    provider(),
    "production",
    f.history,
    () => "cli",
  );
  await client.action({ kind: "create-backup", envId: "env-1" });
  assert.equal((await f.history.list())[0].status, "accepted");
  const synthetic = historyClient(
    provider({
      operationStatus: async () => ({
        provider: "kinsta",
        operationId: "op-1",
        status: 200,
        done: true,
        failed: false,
        raw: null,
      }),
    }),
    "production",
    f.fresh(),
    () => "mcp",
  );
  await synthetic.operationStatus("op-1");
  assert.equal((await f.history.list())[0].status, "needs_verification");
  await client.operationStatus("op-1");
  const [row] = await f.history.list();
  assert.equal(row.status, "succeeded");
  assert.equal(row.channel, "cli");
  assert.equal(needsAttention(row), false);
  await synthetic.operationStatus("op-1");
  assert.equal((await f.history.list())[0].status, "succeeded");
});

test("timeouts remain uncertain and errors never persist provider output", async (t) => {
  const f = await fixture(t);
  const client = historyClient(
    provider({
      action: async () => {
        throw new CliError("timeout", "private-error-output");
      },
    }),
    "production",
    f.history,
    () => "mcp",
  );
  await assert.rejects(client.action({ kind: "restart-php", envId: "env-1" }), {
    code: "timeout",
  });
  const [row] = await f.history.list();
  assert.equal(row.status, "needs_verification");
  assert.equal(row.errorCode, "timeout");
  assert.doesNotMatch(
    await readFile(f.history.file, "utf8"),
    /private-error-output/,
  );
});

test("broken storage prevents dispatch; post-dispatch storage errors forbid blind retry", async (t) => {
  const f = await fixture(t);
  await atomicWriteFile(f.history.file, "broken", f.security);
  let calls = 0;
  const client = historyClient(
    provider({
      action: async () => {
        calls++;
        return result;
      },
    }),
    "production",
    f.history,
    () => "cli",
  );
  await assert.rejects(
    client.action({ kind: "create-backup", envId: "env-1" }),
    { code: "config_error" },
  );
  assert.equal(calls, 0);
  assert.equal(await readFile(f.history.file, "utf8"), "broken");
  const failing = historyClient(
    provider(),
    "production",
    {
      begin: async () => "id",
      finish: async () => {
        throw new Error("private-error");
      },
    },
    () => "cli",
  );
  await assert.rejects(
    failing.action({ kind: "create-backup", envId: "env-1" }),
    (error) =>
      error.code === "config_error" &&
      !error.retryable &&
      /Verify at the provider before repeating/.test(error.message) &&
      !error.message.includes("private-error"),
  );
});

test("unsafe files and malformed schema fail closed without overwriting history", async (t) => {
  const f = await fixture(t);
  await f.history.begin(intent);
  const [row] = await f.history.list();
  for (const bad of [
    { ...row, raw: "private-raw" },
    { ...row, channel: ["cli"] },
    { ...row, status: "invented" },
  ]) {
    const content = JSON.stringify({ version: 1, entries: [bad] });
    await atomicWriteFile(f.history.file, content, f.security);
    await assert.rejects(f.history.list(), { code: "config_error" });
    assert.equal(await readFile(f.history.file, "utf8"), content);
  }
  if (process.platform !== "win32") {
    await atomicWriteFile(
      f.history.file,
      JSON.stringify({ version: 1, entries: [row] }),
      f.security,
    );
    await chmod(f.history.file, 0o644);
    await assert.rejects(f.history.list(), { code: "config_error" });
    const target = join(f.root, "other-history.json");
    await atomicWriteFile(target, "{}", f.security);
    await rm(f.history.file);
    await symlink(target, f.history.file);
    await assert.rejects(f.history.begin(intent), { code: "config_error" });
    assert.equal(await readFile(target, "utf8"), "{}");
  }
});

test("real CLI and MCP share persisted history, with attribution and no provider calls for listing", async (t) => {
  const f = await fixture(t);
  await configure(f);
  let constructions = 0;
  const registry = {
    kinsta: () => {
      constructions++;
      return provider();
    },
  };
  let stdout = "";
  const streams = {
    stdout: {
      write: (chunk) => {
        stdout += chunk;
      },
    },
    stderr: { write: () => {} },
  };
  assert.equal(
    await main(
      [
        "hosting",
        "backups",
        "create",
        "--env",
        "env-1",
        "--profile",
        "production",
        "--json",
      ],
      streams,
      f.env,
      { registry },
    ),
    0,
    stdout,
  );
  assert.equal((await f.history.list())[0].channel, "cli");
  const lines = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "hosting_backup_create",
        arguments: { profile: "production", environmentId: "env-2" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "hosting_history_list",
        arguments: { profile: "production" },
      },
    },
  ];
  let output = "";
  await mcpMain(
    [],
    {
      input: Readable.from(lines.map((row) => JSON.stringify(row) + "\n")),
      output: {
        write: (chunk) => {
          output += chunk;
        },
      },
    },
    f.env,
    { registry },
  );
  const answers = output.trim().split("\n").map(JSON.parse);
  assert.equal(
    answers.find((answer) => answer.id === 2).result.isError,
    undefined,
    output,
  );
  assert.match(
    JSON.stringify(answers.find((answer) => answer.id === 3)),
    /env-2/,
  );
  assert.deepEqual(
    (await f.history.list()).map((row) => row.channel),
    ["mcp", "cli"],
  );
  const before = constructions;
  stdout = "";
  assert.equal(
    await main(
      ["history", "--profile", "production", "--json"],
      streams,
      f.env,
      { registry },
    ),
    0,
  );
  assert.equal(JSON.parse(stdout).data.entries.length, 2);
  assert.equal(constructions, before);
});

test("history view explains uncertainty and escapes targets", async () => {
  const markup = renderHistoryPage([
    {
      ...intent,
      profile: "<script>bad</script>",
      id: "test",
      status: "needs_verification",
      startedAt: "2026-09-08T12:00:00.000Z",
      updatedAt: "2026-09-08T12:00:00.000Z",
    },
  ]).markup;
  assert.match(markup, /Needs attention \(1\)/);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>bad/);
  assert.match(markup, /does not poll the provider or repeat operations/);
});
