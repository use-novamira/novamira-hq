// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { runMcpServer } from "../dist/mcp/index.js";
import { CliError } from "../dist/errors.js";

function request(id, method, params) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function actionResult(action) {
  return {
    provider: "kinsta",
    action,
    status: 200,
    operationId: action,
    raw: null,
  };
}

const savedRoute = {
  name: "Publish",
  hostingProfile: "production",
  siteId: "site-1",
  siteLabel: "Site",
  sourceEnvId: "env-source",
  sourceEnvName: "Source",
  targetEnvId: "env-target",
  targetEnvName: "Target",
  pushDb: true,
  pushFiles: true,
  searchReplace: true,
};

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
      if (value.kind === "backups") return { backups: [{ id: 42 }] };
      return [
        { name: "envs.push", supported: true },
        { name: "backups.list", supported: true },
        { name: "backups.create", supported: true },
        { name: "backups.restore", supported: true },
        { name: "provider.internal-operation", supported: true },
      ];
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
    listEnvironments: async (siteId) => {
      calls.push({ listEnvironments: siteId });
      return [
        {
          id: "env-source",
          name: "source",
          displayName: "Source",
          isBlocked: false,
          isPremium: false,
        },
        {
          id: "env-target",
          name: "target",
          displayName: "Target",
          isBlocked: false,
          isPremium: false,
        },
      ];
    },
    operationStatus: async (operationId) => ({
      provider: "kinsta",
      operationId,
      status: 200,
      done: true,
      failed: false,
      raw: { state: "completed" },
    }),
    action: async (value) => {
      calls.push(value);
      return actionResult(
        value.kind === "create-backup"
          ? "backups.create"
          : value.kind === "restore-backup"
            ? "backups.restore"
            : "envs.push",
      );
    },
    ...overrides.client,
  };
  await runMcpServer(
    {
      version: "1.2.3",
      ...(overrides.onboarding ? { onboarding: overrides.onboarding } : {}),
      store: {
        listPushes: async () => [savedRoute],
        requireSavedPush: async (name) => {
          assert.equal(name, savedRoute.name);
          return savedRoute;
        },
        getSavedPush: async () => savedRoute,
        withSavedPushLock: async (_name, operation) => operation(),
        ...overrides.store,
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
      history: { list: async () => [] },
      ...(overrides.siteOperations
        ? { siteOperations: overrides.siteOperations }
        : {}),
      executeCli: async (argv) => {
        calls.push(argv);
        return (
          overrides.executeCli?.(argv) ?? {
            exitCode: 0,
            stdout: '{"ok":true,"data":{"handoff":"novamira auth login"}}\n',
            stderr: "",
          }
        );
      },
      ...(overrides.createPushConfirmationId === undefined
        ? {}
        : { createPushConfirmationId: overrides.createPushConfirmationId }),
      ...(overrides.createRestoreConfirmationId === undefined
        ? {}
        : {
            createRestoreConfirmationId: overrides.createRestoreConfirmationId,
          }),
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
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

test("typed inspection MCP tools dispatch bounded reads and cache mutations", async () => {
  const reads = [];
  const actions = [];
  const { messages } = await session(
    [
      initialize,
      initialized,
      request(2, "tools/call", {
        name: "hosting_inspection_options",
        arguments: { profile: "production" },
      }),
      request(3, "tools/call", {
        name: "hosting_logs_get",
        arguments: {
          profile: "production",
          siteId: "site-1",
          environmentId: "env-target",
          fileName: "error",
          limit: 25,
        },
      }),
      request(4, "tools/call", {
        name: "hosting_statistics_get",
        arguments: {
          profile: "production",
          siteId: "site-1",
          environmentId: "env-target",
          option: "usage:visits",
        },
      }),
      request(5, "tools/call", {
        name: "hosting_activity_list",
        arguments: {
          profile: "production",
          siteId: "site-1",
          environmentId: "env-target",
        },
      }),
      request(6, "tools/call", {
        name: "hosting_cache_clear",
        arguments: {
          profile: "production",
          siteId: "site-1",
          environmentId: "env-target",
          cache: "edge",
        },
      }),
      request(7, "tools/call", {
        name: "hosting_statistics_get",
        arguments: {
          profile: "production",
          siteId: "site-1",
          environmentId: "env-target",
          option: "cache:site",
        },
      }),
      request(8, "tools/call", {
        name: "hosting_logs_get",
        arguments: {
          profile: "production",
          siteId: "site-1",
          environmentId: "env-target",
          limit: "100",
        },
      }),
    ],
    {
      client: {
        read: async (value) => {
          reads.push(value);
          if (value.kind === "capabilities")
            return [
              "logs.get",
              "analytics.usage",
              "activity.list",
              "cache.clear",
            ].map((name) => ({ name, supported: true }));
          return { data: [{ message: "Bearer private-token-value" }] };
        },
        action: async (value) => {
          actions.push(value);
          return actionResult("cache.clear");
        },
      },
    },
  );
  for (const id of [2, 3, 4, 5, 6])
    assert.notEqual(
      messages.find((message) => message.id === id).result.isError,
      true,
    );
  for (const id of [7, 8])
    assert.equal(
      messages.find((message) => message.id === id).result.isError,
      true,
    );
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], {
    kind: "clear-cache",
    cache: "edge",
    body: { environment_id: "env-target" },
  });
  assert.ok(reads.some((value) => value.kind === "logs" && value.lines === 25));
  assert.ok(!JSON.stringify(messages).includes("private-token-value"));
});

test("MCP onboarding accepts only public URLs or an empty hosting request", async () => {
  const opened = [];
  const { messages } = await session(
    [
      initialize,
      initialized,
      request(2, "tools/call", {
        name: "novamira_hq_site_connect",
        arguments: { url: "https://example.test" },
      }),
      request(3, "tools/call", {
        name: "novamira_hq_hosting_connect",
        arguments: {},
      }),
      request(4, "tools/call", {
        name: "novamira_hq_hosting_connect",
        arguments: { apiKey: "never-reflect-this" },
      }),
      request(5, "tools/call", {
        name: "novamira_hq_site_connect",
        arguments: { url: "https://example.test/?token=never-reflect-this" },
      }),
      request(6, "tools/call", {
        name: "novamira_hq_site_connect",
        arguments: {
          url: "https://example.test",
          password: "never-reflect-this",
        },
      }),
    ],
    {
      onboarding: {
        open: async (target) => {
          opened.push(target);
          return {
            status: "awaiting_user_action",
            browserOpened: true,
            url: "http://127.0.0.1:1234/providers?new=host",
          };
        },
      },
    },
  );
  assert.equal(opened.length, 2);
  assert.equal(opened[0].kind, "site");
  assert.equal(opened[1].kind, "hosting");
  for (const id of [4, 5, 6])
    assert.equal(
      messages.find((message) => message.id === id).result.isError,
      true,
    );
  assert.equal(JSON.stringify(messages).includes("never-reflect-this"), false);
  assert.match(
    JSON.stringify(messages.find((message) => message.id === 2)),
    /awaiting_user_action/,
  );
});

test("WordPress MCP delegates structured operations to the optional site CLI", async () => {
  const seen = [];
  const { messages } = await session(
    [
      initialize,
      initialized,
      request(2, "tools/call", {
        name: "wordpress_run",
        arguments: {
          site: "example",
          ability: "novamira/test",
          input: { value: 1 },
        },
      }),
      request(3, "tools/call", {
        name: "wordpress_run",
        arguments: {
          site: "example",
          ability: "novamira/test",
          input: {},
          approveDestructive: "yes",
        },
      }),
    ],
    {
      siteOperations: {
        execute: async (operation) => {
          seen.push(operation);
          return { done: true };
        },
      },
    },
  );
  assert.deepEqual(seen, [
    {
      kind: "run",
      site: "example",
      ability: "novamira/test",
      input: { value: 1 },
      approveDestructive: false,
    },
  ]);
  assert.equal(messages[2].result.isError, true);
});

test("MCP clients can read built-in guidance and inventory without an installed skill", async () => {
  const { messages } = await session([
    initialize,
    initialized,
    request(2, "tools/call", { name: "novamira_hq_guide", arguments: {} }),
    request(3, "tools/call", { name: "novamira_hq_sites_list", arguments: {} }),
  ]);
  const guide = JSON.parse(messages[1].result.content[0].text);
  assert.equal(guide.version, "1.2.3");
  assert.match(guide.guide, /Claude Desktop, Claude Code/);
  const inventory = JSON.parse(messages[2].result.content[0].text);
  assert.equal(inventory.complete, false);
  assert.equal(inventory.sources[0].source, "wordpress");
  assert.equal(inventory.sources[0].status, "unavailable");
  assert.equal(inventory.sources[1].status, "ok");
});

test("MCP negotiates lifecycle and exposes the complete typed surface", async () => {
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
  const tools = messages[1].result.tools;
  assert.equal(
    tools.find((tool) => tool.name === "novamira_hq_guide").title,
    "Read the Novamira HQ guide",
  );
  assert.match(messages[0].result.instructions, /novamira_hq_guide/);
  assert.match(messages[0].result.instructions, /novamira_hq_sites_list/);
  assert.equal(
    tools.find((tool) => tool.name === "hosting_profiles_list").title,
    "List hosting accounts",
  );
  assert.ok(
    tools.every(
      (tool) =>
        tool.title &&
        tool.title !== tool.name &&
        tool.annotations.title === tool.title,
    ),
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "novamira_hq_site_connect",
      "novamira_hq_hosting_connect",
      "novamira_hq_guide",
      "novamira_hq_sites_list",
      "wordpress_sites_list",
      "wordpress_doctor",
      "wordpress_discover",
      "wordpress_describe",
      "wordpress_skill",
      "wordpress_run",
      "hosting_history_list",
      "hosting_profiles_list",
      "hosting_provider_validate",
      "hosting_capabilities_get",
      "hosting_sites_list",
      "hosting_site_get",
      "hosting_environments_list",
      "hosting_operation_get",
      "hosting_backups_list",
      "hosting_logs_get",
      "hosting_activity_list",
      "hosting_statistics_get",
      "hosting_cache_clear",
      "hosting_inspection_options",
      "hosting_backup_create",
      "hosting_novamira_setup",
      "hosting_push_routes_list",
      "hosting_environment_push_plan",
      "hosting_environment_push_apply",
      "hosting_backup_restore_plan",
      "hosting_backup_restore_apply",
    ],
  );
  assert.ok(
    tools.every((tool) => tool.inputSchema.additionalProperties === false),
  );
  assert.ok(
    tools.every(
      (tool) =>
        tool.annotations.openWorldHint ===
        !["hosting_history_list", "novamira_hq_guide"].includes(tool.name),
    ),
  );
  assert.equal(
    tools.some((tool) => tool.name === "novamira_hq_cli"),
    false,
  );
});

