// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  capabilityForCliArgv,
  parseMcpAccess,
  runMcpServer,
} from "../dist/mcp/index.js";

function request(id, method, params) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

async function session(lines, overrides = {}) {
  const output = [];
  const calls = [];
  const client = {
    provider: "kinsta",
    validate: async () => ({
      provider: "kinsta",
      status: "valid",
      companyId: "company-1",
      credential: "env:KINSTA_API_KEY",
    }),
    read: async (value) => {
      calls.push(value);
      return [{ name: "sites.list", supported: true }];
    },
    listSites: async (value) => {
      calls.push(value);
      return [
        { id: "site-1", name: "site", displayName: "Site", status: "live" },
      ];
    },
    getSite: async (siteId) => ({
      id: siteId,
      name: "site",
      displayName: "Site",
      status: "live",
    }),
    listEnvironments: async (siteId) => [
      {
        id: "env-1",
        name: siteId,
        displayName: "Live",
        isBlocked: false,
        isPremium: false,
      },
    ],
    operationStatus: async (operationId) => ({
      provider: "kinsta",
      operationId,
      status: 200,
      done: true,
      failed: false,
      raw: null,
    }),
    action: async () => {
      throw new Error("MCP exposes no generic mutation tool");
    },
    ...overrides.client,
  };
  await runMcpServer(
    {
      version: "1.2.3",
      store: {
        listHostingProfiles: async () => [
          {
            name: "production",
            profile: {
              provider: "kinsta",
              credential: { type: "env", name: "KINSTA_API_KEY" },
              companyId: "company-1",
            },
          },
        ],
      },
      hosting: {
        clientFromProfile: async (profile) => {
          calls.push(profile);
          return client;
        },
      },
      access: overrides.access ?? parseMcpAccess([]),
      executeCli: async (argv) => {
        calls.push(argv);
        return (
          overrides.executeCli?.(argv) ?? {
            exitCode: 0,
            stdout: '{"ok":true}\n',
            stderr: "",
          }
        );
      },
    },
    {
      input: Readable.from(`${lines.join("\n")}\n`),
      output: { write: (chunk) => output.push(chunk) },
    },
  );
  return {
    messages: output
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse),
    calls,
  };
}

const initialize = request(1, "initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "test", version: "1" },
});
const initialized = JSON.stringify({
  jsonrpc: "2.0",
  method: "notifications/initialized",
});

test("MCP negotiates lifecycle and exposes a read-only hosting surface", async () => {
  const { messages } = await session([
    initialize,
    initialized,
    request(2, "tools/list", {}),
  ]);
  assert.equal(messages[0].result.protocolVersion, "2025-11-25");
  assert.deepEqual(messages[0].result.capabilities, { tools: {} });
  assert.deepEqual(messages[0].result.serverInfo, {
    name: "novamira-hq",
    version: "1.2.3",
  });
  const names = messages[1].result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "hosting_profiles_list",
    "hosting_provider_validate",
    "hosting_capabilities_get",
    "hosting_sites_list",
    "hosting_site_get",
    "hosting_environments_list",
    "hosting_operation_get",
    "novamira_hq_cli",
  ]);
  assert.ok(
    messages[1].result.tools.every(
      (tool) => tool.inputSchema.additionalProperties === false,
    ),
  );
});

test("MCP tools call services directly and never reveal profile credentials", async () => {
  const { messages, calls } = await session([
    initialize,
    initialized,
    request(2, "tools/call", { name: "hosting_profiles_list", arguments: {} }),
    request(3, "tools/call", {
      name: "hosting_sites_list",
      arguments: { profile: "production", includeEnvironments: true },
    }),
  ]);
  const profiles = JSON.parse(messages[1].result.content[0].text);
  assert.deepEqual(profiles, [
    { name: "production", provider: "kinsta", companyId: "company-1" },
  ]);
  assert.ok(!messages[1].result.content[0].text.includes("KINSTA_API_KEY"));
  assert.deepEqual(calls, ["production", { includeEnvironments: true }]);
  assert.equal(messages[2].result.isError, undefined);
});

test("MCP access flags default to all and filter the advertised surface", async () => {
  assert.deepEqual([...parseMcpAccess([]).capabilities].sort(), [
    "config",
    "dashboard",
    "doctor",
    "hosting-read",
    "hosting-write",
    "provisioning",
    "skills",
    "update",
  ]);
  const policy = parseMcpAccess(["--access", "read", "--deny", "doctor"]);
  const { messages } = await session(
    [initialize, initialized, request(2, "tools/list", {})],
    { access: policy },
  );
  assert.deepEqual(
    messages[1].result.tools.map((tool) => tool.name),
    [
      "hosting_profiles_list",
      "hosting_provider_validate",
      "hosting_capabilities_get",
      "hosting_sites_list",
      "hosting_site_get",
      "hosting_environments_list",
      "hosting_operation_get",
      "novamira_hq_cli",
    ],
  );
  assert.equal(policy.capabilities.has("hosting-write"), false);
});

test("the CLI bridge enforces launch capabilities and returns captured output", async () => {
  assert.equal(
    capabilityForCliArgv(["--profile", "prod", "hosting", "sites", "list"]),
    "hosting-read",
  );
  assert.equal(
    capabilityForCliArgv(["hosting", "envs", "delete", "--env", "env-1"]),
    "hosting-write",
  );
  assert.equal(
    capabilityForCliArgv(["hosting", "novamira", "setup", "--env", "env-1"]),
    "provisioning",
  );

  const access = parseMcpAccess(["--allow", "hosting-read"]);
  const { messages, calls } = await session(
    [
      initialize,
      initialized,
      request(2, "tools/call", {
        name: "novamira_hq_cli",
        arguments: {
          argv: ["--profile", "prod", "hosting", "sites", "list", "--json"],
        },
      }),
      request(3, "tools/call", {
        name: "novamira_hq_cli",
        arguments: {
          argv: ["hosting", "envs", "delete", "--env", "env-1"],
        },
      }),
    ],
    { access },
  );
  assert.deepEqual(calls, [
    ["--profile", "prod", "hosting", "sites", "list", "--json"],
  ]);
  const success = JSON.parse(messages[1].result.content[0].text);
  assert.equal(success.capability, "hosting-read");
  assert.equal(success.exitCode, 0);
  assert.equal(messages[2].result.isError, true);
  assert.equal(
    JSON.parse(messages[2].result.content[0].text).code,
    "confirmation_required",
  );
});

test("the CLI bridge refuses stdin consumers because stdin belongs to MCP", async () => {
  const { messages } = await session([
    initialize,
    initialized,
    request(2, "tools/call", {
      name: "novamira_hq_cli",
      arguments: {
        argv: ["hosting", "wp-cli", "run", "--command-stdin"],
      },
    }),
  ]);
  assert.equal(messages[1].result.isError, true);
  assert.match(messages[1].result.content[0].text, /cannot read/);
});

test("MCP preserves stdout framing and returns expected tool failures as results", async () => {
  const { messages } = await session([
    "not json",
    request(9, "ping"),
    initialize,
    initialized,
    request(2, "tools/call", {
      name: "hosting_site_get",
      arguments: { profile: "production" },
    }),
    request(3, "unknown", {}),
  ]);
  assert.deepEqual(messages[0].error, { code: -32700, message: "Parse error" });
  assert.deepEqual(messages[1].result, {});
  assert.equal(messages[3].result.isError, true);
  assert.equal(
    JSON.parse(messages[3].result.content[0].text).code,
    "usage_error",
  );
  assert.deepEqual(messages[4].error, {
    code: -32601,
    message: "Method not found",
  });
});
