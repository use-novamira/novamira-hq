// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  hostingInspectionOptions,
  inspectHosting,
} from "../dist/hosting/inspection.js";
import { renderHostingTools } from "../dist/web/views/hosting-tools.js";
import { renderHtml } from "../dist/web/html.js";
import { createHostingToolsHandler } from "../dist/web/handlers/hosting-tools.js";
import { registerSensitiveValues } from "../dist/output/redact.js";

const target = { siteId: "site-1", environmentId: "env-1" };
function fixture(provider = "kinsta", overrides = {}) {
  const calls = [];
  const client = {
    provider,
    read: async (request) => {
      calls.push(request);
      if (request.kind === "capabilities")
        return hostingInspectionOptions(provider).map(({ capability }) => ({
          name: capability,
          supported: true,
        }));
      return { entries: [{ name: "event", token: "secret-value" }] };
    },
    listEnvironments: async (id) => {
      calls.push({ site: id });
      return [{ id: target.environmentId }];
    },
    action: async (request) => {
      calls.push(request);
      return { status: 202, operationId: "op-1", provider, raw: {} };
    },
    ...overrides,
  };
  return { client, calls };
}

test("inspection support is explicit across all eight providers", () => {
  const expected = {
    kinsta: ["Cache", "Logs", "Provider activity", "Statistics", "Backups"],
    pressable: ["Cache", "Logs", "Provider activity", "Statistics", "Backups"],
    rocketnet: ["Cache", "Logs", "Provider activity", "Statistics", "Backups"],
    cloudways: ["Cache", "Provider activity", "Statistics"],
    pantheon: ["Cache", "Statistics", "Backups"],
    wpengine: ["Cache", "Backups"],
    instawp: ["Backups"],
    hostinger: [],
  };
  for (const [provider, sections] of Object.entries(expected))
    assert.deepEqual(
      [
        ...new Set(
          hostingInspectionOptions(provider).map((option) => option.section),
        ),
      ],
      sections,
    );
});

test("typed cache scopes dispatch no arbitrary native body and do not claim completion", async () => {
  for (const provider of [
    "kinsta",
    "pressable",
    "rocketnet",
    "cloudways",
    "wpengine",
    "pantheon",
  ]) {
    const { client, calls } = fixture(provider);
    const result = await inspectHosting(client, {
      ...target,
      option: "cache:site",
    });
    assert.deepEqual(calls.at(-1), {
      kind: "clear-cache",
      cache: "site",
      body: { environment_id: "env-1" },
    });
    assert.match(result.message, /not proof of completion/);
  }
});

test("unsupported, cross-site and malformed requests never mutate", async () => {
  for (const selection of [
    { ...target, option: "cache:delete" },
    { ...target, siteId: "../other", option: "cache:site" },
    { ...target, environmentId: "other", option: "cache:site" },
    { ...target, option: "logs:access", limit: 1001 },
    { ...target, option: "activity", offset: -1 },
  ]) {
    const { client, calls } = fixture();
    await assert.rejects(inspectHosting(client, selection));
    assert.ok(!calls.some((call) => call.kind === "clear-cache"));
  }
  const { client, calls } = fixture("kinsta", {
    read: async () => [{ name: "cache.clear", supported: false }],
  });
  await assert.rejects(
    inspectHosting(client, { ...target, option: "cache:site" }),
    { code: "provider_unsupported" },
  );
  assert.equal(calls.length, 0);
});

test("reads map parameters and redact before returning reports", async () => {
  const { client, calls } = fixture();
  const result = await inspectHosting(client, {
    ...target,
    option: "logs:error",
    limit: 35,
  });
  assert.deepEqual(calls.at(-1), {
    kind: "logs",
    envId: "env-1",
    fileName: "error",
    lines: 35,
  });
  assert.ok(!JSON.stringify(result).includes("secret-value"));
  await inspectHosting(
    client,
    { ...target, option: "analytics:visits" },
    Date.parse("2026-09-18T12:00:00Z"),
  );
  assert.deepEqual(calls.at(-1).query, [
    ["time_span", "24_hours"],
    ["from", "2026-09-17T12:00:00.000Z"],
    ["to", "2026-09-18T12:00:00.000Z"],
  ]);
  const activity = await inspectHosting(client, {
    ...target,
    option: "activity",
  });
  assert.match(activity.scope, /all sites/);
  assert.ok(!calls.at(-1).query.some(([key]) => key === "site_id"));
  await inspectHosting(client, { ...target, option: "backups" });
  assert.deepEqual(calls.at(-1), { kind: "backups", envId: "env-1" });
});

test("provider-specific queries do not invent metrics or broaden activity scope", async () => {
  const { client, calls } = fixture("cloudways");
  await inspectHosting(client, { ...target, option: "usage:usage" });
  assert.equal(calls.at(-1).metric, "");
  await inspectHosting(client, { ...target, option: "activity" });
  assert.deepEqual(calls.at(-1).query.at(-1), ["site_id", "site-1"]);
});

test("large reports are bounded and associated secrets removed before truncation", async () => {
  const { client } = fixture();
  const originalRead = client.read;
  client.read = async (request) => {
    if (request.kind === "capabilities") return originalRead(request);
    const value = { message: "known-private-value" + "x".repeat(210000) };
    registerSensitiveValues(value, ["known-private-value"]);
    return value;
  };
  const result = await inspectHosting(client, {
    ...target,
    option: "logs:access",
  });
  assert.equal(result.truncated, true);
  assert.equal(result.data.length, 200000);
  assert.ok(!result.data.includes("known-private-value"));
});

test("uncertain cache mutation is not retried", async () => {
  let actions = 0;
  const { client } = fixture("kinsta", {
    action: async () => {
      actions++;
      throw new Error("timeout");
    },
  });
  await assert.rejects(
    inspectHosting(client, { ...target, option: "cache:site" }),
    (error) =>
      error.retryable === false && /Verify at the provider/.test(error.message),
  );
  assert.equal(actions, 1);
});

test("a rejected cache action is never presented as accepted", async () => {
  const { client } = fixture("kinsta", {
    action: async () => ({
      provider: "kinsta",
      status: 500,
      operationId: "",
      raw: {},
    }),
  });
  await assert.rejects(
    inspectHosting(client, { ...target, option: "cache:site" }),
    { code: "provider_error", retryable: false },
  );
});

test("dashboard GET cannot clear cache, even with token", async () => {
  let called = false;
  const handler = createHostingToolsHandler({
    token: "test",
    loadConfigView: async () => ({
      profiles: [{ name: "account", provider: "kinsta" }],
      pushes: [],
      version: "test",
    }),
    hostingTools: {
      run: async () => {
        called = true;
      },
    },
  });
  const controller = new AbortController();
  const response = handler({
    method: "GET",
    query: new URLSearchParams({
      profile: "account",
      site: "site-1",
      env: "env-1",
      option: "cache:site",
    }),
    signal: controller.signal,
  });
  controller.abort();
  await response.run({ close() {} });
  assert.equal(called, false);
});

test("hosting page loads nothing automatically, escapes report content and offers copy", () => {
  const markup = renderHtml(
    renderHostingTools({
      target: { profile: "a", site: "s", env: "e" },
      provider: "pressable",
      selected: "logs:error",
      result: { data: "<script>alert(1)</script>" },
    }),
  );
  assert.ok(!markup.includes("data-init"));
  assert.match(markup, /Copy report/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /List backups/);
  assert.match(markup, /Clear object cache/);
  assert.match(markup, /hostingTools.loading/);
  assert.ok(!markup.includes("Restore backup"));
});