test("recovery is available by default and restores through a one-use guarded plan", async () => {
  const standard = await session([
    initialize,
    initialized,
    request(2, "tools/list", {}),
  ]);
  assert.equal(
    standard.messages[1].result.tools.some((tool) =>
      tool.name.startsWith("hosting_backup_restore_"),
    ),
    true,
  );

  const { messages, calls } = await session(
    [
      initialize,
      initialized,
      request(2, "tools/call", {
        name: "hosting_backup_restore_plan",
        arguments: {
          profile: "production",
          targetEnvironmentId: "env-target",
          backupId: "42",
          allContent: true,
          notifiedUserId: "user-7",
        },
      }),
      request(3, "tools/call", {
        name: "hosting_backup_restore_apply",
        arguments: { confirmationId: "restore-confirmation-id" },
      }),
      request(4, "tools/call", {
        name: "hosting_backup_restore_apply",
        arguments: { confirmationId: "restore-confirmation-id" },
      }),
    ],
    {
      createRestoreConfirmationId: () => "restore-confirmation-id",
    },
  );
  const planned = JSON.parse(messages[1].result.content[0].text);
  assert.equal(planned.confirmationId, "restore-confirmation-id");
  assert.equal(planned.plan.scope, "all-content");
  assert.ok(!("safetyBackup" in planned.plan));
  assert.equal(messages[2].result.isError, undefined);
  assert.equal(messages[3].result.isError, true);
  assert.equal(
    JSON.parse(messages[3].result.content[0].text).code,
    "not_found",
  );
  assert.deepEqual(calls, [
    "production",
    { kind: "capabilities" },
    { kind: "backups", envId: "env-target" },
    { kind: "capabilities" },
    { kind: "backups", envId: "env-target" },
    {
      kind: "restore-backup",
      targetEnvId: "env-target",
      body: { backup_id: 42, notified_user_id: "user-7" },
    },
  ]);
});

