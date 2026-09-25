// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { envCredential } from "../dist/config/schema.js";
import { SecretValue } from "../dist/credentials/resolve.js";
import { createHttpClient } from "../dist/hosting/http-client.js";
import {
  executeBackupRestore,
  prepareBackupRestore,
} from "../dist/hosting/backup-restore.js";
import { createPleskClient } from "../dist/hosting/providers/plesk.js";
import { secretSafeProviderClient } from "../dist/hosting/redaction.js";
import { historyClient } from "../dist/history/client.js";
import {
  executeEnvironmentPush,
  prepareEnvironmentPush,
} from "../dist/hosting/environment-push.js";

const KEY = "plesk-fake-api-key-not-a-secret";
const BASE = "https://panel.example.invalid:8443";
const DOMAIN = {
  id: 2,
  name: "wordpress.example.test",
  ascii_name: "wordpress.example.test",
  hosting_type: "virtual",
};
const BACKUP = {
  fileName: "wordpress.example.test__2026-09-24T15_40_38+0000.zip",
  fileSize: 1024,
  createDate: "2026-09-24T15:40:38+00:00",
  absoluteFilePath:
    "/var/www/vhosts/wordpress.example.test/wordpress-backups/test.zip",
};
const INSTANCE = {
  id: 7,
  mainDomainId: 2,
  name: "Test WordPress",
  siteUrl: "https://wordpress.example.test",
  version: "6.9.0",
  alive: true,
};
const TARGET_DOMAIN = {
  ...DOMAIN,
  id: 4,
  name: "target.example.test",
  ascii_name: "target.example.test",
};
const TARGET_INSTANCE = {
  ...INSTANCE,
  id: 8,
  mainDomainId: 4,
  name: "Target WordPress",
  siteUrl: "https://target.example.test",
};

function fixture(options = {}) {
  const calls = [];
  let plugin = options.plugin ?? null;
  const settings = new Map();
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      url: url.href,
      key: new Headers(init.headers).get("x-api-key"),
      body,
    });
    const params = body?.params ?? [];
    const wpCliIndex = params.indexOf("--wp-cli");
    const wpArgs =
      wpCliIndex === -1 ? [] : params.slice(params.indexOf("--") + 1);
    let cliOutput;
    if (wpCliIndex !== -1) {
      if (wpArgs[0] === "eval") cliOutput = "8.4.25";
      else if (wpArgs[0] === "plugin" && wpArgs[1] === "list")
        cliOutput = JSON.stringify(plugin ? [plugin] : []);
      else if (wpArgs[0] === "plugin" && wpArgs[1] === "install") {
        plugin = { name: "novamira", status: "inactive", version: "1.12.5" };
        cliOutput = "Success: Plugin installed.";
      } else if (wpArgs[0] === "plugin" && wpArgs[1] === "activate") {
        plugin = { ...plugin, status: "active" };
        cliOutput = "Success: Plugin activated.";
      } else if (wpArgs[0] === "option" && wpArgs[1] === "update") {
        settings.set(wpArgs[2], wpArgs[3]);
        cliOutput = "Success: Updated option.";
      } else if (wpArgs[0] === "option" && wpArgs[1] === "get")
        cliOutput = settings.get(wpArgs[2]) ?? "";
      else throw new Error(`Unexpected WP-CLI command: ${wpArgs.join(" ")}`);
    }
    const payload =
      url.pathname === "/api/v2/domains"
        ? [
            DOMAIN,
            { ...DOMAIN, id: 3, hosting_type: "none" },
            ...(options.crossSite ? [TARGET_DOMAIN] : []),
          ]
        : url.pathname === "/api/v2/domains/2"
          ? DOMAIN
          : url.pathname === "/api/v2/domains/4" && options.crossSite
            ? TARGET_DOMAIN
            : url.pathname === "/api/v2/extensions"
              ? options.toolkit
                ? [{ id: "wp-toolkit", active: true }]
                : []
              : url.pathname === "/api/v2/cli/extension/call"
                ? {
                    code: 0,
                    stdout:
                      cliOutput ??
                      JSON.stringify(
                        params.includes("--list")
                          ? options.crossSite
                            ? [INSTANCE, TARGET_INSTANCE]
                            : [INSTANCE]
                          : params.includes("list")
                            ? [BACKUP]
                            : params.includes("backup")
                              ? { backupFilename: BACKUP.fileName }
                              : { restored: true },
                      ),
                    stderr: "",
                  }
                : { error: "unexpected path" };
    return new Response(JSON.stringify(payload), {
      status: url.pathname.startsWith("/api/v2/") ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  };
  const baseUrl = options.baseUrl ?? BASE;
  const client = createPleskClient({
    provider: "plesk",
    providerLabel: "Plesk",
    profileName: "test",
    profile: {
      provider: "plesk",
      credential: envCredential("PLESK_API_KEY"),
      ...(options.missingUrl ? {} : { apiBaseUrl: baseUrl }),
    },
    baseUrl,
    secret: new SecretValue(KEY, "env", "env:PLESK_API_KEY"),
    credentialSource: "env:PLESK_API_KEY",
    companyId: undefined,
    identity: undefined,
    tokenUrl: undefined,
    env: {},
    createHttpClient(overrides = {}) {
      return createHttpClient({
        baseUrl,
        providerLabel: "Plesk",
        fetch,
        retry: { maxAttempts: 1 },
        ...overrides,
      });
    },
  });
  return { client, calls, settings };
}

