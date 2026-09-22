// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createMcpConnectionService } from "../dist/mcp/configuration.js";
import { renderHtml } from "../dist/web/html.js";
import {
  MCP_PAGE_CLIENTS,
  isMcpPageClient,
  renderMcpPage,
} from "../dist/web/views/mcp.js";

const configuration = createMcpConnectionService(
  { command: "novamira-hq", args: ["mcp"] },
  {
    PATH: "/example path/bin",
    NOVAMIRA_HQ_HOME: "/example home/日本語",
    KINSTA_API_KEY: "never-copy",
  },
).configuration();
const page = (client) => renderHtml(renderMcpPage({}, configuration, client));
const unescape = (value) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

test("each AI client has a dedicated choice and closed manual fallback", () => {
  const choice = page();
  assert.ok(choice.includes("Choose how you use your AI assistant."));
  assert.ok(choice.includes("Claude Code CLI"));
  assert.ok(choice.includes("VS Code · GitHub Copilot"));
  assert.doesNotMatch(choice, /Choose the app|Claude Code in VS Code/);
  for (const client of MCP_PAGE_CLIENTS) {
    assert.ok(isMcpPageClient(client));
    assert.ok(choice.includes(`/configure-ai?client=${client}`));
    const markup = page(client);
    assert.ok(markup.includes('<details class="mcp-manual">'));
    assert.ok(
      markup.indexOf('class="mcp-primary-action"') <
        markup.indexOf('class="mcp-manual"'),
    );
    assert.doesNotMatch(markup, /never-copy|KINSTA_API_KEY/);
    assert.doesNotMatch(markup, /Open client documentation/);
    assert.ok(markup.includes("Show me my sites in Novamira HQ."));
  }
  assert.equal(isMcpPageClient("unknown"), false);
  assert.equal(isMcpPageClient(null), false);
  assert.doesNotMatch(choice, /ChatGPT &amp; Codex|Copy configuration/);
  assert.doesNotMatch(page("claude"), /Using Claude Code/);
  assert.ok(page("claude-code").includes("client=claude-code"));
  assert.ok(page("codex").includes("client=codex"));
  assert.ok(page("opencode").includes("opencode mcp add"));
});

test("Cursor install link round-trips the launch and non-secret environment", () => {
  const markup = page("cursor");
  const link = new URL(unescape(markup.match(/href="(cursor:[^"]+)"/)[1]));
  assert.equal(link.hostname, "anysphere.cursor-deeplink");
  assert.equal(link.pathname, "/mcp/install");
  assert.equal(link.searchParams.get("name"), "novamira-hq");
  assert.deepEqual(
    JSON.parse(
      Buffer.from(link.searchParams.get("config"), "base64").toString("utf8"),
    ),
    JSON.parse(configuration.claude).mcpServers["novamira-hq"],
  );
});

test("VS Code and OpenCode use their own schemas without losing launch settings", () => {
  const config = (client) =>
    JSON.parse(
      unescape(
        page(client).match(
          /<pre class="mcp-config"><code>([\s\S]*?)<\/code>/,
        )[1],
      ),
    );
  const vscode = config("vscode").servers["novamira-hq"];
  assert.equal(vscode.type, "stdio");
  assert.equal(vscode.command, "novamira-hq");
  assert.deepEqual(vscode.args, ["mcp"]);
  assert.equal(vscode.env.PATH, undefined);
  assert.deepEqual(
    vscode.args,
    JSON.parse(configuration.claude).mcpServers["novamira-hq"].args,
  );
  const opencode = config("opencode").mcp["novamira-hq"];
  assert.equal(opencode.type, "local");
  assert.deepEqual(opencode.command, [vscode.command, ...vscode.args]);
  assert.deepEqual(opencode.environment, vscode.env);
});

test("VS Code one-click setup uses official argv without shell or probe meant for other clients", async () => {
  const calls = [];
  const service = createMcpConnectionService(
    configuration.launch,
    { NOVAMIRA_HQ_HOME: "/example path" },
    (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  );
  await service.connect("vscode");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "code");
  assert.equal(calls[0].args[0], "--add-mcp");
  assert.equal(JSON.parse(calls[0].args[1]).name, "novamira-hq");
  assert.equal(
    JSON.parse(calls[0].args[1]).env.NOVAMIRA_HQ_HOME,
    "/example path",
  );
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, "ignore");
});