test("MCP reads hide credentials and operations outside HQ's surface", async () => {
  const { messages } = await session([
    initialize,
    initialized,
    request(2, "tools/call", { name: "hosting_profiles_list", arguments: {} }),
    request(3, "tools/call", {
      name: "hosting_capabilities_get",
      arguments: { profile: "production" },
    }),
  ]);
  const profiles = JSON.parse(messages[1].result.content[0].text);
  assert.deepEqual(profiles, [
    { name: "production", provider: "kinsta", companyId: "company-1" },
  ]);
  assert.ok(!messages[1].result.content[0].text.includes("KINSTA_API_KEY"));
  const capabilities = JSON.parse(messages[2].result.content[0].text);
  assert.equal(
    capabilities.some((item) => item.name === "provider.internal-operation"),
    false,
  );
});

test("maintenance and provisioning are fixed typed mutations", async () => {
  const { messages, calls } = await session([
    initialize,
    initialized,
    request(2, "tools/call", {
      name: "hosting_backup_create",
      arguments: {
        profile: "production",
        environmentId: "env-target",
        tag: "before upgrade",
      },
    }),
    request(3, "tools/call", {
      name: "hosting_novamira_setup",
      arguments: {
        profile: "production",
        environmentId: "env-target",
        url: "https://example.test",
        enableAiAbilities: true,
      },
    }),
  ]);
  assert.deepEqual(calls, [
    "production",
    {
      kind: "create-backup",
      envId: "env-target",
      body: { tag: "before upgrade" },
    },
    [
      "--profile",
      "production",
      "--json",
      "--quiet",
      "hosting",
      "novamira",
      "setup",
      "--env",
      "env-target",
      "--url",
      "https://example.test",
      "--ai-abilities",
    ],
  ]);
  assert.equal(messages[1].result.isError, undefined);
  assert.equal(messages[2].result.isError, undefined);
});

