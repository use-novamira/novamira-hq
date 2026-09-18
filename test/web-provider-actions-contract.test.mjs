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
  providerActionGroups,
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

test("success copy is concise and suppresses only the redundant success notice", () => {
  const view = {
    profile: "test",
    provider: "instawp",
    capabilities: [],
    added: true,
  };
  const markup = renderHtml(
    renderProviderActionsPage(view, {
      level: "ok",
      message: "account saved and access verified",
    }),
  );
  assert.ok(markup.includes("Hosting account ready"));
  assert.ok(
    markup.includes("Here’s what you can do with this hosting account."),
  );
  assert.ok(
    markup.includes("Select a site in Sites to see its available actions."),
  );
  assert.ok(
    markup.includes(
      "Some actions depend on your hosting plan and permissions.",
    ),
  );
  assert.doesNotMatch(
    markup,
    /account saved and access verified|permanent hosting connection|Use Push|Requests run on demand/,
  );
  const warning = renderHtml(
    renderProviderActionsPage(view, {
      level: "warn",
      message: "Old credential could not be removed.",
    }),
  );
  assert.ok(warning.includes("Old credential could not be removed."));
});
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
  assert.doesNotMatch(markup, /POST \/technical|sites.delete|<table|GitHub/);
  assert.ok(
    markup.includes(
      "Connect your AI client, then ask it to perform these actions.",
    ),
  );
  assert.doesNotMatch(markup, /\bCLI\b|terminal/);
});

test("app and AI action groups reflect different exposed surfaces", () => {
  const groups = providerActionGroups({
    profile: "prod",
    provider: "kinsta",
    capabilities: [
      { name: "sites.list", supported: true },
      { name: "sites.get", supported: true },
      { name: "ops.get", supported: true },
      { name: "cache.clear", supported: true },
      { name: "sites.delete", supported: true },
    ],
  });
  assert.deepEqual(groups.app, ["Clear cache", "List sites"]);
  assert.deepEqual(groups.ai, [
    "Clear cache",
    "List sites",
    "View site details",
    "Check an operation’s progress",
  ]);
});

test("provider-specific wording and typed inspection limits remain accurate", () => {
  const cloudways = render(
    [
      { name: "activity.list", supported: true },
      { name: "logs.get", supported: true },
    ],
    "cloudways",
  );
  assert.ok(cloudways.includes("Read staging deployment activity"));
  assert.ok(!cloudways.includes("Read site logs"));
  const instawp = render(
    [
      { name: "backups.list", supported: true },
      { name: "backups.create", supported: true },
      { name: "backups.restore", supported: true },
    ],
    "instawp",
  );
  assert.ok(instawp.includes("Create a backup (InstaWP Site Versions)"));
  assert.ok(instawp.includes("Restore a backup (InstaWP Site Versions)"));
  const hostinger = render(
    [
      { name: "novamira.setup", supported: true },
      { name: "cache.clear", supported: true },
    ],
    "hostinger",
  );
  assert.ok(hostinger.includes("Install and set up Novamira"));
  assert.ok(!hostinger.includes("Clear cache"));
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