test("Plesk validates and lists virtual domains without implying WordPress", async () => {
  const { client, calls } = fixture();
  assert.deepEqual(await client.validate(), {
    provider: "plesk",
    status: "active",
    companyId: null,
    credential: "env:PLESK_API_KEY",
  });
  assert.deepEqual(await client.listSites(), [
    {
      id: "2",
      name: DOMAIN.name,
      displayName: DOMAIN.name,
      status: "unknown",
      primaryDomain: DOMAIN.name,
    },
  ]);
  const withEnvironments = await client.listSites({
    includeEnvironments: true,
  });
  assert.deepEqual(withEnvironments[0].environments, [
    {
      id: "domain:2",
      name: "live",
      displayName: "Live",
      isBlocked: false,
      isPremium: false,
      primaryDomain: DOMAIN.name,
    },
  ]);
  assert.deepEqual(
    await client.listEnvironments("2"),
    withEnvironments[0].environments,
  );
  assert.deepEqual(await client.getSite("2"), withEnvironments[0]);
  assert.ok(calls.length >= 4);
  assert.ok(calls.every((call) => call.key === KEY));
  assert.ok(calls.every((call) => !call.url.includes(KEY)));
});

test("Plesk never exposes backup, restore or setup before verification", async () => {
  const { client, calls } = fixture();
  const capabilities = await client.read({ kind: "capabilities" });
  for (const name of [
    "novamira.setup",
    "backups.list",
    "backups.create",
    "backups.restore",
    "envs.push",
  ]) {
    assert.equal(
      capabilities.find((item) => item.name === name)?.supported,
      false,
    );
  }
  await assert.rejects(client.read({ kind: "backups", envId: "2" }), {
    code: "provider_unsupported",
  });
  await assert.rejects(client.action({ kind: "create-backup", envId: "2" }), {
    code: "provider_unsupported",
  });
  await assert.rejects(
    client.action({
      kind: "restore-backup",
      targetEnvId: "2",
      body: { backup_id: "1" },
    }),
    { code: "provider_unsupported" },
  );
  await assert.rejects(client.action({ kind: "setup-novamira", envId: "2" }), {
    code: "provider_unsupported",
  });
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.url.endsWith("/api/v2/extensions")));
});

