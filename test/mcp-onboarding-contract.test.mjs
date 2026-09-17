// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { mcpMain } from "../dist/mcp/main.js";
import {
  createMcpOnboarding,
  onboardingSiteUrl,
} from "../dist/mcp/onboarding.js";

test("MCP production wiring starts the real consent-gated dashboard and closes it at EOF", async () => {
  const home = await mkdtemp(join(tmpdir(), "hq-mcp-onboarding-"));
  let opened;
  let output = "";
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
      params: { name: "novamira_hq_hosting_connect", arguments: {} },
    },
  ];
  try {
    await mcpMain(
      [],
      {
        input: Readable.from(lines.map((line) => JSON.stringify(line) + "\n")),
        output: {
          write: (chunk) => {
            output += chunk;
          },
        },
      },
      { NOVAMIRA_HQ_HOME: home, PATH: "" },
      {
        openBrowser: async (url) => {
          opened = url;
          const response = await fetch(url);
          assert.equal(response.status, 200);
          const page = await response.text();
          assert.match(page, /Novamira HQ/);
          assert.equal(
            page.includes('data-bind="providerForm.credentialValue"'),
            false,
          );
        },
      },
    );
    assert.ok(opened);
    assert.match(output, /awaiting_user_action/);
    const reply = output
      .trim()
      .split("\n")
      .map(JSON.parse)
      .find((message) => message.id === 2);
    assert.equal(JSON.parse(reply.result.content[0].text).browserOpened, true);
    await assert.rejects(fetch(opened));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("onboarding starts lazily, shares a session listener and opens only local forms", async () => {
  let starts = 0;
  const opened = [];
  const service = createMcpOnboarding({
    start: async () => {
      starts++;
      return "http://127.0.0.1:12345";
    },
    openBrowser: async (url) => opened.push(url),
  });
  assert.equal(starts, 0);
  const results = await Promise.all([
    service.open({ kind: "hosting" }),
    service.open({ kind: "site", url: "https://example.test/blog" }),
  ]);
  assert.equal(starts, 1);
  assert.equal(opened[0], "http://127.0.0.1:12345/providers?new=host");
  const site = new URL(opened[1]);
  assert.equal(site.pathname, "/sites");
  assert.equal(site.searchParams.get("new"), "cli");
  assert.equal(site.searchParams.get("site_url"), "https://example.test/blog");
  assert.ok(
    results.every(
      (result) =>
        result.status === "awaiting_user_action" && result.browserOpened,
    ),
  );
});

test("onboarding browser failure offers the local URL without claiming connection", async () => {
  const service = createMcpOnboarding({
    start: async () => "http://127.0.0.1:12345",
    openBrowser: async () => {
      throw new Error("secret diagnostic");
    },
  });
  const result = await service.open({ kind: "hosting" });
  assert.equal(result.browserOpened, false);
  assert.equal(result.status, "awaiting_user_action");
  assert.equal(JSON.stringify(result).includes("secret diagnostic"), false);
});

test("onboarding refuses secret-bearing input before opening anything", async () => {
  for (const url of [
    "",
    "https://user:secret@example.test",
    "https://example.test/?token=secret",
    "https://example.test/#secret",
    "javascript:secret",
    "https://example.test/".repeat(300),
  ]) {
    assert.throws(
      () => onboardingSiteUrl(url),
      (error) =>
        error.code === "usage_error" &&
        !JSON.stringify(error).includes("secret"),
    );
  }
});

test("onboarding refuses external or credential-bearing dashboard addresses", async () => {
  for (const url of [
    "https://example.test",
    "http://127.0.0.1:1234/?token=secret",
    "http://user:secret@127.0.0.1:1234",
  ]) {
    const service = createMcpOnboarding({
      start: async () => url,
      openBrowser: async () => assert.fail("must not open"),
    });
    await assert.rejects(service.open({ kind: "hosting" }), {
      code: "internal_error",
    });
  }
});

test("onboarding can retry a failed startup without leaking its error", async () => {
  let starts = 0;
  const service = createMcpOnboarding({
    start: async () => {
      if (++starts === 1) throw new Error("secret");
      return "http://127.0.0.1:12345";
    },
    openBrowser: async () => {},
  });
  await assert.rejects(
    service.open({ kind: "hosting" }),
    (error) =>
      error.code === "internal_error" && !error.message.includes("secret"),
  );
  await service.open({ kind: "hosting" });
  assert.equal(starts, 2);
});
