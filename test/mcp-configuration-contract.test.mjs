// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMcpConnectionService } from "../dist/mcp/configuration.js";
import { renderMcpPage } from "../dist/web/views/mcp.js";
import { renderHtml } from "../dist/web/html.js";
import { createDashboardUpdates } from "../dist/cli/dashboard.js";

test("client configs contain only fixed launch arguments and HQ path overrides", () => {
  const service = createMcpConnectionService(
    {
      command: "/Applications/Novamira HQ.app/Contents/MacOS/hq",
      args: ["--mcp"],
    },
    {
      NOVAMIRA_HQ_HOME: "/private/example path",
      KINSTA_API_KEY: "must-not-copy-this",
    },
  );
  const config = service.configuration();
  const server = JSON.parse(config.claude).mcpServers["novamira-hq"];
  assert.deepEqual(server.args, ["--mcp"]);
  assert.deepEqual(server.env, { NOVAMIRA_HQ_HOME: "/private/example path" });
  assert.match(config.chatgpt, /\[mcp_servers.novamira-hq\]/);
  assert.doesNotMatch(
    JSON.stringify(config),
    /must-not-copy-this|KINSTA_API_KEY/,
  );
  assert.doesNotMatch(JSON.stringify(config), /--access|--allow|--deny/);
});

test("real local MCP handshake lists tools without configuring profiles or writing state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hq-mcp-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createMcpConnectionService(
    {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../dist/index.js", import.meta.url)),
        "mcp",
      ],
    },
    { ...process.env, NOVAMIRA_HQ_HOME: root, NOVAMIRA_HQ_UPDATE_CHECK: "0" },
  );
  const result = await service.verify();
  assert.ok(result.toolCount > 0);
  assert.deepEqual(await readdir(root), []);
});

test("MCP page chooses a client before showing its setup", () => {
  const config = createMcpConnectionService(
    { command: "/a path/node", args: ["/hq/index.js", "mcp"] },
    {},
  ).configuration();
  const choice = renderHtml(
    renderMcpPage(
      {
        profiles: [
          {
            name: "future-profile",
            provider: "future-adapter",
            credentialAvailable: false,
          },
        ],
        pushes: [],
      },
      config,
    ),
  );
  assert.ok(choice.includes("Which AI client do you use?"));
  assert.ok(choice.includes("/mcp?client=chatgpt"));
  assert.ok(choice.includes("/mcp?client=claude"));
  assert.ok(!choice.includes("Copy configuration"));

  const markup = renderHtml(
    renderMcpPage(
      {
        profiles: [
          {
            name: "future-profile",
            provider: "future-adapter",
            credentialAvailable: false,
          },
        ],
        pushes: [],
      },
      config,
      "chatgpt",
    ),
  );
  for (const text of [
    "ChatGPT &amp; Codex",
    "Connect with one click",
    "future-profile",
    "future-adapter",
    "Manual configuration",
    "Copy configuration",
    "Choose another AI client",
  ])
    assert.ok(markup.includes(text), text);
  assert.ok(!markup.includes("Test Novamira HQ locally"));
  assert.doesNotMatch(markup, /(?<!Novamira )\bHQ\b/);
});

test("one-click ChatGPT setup checks first, then uses the official codex command without a shell", async () => {
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit("close", calls.length === 1 ? 1 : 0));
    return child;
  };
  const service = createMcpConnectionService(
    { command: "/a path/node", args: ["/hq/index.js", "mcp"] },
    { NOVAMIRA_HQ_HOME: "/private/hq home" },
    fakeSpawn,
  );
  await service.connect("chatgpt");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "codex");
  assert.deepEqual(calls[0].args, ["mcp", "get", "novamira-hq"]);
  assert.deepEqual(calls[1].args, [
    "mcp",
    "add",
    "novamira-hq",
    "--env",
    "NOVAMIRA_HQ_HOME=/private/hq home",
    "--",
    "/a path/node",
    "/hq/index.js",
    "mcp",
  ]);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.stdio, "ignore");
});

test("standalone desktop never delegates its updater to npm", async () => {
  const updates = createDashboardUpdates({
    distribution: "desktop",
    createUpdateChecker: () => {
      throw new Error("must not inspect npm");
    },
  });
  await assert.rejects(updates.check(), /standalone desktop/);
  await assert.rejects(updates.install(), /standalone desktop/);
});

test("MCP rejects removed launch options instead of silently broadening access", () => {
  for (const option of ["--access", "--allow", "--deny"]) {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../dist/index.js", import.meta.url)),
        "mcp",
        option,
        "read",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(child.status, 0);
    assert.doesNotMatch(child.stdout, /"tools"/);
  }
});