test("Plesk backup and restore use only the target WP Toolkit catalog", async () => {
  const { client, calls } = fixture({ toolkit: true });
  const capabilities = await client.read({ kind: "capabilities" });
  for (const name of ["backups.list", "backups.create", "backups.restore"])
    assert.equal(
      capabilities.find((item) => item.name === name)?.supported,
      true,
    );
  const sites = await client.listSites({ includeEnvironments: true });
  assert.equal(sites[0].environments[0].id, "wp:7");
  assert.equal(sites[0].environments[0].primaryDomain, INSTANCE.siteUrl);
  const catalog = await client.read({ kind: "backups", envId: "wp:7" });
  assert.equal(catalog.backups[0].id, BACKUP.fileName);
  assert.ok(!JSON.stringify(catalog).includes(BACKUP.absoluteFilePath));
  const created = await client.action({ kind: "create-backup", envId: "wp:7" });
  assert.equal(created.raw.backup_id, BACKUP.fileName);
  assert.equal((await client.operationStatus(created.operationId)).done, true);
  const plan = await prepareBackupRestore(client, {
    targetEnvironmentId: "wp:7",
    backupId: BACKUP.fileName,
    allContent: true,
  });
  const restored = await executeBackupRestore(client, plan);
  assert.equal(restored.restore.action, "backups.restore");
  assert.equal(restored.restoreStatus.done, true);
  const commands = calls
    .filter((call) => call.url.endsWith("/api/v2/cli/extension/call"))
    .map((call) => call.body.params);
  assert.ok(
    commands.every(
      (params) => params[0] === "--call" && params[1] === "wp-toolkit",
    ),
  );
  assert.ok(
    commands.some(
      (params) =>
        params.includes("restore") && params.includes(BACKUP.fileName),
    ),
  );
  assert.ok(commands.every((params) => !params.includes("pleskbackup")));
});

test("Plesk copies explicitly selected files across domains through native WP Toolkit", async () => {
  const { client, calls } = fixture({ toolkit: true, crossSite: true });
  const safeClient = secretSafeProviderClient(client);
  const wrappedClient = historyClient(
    safeClient,
    "plesk-test",
    {
      begin: async () => "request-1",
      finish: async () => {},
      list: async () => [],
    },
    () => "cli",
  );
  const plan = await prepareEnvironmentPush(wrappedClient, {
    siteId: "2",
    sourceEnvironmentId: "wp:7",
    targetEnvironmentId: "wp:8",
    database: false,
    allFiles: true,
    files: [],
    searchReplace: false,
  });
  assert.equal(plan.source.primaryDomain, INSTANCE.siteUrl);
  assert.equal(plan.target.primaryDomain, TARGET_INSTANCE.siteUrl);
  const result = await executeEnvironmentPush(wrappedClient, plan);
  assert.equal(result.pushStatus.done, true);
  const copy = calls.find((call) => call.body?.params?.includes("--copy-data"));
  assert.deepEqual(copy.body.params, [
    "--call",
    "wp-toolkit",
    "--copy-data",
    "-source-instance-id",
    "7",
    "-target-instance-id",
    "8",
    "-data-to-copy",
    "files",
    "-files-remove-missing",
    "no",
    "-create-restore-point",
    "no",
    "-format",
    "json",
  ]);
  assert.ok(!copy.body.params.includes("--backup"));
});

test("Plesk refuses selected files and separate search-replace before copy", async () => {
  const { client, calls } = fixture({ toolkit: true, crossSite: true });
  const base = {
    siteId: "2",
    sourceEnvironmentId: "wp:7",
    targetEnvironmentId: "wp:8",
    database: true,
    allFiles: false,
    files: [],
    searchReplace: false,
  };
  await assert.rejects(
    prepareEnvironmentPush(client, { ...base, searchReplace: true }),
    {
      code: "provider_unsupported",
    },
  );
  await assert.rejects(
    prepareEnvironmentPush(client, { ...base, files: ["wp-content"] }),
    {
      code: "provider_unsupported",
    },
  );
  assert.ok(!calls.some((call) => call.body?.params?.includes("--copy-data")));
});