test("AI setup requires positive approval before any CLI or provider call", async () => {
  for (const approval of [undefined, false]) {
    const { messages, calls } = await session([
      initialize,
      initialized,
      request(2, "tools/call", {
        name: "hosting_novamira_setup",
        arguments: {
          profile: "production",
          environmentId: "env-target",
          ...(approval === undefined ? {} : { enableAiAbilities: approval }),
        },
      }),
    ]);
    assert.deepEqual(calls, []);
    assert.ok(messages.at(-1).error || messages.at(-1).result?.isError);
  }
});

test("push uses a one-use plan and invokes only the provider-native push", async () => {
  const { messages, calls } = await session(
    [
      initialize,
      initialized,
      request(2, "tools/call", {
        name: "hosting_environment_push_plan",
        arguments: {
          route: "Publish",
        },
      }),
      request(3, "tools/call", {
        name: "hosting_environment_push_apply",
        arguments: { confirmationId: "fixed-confirmation-id" },
      }),
      request(4, "tools/call", {
        name: "hosting_environment_push_apply",
        arguments: { confirmationId: "fixed-confirmation-id" },
      }),
    ],
    { createPushConfirmationId: () => "fixed-confirmation-id" },
  );
  const planned = JSON.parse(messages[1].result.content[0].text);
  assert.equal(planned.confirmationId, "fixed-confirmation-id");
  assert.ok(!("safetyBackup" in planned.plan));
  assert.equal(messages[2].result.isError, undefined);
  assert.equal(messages[3].result.isError, true);
  assert.equal(
    JSON.parse(messages[3].result.content[0].text).code,
    "not_found",
  );
  assert.deepEqual(calls, [
    "production",
    { kind: "capabilities" },
    { listEnvironments: "site-1" },
    { kind: "capabilities" },
    { listEnvironments: "site-1" },
    {
      kind: "push-environment",
      siteId: "site-1",
      body: {
        source_env_id: "env-source",
        target_env_id: "env-target",
        push_db: true,
        push_files: true,
        push_files_option: "ALL_FILES",
        run_search_and_replace: true,
      },
    },
  ]);
});

