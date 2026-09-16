// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { runMcpServer } from "../dist/mcp/index.js";
import { HQ_PUBLIC_CAPABILITIES } from "../dist/hosting/capabilities.js";
import { renderHtml } from "../dist/web/html.js";
import {
  ACTION_LABELS,
  ACTION_TOOLS,
  renderProviderActionsPage,
} from "../dist/web/views/provider-actions.js";

const render = (capabilities, provider = "kinsta") =>
  renderHtml(
    renderProviderActionsPage({
      profile: "My account",
      provider,
      capabilities,
    }),
  );
test("displayed actions correspond to public capabilities and exposed AI tools", async () => {
  assert.deepEqual(
    Object.keys(ACTION_LABELS).sort(),
    Object.keys(ACTION_TOOLS).sort(),
  );
  for (const name of Object.keys(ACTION_LABELS))
    assert.ok(HQ_PUBLIC_CAPABILITIES.has(name));
  const output = [];
  const requests = [
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
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  await runMcpServer(
    { version: "1.0.0" },
    {
      input: Readable.from(requests.map(JSON.stringify).join("\n") + "\n"),
      output: { write: (chunk) => output.push(chunk) },
    },
  );
  const response = output
    .join("")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .find((message) => message.id === 2);
  const names = new Set(response.result.tools.map((tool) => tool.name));
  for (const name of [
    ...Object.values(ACTION_TOOLS).flat(),
    "hosting_novamira_setup",
  ])
    assert.ok(names.has(name), name);
});

test("account actions show actual HQ support without raw adapter notes or comparisons", () => {
  const markup = render([
    { name: "cache.clear", supported: true, notes: "POST /technical-endpoint" },
    { name: "sites.list", supported: true },
    { name: "envs.push", supported: false },
    { name: "sites.delete", supported: true },
  ]);
  assert.ok(markup.includes("List sites"));
  assert.doesNotMatch(
    markup,
    /Clear the site cache|Push content between environments|Not available|deletion|SSH/,
  );
  assert.doesNotMatch(
    markup,
    /POST \/technical|sites.delete|<table|credential|GitHub/,
  );
  assert.ok(
    markup.includes("through your AI client rather than the dashboard"),
  );
  assert.doesNotMatch(markup, /\bCLI\b|terminal/);
});

test("setup, push and restore honor HQ workflow requirements", () => {
  const capabilities = [
    { name: "wp-cli.run", supported: true },
    { name: "envs.push", supported: true },
    { name: "backups.restore", supported: true },
  ];
  const kinsta = render(capabilities);
  assert.ok(kinsta.includes("Install and set up Novamira"));
  assert.ok(kinsta.includes("Push content between environments"));
  assert.ok(!kinsta.includes("Restore a backup"));
  const pressable = render(capabilities, "pressable");
  assert.doesNotMatch(
    pressable,
    /Install and set up Novamira|Push content between environments|Restore a backup/,
  );
  assert.ok(
    render([
      ...capabilities,
      { name: "backups.list", supported: true },
      { name: "backups.create", supported: true },
    ]).includes("Restore a backup"),
  );
});

test("invalid capability responses explain that the list could not be loaded", () => {
  for (const value of [
    undefined,
    {},
    [null],
    [{ name: "sites.list", supported: "yes" }],
  ]) {
    const markup = render(value);
    assert.ok(markup.includes("Available actions could not be loaded"));
    assert.ok(
      !markup.includes("Not available through this hosting integration"),
    );
  }
  const markup = renderHtml(
    renderProviderActionsPage({
      profile: "<script>alert(1)</script>",
      provider: "kinsta",
      capabilities: [],
    }),
  );
  assert.ok(!markup.includes("<script>alert"));
});