test("Plesk rejects a source outside its selected domain before sending copy", async () => {
  const { client, calls } = fixture({ toolkit: true, crossSite: true });
  await assert.rejects(
    client.action({
      kind: "push-environment",
      siteId: "2",
      body: {
        source_env_id: "wp:8",
        target_env_id: "wp:7",
        push_db: true,
        push_files: false,
        run_search_and_replace: false,
      },
    }),
    { code: "not_found" },
  );
  assert.ok(!calls.some((call) => call.body?.params?.includes("--copy-data")));
});

test("Plesk maps database-only and combined scopes to all tables without implicit backups", async () => {
  for (const [database, allFiles, expected] of [
    [true, false, "db"],
    [true, true, "all"],
  ]) {
    const { client, calls } = fixture({ toolkit: true, crossSite: true });
    const plan = await prepareEnvironmentPush(client, {
      siteId: "2",
      sourceEnvironmentId: "wp:7",
      targetEnvironmentId: "wp:8",
      database,
      allFiles,
      files: [],
      searchReplace: false,
    });
    await executeEnvironmentPush(client, plan);
    const commands = calls
      .filter((call) => call.body?.params)
      .map((call) => call.body.params);
    const copy = commands.find((params) => params.includes("--copy-data"));
    assert.equal(copy[copy.indexOf("-data-to-copy") + 1], expected);
    assert.equal(copy[copy.indexOf("-db-tables-copy-mode") + 1], "all");
    assert.ok(!commands.some((params) => params.includes("--backup")));
  }
});

test("Plesk setup installs the official Free plugin through WP Toolkit and verifies activation", async () => {
  const { client, calls, settings } = fixture({ toolkit: true });
  const result = await client.action({ kind: "setup-novamira", envId: "wp:7" });
  assert.deepEqual(result.raw, {
    siteUrl: INSTANCE.siteUrl,
    version: "1.12.5",
    aiEnabled: true,
    warnings: [],
  });
  assert.equal(
    settings.get("novamira_ai_abilities_domain"),
    "wordpress.example.test",
  );
  assert.equal(settings.get("novamira_ai_abilities_enabled"), "1");
  const commands = calls
    .filter((call) => call.url.endsWith("/api/v2/cli/extension/call"))
    .map((call) => call.body.params);
  const wpCommands = commands.filter((params) => params.includes("--wp-cli"));
  assert.ok(
    wpCommands.every(
      (params) =>
        params.slice(0, 6).join(" ") ===
        "--call wp-toolkit --wp-cli -instance-id 7 --",
    ),
  );
  assert.ok(
    wpCommands.some(
      (params) =>
        params.includes("install") &&
        params.some((arg) => arg.startsWith("https://")),
    ),
  );
  assert.ok(
    wpCommands.some(
      (params) => params.includes("activate") && params.includes("novamira"),
    ),
  );
  assert.ok(wpCommands.filter((params) => params.includes("list")).length >= 3);
});

test("Plesk setup preserves an existing active installation and its AI settings", async () => {
  const { client, calls, settings } = fixture({
    toolkit: true,
    plugin: { name: "novamira", status: "active", version: "1.12.5" },
  });
  const result = await client.action({ kind: "setup-novamira", envId: "wp:7" });
  assert.equal(result.raw.aiEnabled, null);
  assert.equal(settings.size, 0);
  const commands = calls.map((call) => call.body?.params ?? []);
  assert.ok(
    !commands.some(
      (params) => params.includes("install") || params.includes("activate"),
    ),
  );
});

test("Plesk requires an explicit HTTPS panel URL and numeric domain IDs", async () => {
  const { client, calls } = fixture({ missingUrl: true });
  await assert.rejects(client.validate(), { code: "config_error" });
  await assert.rejects(client.getSite("../other"), { code: "usage_error" });
  assert.deepEqual(calls, []);
  assert.throws(
    () => fixture({ baseUrl: "http://panel.example.invalid:8443" }),
    {
      code: "config_error",
    },
  );
});
