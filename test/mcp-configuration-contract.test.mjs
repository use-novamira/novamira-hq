// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("MCP page renders dynamic profiles and never claims an external connection", () => {
  const config = createMcpConnectionService(
    { command: "/a path/node", args: ["/hq/index.js", "mcp"] },
    {},
  ).configuration();
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
        deployPaths: [],
      },
      config,
    ),
  );
  for (const text of [
    "Claude Desktop",
    "ChatGPT Desktop",
    "future-profile",
    "future-adapter",
    "Copy configuration",
    "does not prove",
    "Verify local MCP startup",
  ])
    assert.ok(markup.includes(text), text);
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