test("push rejects an empty implicit scope before any mutation", async () => {
  const { messages, calls } = await session(
    [
      initialize,
      initialized,
      request(2, "tools/call", {
        name: "hosting_environment_push_plan",
        arguments: {
          profile: "production",
          siteId: "site-1",
          sourceEnvironmentId: "env-source",
          targetEnvironmentId: "env-target",
        },
      }),
    ],
    {},
  );
  assert.equal(messages[1].result.isError, true);
  assert.equal(
    JSON.parse(messages[1].result.content[0].text).code,
    "usage_error",
  );
  assert.deepEqual(calls, []);
});

test("push lists saved routes without provider access", async () => {
  const { messages, calls } = await session([
    initialize,
    initialized,
    request(2, "tools/call", {
      name: "hosting_push_routes_list",
      arguments: {},
    }),
  ]);
  assert.deepEqual(JSON.parse(messages[1].result.content[0].text), [
    savedRoute,
  ]);
  assert.deepEqual(calls, []);
});

test("push refuses changed or removed routes and consumes their confirmations", async () => {
  for (const current of [
    undefined,
    { ...savedRoute, pushDb: false },
    { ...savedRoute, targetEnvId: "other" },
  ]) {
    const { messages, calls } = await session(
      [
        initialize,
        initialized,
        request(2, "tools/call", {
          name: "hosting_environment_push_plan",
          arguments: { route: "Publish" },
        }),
        request(3, "tools/call", {
          name: "hosting_environment_push_apply",
          arguments: { confirmationId: "fixed" },
        }),
        request(4, "tools/call", {
          name: "hosting_environment_push_apply",
          arguments: { confirmationId: "fixed" },
        }),
      ],
      {
        createPushConfirmationId: () => "fixed",
        store: { getSavedPush: async () => current },
      },
    );
    assert.equal(
      JSON.parse(messages[2].result.content[0].text).code,
      "conflict",
    );
    assert.equal(
      JSON.parse(messages[3].result.content[0].text).code,
      "not_found",
    );
    assert.ok(!calls.some((call) => call.kind === "push-environment"));
  }
});

test("push cannot override a saved route", async () => {
  const { messages, calls } = await session([
    initialize,
    initialized,
    request(2, "tools/call", {
      name: "hosting_environment_push_plan",
      arguments: { route: "Publish", database: false },
    }),
  ]);
  assert.equal(messages[1].result.isError, true);
  assert.deepEqual(calls, []);
});

test("push rejects a missing saved route without contacting hosting", async () => {
  const { messages, calls } = await session(
    [
      initialize,
      initialized,
      request(2, "tools/call", {
        name: "hosting_environment_push_plan",
        arguments: { route: "Missing" },
      }),
    ],
    {
      store: {
        requireSavedPush: async () => {
          throw new CliError("not_found", "Missing route");
        },
      },
    },
  );
  assert.equal(
    JSON.parse(messages[1].result.content[0].text).code,
    "not_found",
  );
  assert.deepEqual(calls, []);
});

test("generic and unknown tools are not callable even by name", async () => {
  const { messages, calls } = await session(
    [
      initialize,
      initialized,
      request(2, "tools/call", {
        name: "novamira_hq_cli",
        arguments: { argv: ["hosting", "backups", "delete", "42"] },
      }),
      request(3, "tools/call", {
        name: "unknown_tool",
        arguments: {},
      }),
    ],
    {},
  );
  assert.deepEqual(messages[1].error, {
    code: -32602,
    message: "Unknown tool",
  });
  assert.deepEqual(messages[2].error, {
    code: -32602,
    message: "Unknown tool",
  });
  assert.deepEqual(calls, []);
});

test("MCP preserves framing and expected argument failures are tool results", async () => {
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
