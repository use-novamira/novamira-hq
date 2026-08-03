// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WP Engine provider contract, ported from
 * `internal/providers/wpengine_test.go`.
 *
 * The Go suite drives the client against an `httptest` server; this suite uses
 * a local `node:http` server bound to 127.0.0.1:0 and asserts on the method,
 * request target, `Authorization` header and request body of every hop. No
 * live provider call, no real credential and no network access is involved.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UnixFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import { envCredential } from "../dist/config/schema.js";
import { SecretValue } from "../dist/credentials/store.js";
import { createHostingClientFactory } from "../dist/hosting/factory.js";
import { createHttpClient } from "../dist/hosting/http-client.js";
import { createWpEngineClient } from "../dist/hosting/providers/wpengine.js";

const API_USER = "api-user";
// Obvious fake; nothing in this suite may leak it into an error or a result.
const API_PASSWORD = "api-password";
const EXPECTED_AUTHORIZATION = `Basic ${Buffer.from(
  `${API_USER}:${API_PASSWORD}`,
  "utf8",
).toString("base64")}`;

/**
 * Start a mock WP Engine API. `routes` is consumed in order, mirroring the Go
 * helper's `idx` cursor: an unexpected extra request is recorded and answered
 * with a 500 so the assertion fails in the test, not in the server.
 */
async function startWpEngineServer(routes) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const route = routes[requests.length];
      requests.push({
        line: `${request.method} ${request.url}`,
        method: request.method,
        target: request.url,
        authorization: request.headers.authorization ?? "",
        accept: request.headers.accept ?? "",
        contentType: request.headers["content-type"] ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (route === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"message":"unexpected request"}');
        return;
      }
      response.writeHead(route.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(route.body ?? "{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/** The `ProviderClientContext` the factory would hand a real provider module. */
function wpEngineContext(baseUrl, overrides = {}) {
  const profile = {
    provider: "wpengine",
    credential: envCredential("WPE_API_PASSWORD"),
    apiBaseUrl: baseUrl,
    companyId: API_USER,
  };
  return {
    provider: "wpengine",
    providerLabel: "WP Engine",
    profileName: "production",
    profile,
    baseUrl,
    secret: new SecretValue(API_PASSWORD, "env", "env:WPE_API_PASSWORD"),
    credentialSource: "env:WPE_API_PASSWORD",
    companyId: API_USER,
    identity: API_USER,
    tokenUrl: undefined,
    env: {},
    createHttpClient: (options) =>
      createHttpClient({
        baseUrl,
        providerLabel: "WP Engine",
        ...options,
      }),
    ...overrides,
  };
}

async function wpEngineClient(baseUrl, overrides) {
  return createWpEngineClient(wpEngineContext(baseUrl, overrides));
}

/** Assert the recorded hops match the expected `METHOD /path?query` lines. */
function assertRequestLines(requests, expected) {
  assert.deepEqual(
    requests.map((request) => request.line),
    expected,
  );
  for (const request of requests) {
    assert.equal(request.authorization, EXPECTED_AUTHORIZATION);
    assert.equal(request.accept, "application/json");
  }
}

async function withServer(routes, run) {
  const server = await startWpEngineServer(routes);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Ported Go cases                                                            */
/* -------------------------------------------------------------------------- */

// TestWPEngineValidatesCredentials
test("wpengine validates credentials against /accounts", async () => {
  await withServer(
    [
      {
        body: '{"count":1,"results":[{"id":"account-1","name":"Account","nickname":"Account"}]}',
      },
    ],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const validation = await client.validate();

      assert.equal(validation.provider, "wpengine");
      assert.equal(validation.status, "active");
      assert.equal(validation.companyId, "api-user");
      assert.equal(validation.credential, "env:WPE_API_PASSWORD");
      assertRequestLines(server.requests, [
        "GET /v1/accounts?limit=1&offset=0",
      ]);
    },
  );
});

// TestWPEngineUsesFallbackEnvCredentialNames.
//
// The Go constructor reads WPE_API_USER_ID / WPE_API_PASSWORD with a
// WPENGINE_USERNAME / WPENGINE_PASSWORD fallback itself. In HQ that resolution
// lives in the shared factory, so this case drives the whole path — profile
// store, credential resolution, fallback, provider module — and asserts the
// provider ends up authenticating with the fallback pair.
test("wpengine authenticates with the fallback environment credentials", async () => {
  await withServer([{ body: '{"count":0,"results":[]}' }], async (server) => {
    const root = await mkdtemp(join(tmpdir(), "novamira-hq-wpengine-"));
    try {
      const paths = platformPaths({ NOVAMIRA_HQ_HOME: root }, "linux", root);
      const security = new UnixFileSecurity();
      const locks = new ProfileLockManager(paths.stateDir, security);
      const store = new ConfigStore(paths.configFile, locks, security);
      await store.upsertHostingProfile("production", {
        provider: "wpengine",
        credential: envCredential("WPE_API_PASSWORD"),
        apiBaseUrl: server.baseUrl,
      });

      const factory = createHostingClientFactory({
        store,
        registry: { wpengine: createWpEngineClient },
        env: {
          WPENGINE_USERNAME: API_USER,
          WPENGINE_PASSWORD: API_PASSWORD,
        },
      });
      const client = await factory.clientFromProfile("production");
      const validation = await client.validate();

      assert.equal(validation.companyId, "api-user");
      assert.equal(validation.credential, "env:WPENGINE_PASSWORD");
      assertRequestLines(server.requests, [
        "GET /v1/accounts?limit=1&offset=0",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// TestWPEngineListsSitesWithInstallEnvironments
test("wpengine lists sites with install environments", async () => {
  await withServer(
    [
      {
        body: '{"count":1,"results":[{"id":"site-1","name":"Torque Magazine","sandbox":false,"installs":[{"id":"install-1","name":"torquemag","environment":"production","cname":"torquemag.wpengine.com","php_version":"8.2"}]}]}',
      },
    ],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const sites = await client.listSites({ includeEnvironments: true });

      assert.equal(sites.length, 1);
      assert.equal(sites[0].id, "site-1");
      assert.equal(sites[0].name, "Torque Magazine");
      assert.equal(sites[0].displayName, "Torque Magazine");
      assert.equal(sites[0].status, "active");
      assert.equal(sites[0].primaryDomain, "torquemag.wpengine.com");
      assert.equal(sites[0].environments.length, 1);

      const environment = sites[0].environments[0];
      assert.equal(environment.id, "install-1");
      assert.equal(environment.name, "production");
      assert.equal(environment.displayName, "torquemag (production)");
      assert.equal(environment.primaryDomain, "torquemag.wpengine.com");
      assert.equal(environment.isBlocked, false);
      assert.equal(environment.isPremium, false);

      assertRequestLines(server.requests, ["GET /v1/sites?limit=100&offset=0"]);
    },
  );
});

// TestWPEngineListsAllInstallEnvironments
test("wpengine lists every install environment", async () => {
  await withServer(
    [
      {
        body: '{"count":1,"results":[{"id":"install-1","name":"torquemag","environment":"staging","primary_domain":"staging.example.com","wp_version":"6.8.1","status":"active"}]}',
      },
    ],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const environments = await client.listEnvironments("");

      assert.equal(environments.length, 1);
      assert.equal(environments[0].id, "install-1");
      assert.equal(environments[0].name, "staging");
      assert.equal(environments[0].wordpressVersion, "6.8.1");
      assert.equal(environments[0].primaryDomain, "staging.example.com");
      assert.equal(environments[0].isBlocked, false);

      assertRequestLines(server.requests, [
        "GET /v1/installs?limit=100&offset=0",
      ]);
    },
  );
});

// TestWPEngineClearCacheTranslatesPayload
test("wpengine clear cache translates the payload", async () => {
  await withServer([{ body: "{}" }], async (server) => {
    const client = await wpEngineClient(server.baseUrl);
    const result = await client.action({
      kind: "clear-cache",
      cache: "site",
      body: { environment_id: "install-1" },
    });

    assert.equal(result.provider, "wpengine");
    assert.equal(result.action, "cache.clear");
    assert.equal(result.status, 200);
    assert.deepEqual(result.raw, {});
    assertRequestLines(server.requests, [
      "POST /v1/installs/install-1/purge_cache",
    ]);
    assert.deepEqual(JSON.parse(server.requests[0].body), { type: "page" });
  });
});

// TestWPEngineAddDomainUsesInstallEndpoint
test("wpengine add domain uses the install endpoint", async () => {
  await withServer(
    [{ body: '{"id":"domain-1","name":"example.com","primary":false}' }],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const result = await client.action({
        kind: "add-domain",
        envId: "install-1",
        body: { domain_name: "example.com" },
      });

      assert.equal(result.action, "domains.add");
      assert.equal(result.raw.id, "domain-1");
      assert.equal(result.operationId, "domain-1");
      assertRequestLines(server.requests, [
        "POST /v1/installs/install-1/domains",
      ]);
      // `domain_name` is copied into the WP Engine-native `name` field.
      assert.deepEqual(JSON.parse(server.requests[0].body), {
        domain_name: "example.com",
        name: "example.com",
      });
    },
  );
});

// TestWPEngineRestoreBackupSendsRequestBody
test("wpengine restore backup sends the remaining request body", async () => {
  await withServer([{ body: "{}" }], async (server) => {
    const client = await wpEngineClient(server.baseUrl);
    const result = await client.action({
      kind: "restore-backup",
      targetEnvId: "install-1",
      body: {
        backup_id: "backup-1",
        notification_emails: ["agent@example.com"],
        restore_database: true,
        create_checkpoint: false,
      },
    });

    assert.equal(result.action, "backups.restore");
    assertRequestLines(server.requests, [
      "POST /v1/installs/install-1/backups/backup-1/restore",
    ]);
    // The backup id is consumed by the path and removed from the body.
    assert.deepEqual(JSON.parse(server.requests[0].body), {
      notification_emails: ["agent@example.com"],
      restore_database: true,
      create_checkpoint: false,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Coverage beyond the Go suite                                               */
/* -------------------------------------------------------------------------- */

test("wpengine reports its capability list", async () => {
  await withServer([], async (server) => {
    const client = await wpEngineClient(server.baseUrl);
    const capabilities = await client.read({ kind: "capabilities" });

    // The 40 entries of Go's `(*WPEngineClient).capabilities`, in order.
    assert.equal(capabilities.length, 40);
    assert.equal(capabilities[0].name, "providers.validate");
    assert.equal(capabilities[39].name, "access.sftp");
    const byName = new Map(
      capabilities.map((capability) => [capability.name, capability]),
    );
    assert.equal(byName.get("providers.validate").supported, true);
    assert.equal(byName.get("providers.validate").notes, undefined);
    assert.equal(byName.get("envs.list").supported, true);
    assert.equal(
      byName.get("envs.list").notes,
      "WP Engine installs are exposed as environments",
    );
    assert.equal(byName.get("sites.clone").supported, false);
    assert.equal(
      byName.get("sites.clone").notes,
      "not supported by WP Engine's provider-neutral Novamira mapping",
    );
    assert.equal(byName.get("wp-cli.run").supported, false);
    assert.equal(byName.get("cache.clear").supported, true);
    assert.equal(server.requests.length, 0);
  });
});

test("wpengine gets a single site with its installs", async () => {
  await withServer(
    [
      {
        body: '{"id":"site-1","name":"Torque","sandbox":true,"installs":[{"id":"install-1","name":"torquemag","environment":"","status":"suspended","stable_ips":["10.0.0.1"],"primary_domain":"example.com"}]}',
      },
    ],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const site = await client.getSite("site-1");

      assert.equal(site.status, "sandbox");
      assert.equal(site.primaryDomain, "example.com");
      assert.equal(site.environments.length, 1);
      // An empty `environment` falls back to the install name for both fields.
      assert.equal(site.environments[0].name, "torquemag");
      assert.equal(site.environments[0].displayName, "torquemag");
      assert.equal(site.environments[0].isBlocked, true);
      assert.equal(site.environments[0].isPremium, true);
      assert.equal(site.environments[0].wordpressVersion, undefined);
      assertRequestLines(server.requests, ["GET /v1/sites/site-1"]);
    },
  );
});

test("wpengine lists a single site's environments through the site endpoint", async () => {
  await withServer(
    [
      {
        body: '{"id":"site 1","name":"Torque","installs":[{"id":"install-1","name":"torquemag","environment":"production"}]}',
      },
    ],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const environments = await client.listEnvironments("site 1");

      assert.equal(environments.length, 1);
      assert.equal(environments[0].id, "install-1");
      // Path segments are percent-escaped, matching Go's url.PathEscape.
      assertRequestLines(server.requests, ["GET /v1/sites/site%201"]);
    },
  );
});

test("wpengine follows pagination until the last page", async () => {
  await withServer(
    [
      {
        body: '{"count":3,"next":"https://api.wpengineapi.com/v1/sites?offset=2","results":[{"id":"site-1","name":"One"},{"id":"site-2","name":"Two"}]}',
      },
      {
        body: '{"count":3,"next":"","results":[{"id":"site-3","name":"Three"}]}',
      },
    ],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const sites = await client.listSites();

      assert.deepEqual(
        sites.map((site) => site.id),
        ["site-1", "site-2", "site-3"],
      );
      // Environments were not requested, so none are attached.
      assert.equal(sites[0].environments, undefined);
      assertRequestLines(server.requests, [
        "GET /v1/sites?limit=100&offset=0",
        "GET /v1/sites?limit=100&offset=2",
      ]);
    },
  );
});

test("wpengine stops paginating once the reported count is reached", async () => {
  await withServer(
    [
      {
        body: '{"count":2,"next":"https://api.wpengineapi.com/v1/installs?offset=2","results":[{"id":"install-1","name":"a"},{"id":"install-2","name":"b"}]}',
      },
    ],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const environments = await client.listEnvironments("");

      assert.equal(environments.length, 2);
      assertRequestLines(server.requests, [
        "GET /v1/installs?limit=100&offset=0",
      ]);
    },
  );
});

test("wpengine reads domains and backups from the install endpoints", async () => {
  await withServer(
    [
      { body: '{"results":[{"id":"domain-1","name":"example.com"}]}' },
      { body: '{"results":[{"id":"backup-1"}]}' },
      { body: '{"results":[{"id":"backup-1"}]}' },
    ],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);

      const domains = await client.read({
        kind: "site-domains",
        envId: "install-1",
      });
      assert.equal(domains.results[0].id, "domain-1");

      const backups = await client.read({
        kind: "backups",
        envId: "install-1",
      });
      assert.equal(backups.results[0].id, "backup-1");

      const downloadable = await client.read({
        kind: "downloadable-backups",
        envId: "install-1",
      });
      assert.equal(downloadable.results[0].id, "backup-1");

      assertRequestLines(server.requests, [
        "GET /v1/installs/install-1/domains?limit=100&offset=0",
        "GET /v1/installs/install-1/backups?limit=100&offset=0",
        "GET /v1/installs/install-1/backups?limit=100&offset=0",
      ]);
    },
  );
});

test("wpengine creates and deletes sites and installs", async () => {
  await withServer(
    [
      { body: '{"id":"site-1","name":"Torque"}' },
      { body: "" },
      { body: '{"id":"install-1"}' },
      { body: "" },
    ],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);

      const created = await client.action({
        kind: "create-site",
        mode: "wordpress",
        body: { display_name: "Torque", account_id: "account-1" },
      });
      assert.equal(created.action, "sites.create");
      assert.equal(created.operationId, "site-1");

      const deleted = await client.action({
        kind: "delete-site",
        siteId: "site-1",
      });
      assert.equal(deleted.action, "sites.delete");
      assert.equal(deleted.status, 200);
      // An empty response body parses to null, as Go's parseJSONBody does.
      assert.equal(deleted.raw, null);
      assert.equal(deleted.operationId, undefined);
      assert.equal(deleted.message, undefined);

      const install = await client.action({
        kind: "create-environment",
        siteId: "site-1",
        mode: "plain",
        body: { display_name: "torquemag", environment: "staging" },
      });
      assert.equal(install.action, "envs.create");

      const removed = await client.action({
        kind: "delete-environment",
        envId: "install-1",
      });
      assert.equal(removed.action, "envs.delete");

      assertRequestLines(server.requests, [
        "POST /v1/sites",
        "DELETE /v1/sites/site-1",
        "POST /v1/installs",
        "DELETE /v1/installs/install-1",
      ]);
      // `display_name` seeds the WP Engine-native `name` field.
      assert.deepEqual(JSON.parse(server.requests[0].body), {
        display_name: "Torque",
        account_id: "account-1",
        name: "Torque",
      });
      assert.deepEqual(JSON.parse(server.requests[2].body), {
        display_name: "torquemag",
        environment: "staging",
        site_id: "site-1",
        name: "torquemag",
      });
    },
  );
});

test("wpengine changes the primary domain with PATCH", async () => {
  await withServer(
    [{ body: '{"id":"domain-1","primary":true}' }],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const result = await client.action({
        kind: "change-primary-domain",
        envId: "install-1",
        body: { domain_id: "domain-1" },
      });

      assert.equal(result.action, "domains.primary");
      assertRequestLines(server.requests, [
        "PATCH /v1/installs/install-1/domains/domain-1",
      ]);
      assert.deepEqual(JSON.parse(server.requests[0].body), { primary: true });
    },
  );
});

test("wpengine deletes a single domain directly", async () => {
  await withServer([{ body: "" }], async (server) => {
    const client = await wpEngineClient(server.baseUrl);
    const result = await client.action({
      kind: "delete-domains",
      envId: "install-1",
      body: { id: "domain-1" },
    });

    assert.equal(result.action, "domains.delete");
    assert.equal(result.raw, null);
    assertRequestLines(server.requests, [
      "DELETE /v1/installs/install-1/domains/domain-1",
    ]);
  });
});

test("wpengine deletes several domains and aggregates the results", async () => {
  await withServer(
    [{ body: '{"deleted":"domain-1"}' }, { body: '{"deleted":"domain-2"}' }],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const result = await client.action({
        kind: "delete-domains",
        envId: "install-1",
        body: { domain_ids: ["domain-1", "domain-2"] },
      });

      assert.equal(result.action, "domains.delete");
      assert.equal(result.status, 200);
      assert.deepEqual(result.raw, {
        results: [{ deleted: "domain-1" }, { deleted: "domain-2" }],
      });
      assertRequestLines(server.requests, [
        "DELETE /v1/installs/install-1/domains/domain-1",
        "DELETE /v1/installs/install-1/domains/domain-2",
      ]);
    },
  );
});

test("wpengine creates a backup and maps tag onto description", async () => {
  await withServer(
    [{ body: '{"id":"backup-1","status":"requested"}' }],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const result = await client.action({
        kind: "create-backup",
        envId: "install-1",
        body: { tag: "pre-deploy", notification_emails: ["agent@example.com"] },
      });

      assert.equal(result.action, "backups.create");
      assert.equal(result.operationId, "backup-1");
      assertRequestLines(server.requests, [
        "POST /v1/installs/install-1/backups",
      ]);
      assert.deepEqual(JSON.parse(server.requests[0].body), {
        tag: "pre-deploy",
        notification_emails: ["agent@example.com"],
        description: "pre-deploy",
      });
    },
  );
});

test("wpengine maps the cache kind onto the WP Engine cache type", async () => {
  await withServer(
    [{ body: "{}" }, { body: "{}" }, { body: "{}" }],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);

      await client.action({
        kind: "clear-cache",
        cache: "edge",
        body: { site_id: "install-1" },
      });
      await client.action({
        kind: "clear-cache",
        cache: "cdn",
        body: { envId: "install-2" },
      });
      // An explicit `type` in the body wins over the neutral cache kind.
      await client.action({
        kind: "clear-cache",
        cache: "site",
        body: { environment_id: "install-3", type: "object" },
      });

      assert.deepEqual(
        server.requests.map((request) => JSON.parse(request.body)),
        [{ type: "all" }, { type: "cdn" }, { type: "object" }],
      );
      assertRequestLines(server.requests, [
        "POST /v1/installs/install-1/purge_cache",
        "POST /v1/installs/install-2/purge_cache",
        "POST /v1/installs/install-3/purge_cache",
      ]);
    },
  );
});

test("wpengine surfaces the provider message on an action response", async () => {
  await withServer(
    [{ body: '{"id":"op-1","message":"queued"}' }],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const result = await client.action({
        kind: "create-backup",
        envId: "install-1",
        body: {},
      });

      assert.equal(result.message, "queued");
      assert.equal(result.operationId, "op-1");
    },
  );
});

test("wpengine reports operations as complete without polling", async () => {
  await withServer([], async (server) => {
    const client = await wpEngineClient(server.baseUrl);
    const status = await client.operationStatus("op-1");

    assert.equal(status.provider, "wpengine");
    assert.equal(status.operationId, "op-1");
    assert.equal(status.status, 200);
    assert.equal(status.done, true);
    assert.equal(status.failed, false);
    assert.equal(
      status.message,
      "WP Engine does not support generic async operation status polling",
    );
    assert.equal(server.requests.length, 0);
  });
});

test("wpengine rejects unmapped read requests", async () => {
  await withServer([], async (server) => {
    const client = await wpEngineClient(server.baseUrl);
    const unmapped = [
      { kind: "regions" },
      { kind: "activity" },
      { kind: "site-domain-verification", siteDomainId: "x" },
      { kind: "dns-domains" },
      { kind: "dns-records", domainId: "x" },
      { kind: "logs", envId: "x", fileName: "error", lines: 10 },
      { kind: "redirects", envId: "x" },
      { kind: "denied-ips", envId: "x" },
      { kind: "plugins", envId: "x" },
      { kind: "themes", envId: "x" },
      { kind: "company-plugins" },
      { kind: "company-themes" },
      { kind: "ssh-status", envId: "x" },
      { kind: "ssh-allowlist", envId: "x" },
      { kind: "ssh-config", siteId: "x", envId: "y" },
      { kind: "ssh-password", envId: "x" },
      { kind: "sftp-accounts", envId: "x" },
      { kind: "analytics-usage", siteId: "x", metric: "visits" },
      { kind: "analytics-env", envId: "x", metric: "visits" },
      { kind: "file-list", envId: "x" },
    ];
    for (const request of unmapped) {
      await assert.rejects(
        () => client.read(request),
        (error) => {
          assert.equal(error.code, "provider_unsupported");
          assert.match(error.message, /WP Engine does not support/);
          return true;
        },
        `expected ${request.kind} to be unsupported`,
      );
    }
    assert.equal(server.requests.length, 0);
  });
});

test("wpengine rejects unmapped action requests", async () => {
  await withServer([], async (server) => {
    const client = await wpEngineClient(server.baseUrl);
    const unmapped = [
      { kind: "reset-site", siteId: "x" },
      { kind: "push-environment", siteId: "x" },
      { kind: "restart-php", envId: "x" },
      { kind: "set-php-version" },
      { kind: "delete-backup", backupId: 1 },
      { kind: "update-plugin", envId: "x" },
      { kind: "bulk-update-plugins", envId: "x" },
      { kind: "update-theme", envId: "x" },
      { kind: "bulk-update-themes", envId: "x" },
      { kind: "run-wp-cli", envId: "x" },
      { kind: "set-denied-ips" },
      { kind: "apply-redirects", envId: "x" },
      { kind: "dns-record-create", domainId: "x" },
      { kind: "dns-record-update", domainId: "x" },
      { kind: "dns-record-delete", domainId: "x" },
      { kind: "set-ssh-status", envId: "x" },
      { kind: "set-ssh-password-status", envId: "x" },
      { kind: "generate-ssh-password", envId: "x" },
      { kind: "set-ssh-allowlist", envId: "x" },
      { kind: "change-ssh-password-expiration", envId: "x" },
      { kind: "toggle-sftp-accounts", envId: "x" },
      { kind: "add-sftp-account", envId: "x" },
      { kind: "remove-sftp-account", sftpAccountId: "x" },
    ];
    for (const request of unmapped) {
      await assert.rejects(
        () => client.action(request),
        (error) => {
          assert.equal(error.code, "provider_unsupported");
          return true;
        },
        `expected ${request.kind} to be unsupported`,
      );
    }
    assert.equal(server.requests.length, 0);
  });
});

test("wpengine rejects clone create modes", async () => {
  await withServer([], async (server) => {
    const client = await wpEngineClient(server.baseUrl);

    await assert.rejects(
      () => client.action({ kind: "create-site", mode: "clone", body: {} }),
      (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.match(error.message, /sites\.clone/);
        return true;
      },
    );
    await assert.rejects(
      () =>
        client.action({
          kind: "create-environment",
          siteId: "site-1",
          mode: "clone",
          body: {},
        }),
      (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.match(error.message, /envs\.clone/);
        return true;
      },
    );
    assert.equal(server.requests.length, 0);
  });
});

test("wpengine rejects malformed action bodies", async () => {
  await withServer([], async (server) => {
    const client = await wpEngineClient(server.baseUrl);

    // cache.clear needs an install id
    await assert.rejects(
      () => client.action({ kind: "clear-cache", cache: "site", body: {} }),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.match(error.message, /environment_id/);
        return true;
      },
    );
    // domains.primary needs a domain id
    await assert.rejects(
      () =>
        client.action({
          kind: "change-primary-domain",
          envId: "install-1",
          body: {},
        }),
      (error) => {
        assert.equal(error.code, "usage_error");
        return true;
      },
    );
    // domains.delete needs at least one id
    await assert.rejects(
      () => client.action({ kind: "delete-domains", envId: "install-1" }),
      (error) => {
        assert.equal(error.code, "usage_error");
        return true;
      },
    );
    await assert.rejects(
      () =>
        client.action({
          kind: "delete-domains",
          envId: "install-1",
          body: { domain_ids: [] },
        }),
      (error) => {
        assert.equal(error.code, "usage_error");
        return true;
      },
    );
    await assert.rejects(
      () =>
        client.action({
          kind: "delete-domains",
          envId: "install-1",
          body: { domain_ids: "domain-1" },
        }),
      (error) => {
        assert.equal(error.code, "usage_error");
        return true;
      },
    );
    // backups.restore needs a backup id
    await assert.rejects(
      () =>
        client.action({
          kind: "restore-backup",
          targetEnvId: "install-1",
          body: { restore_database: true },
        }),
      (error) => {
        assert.equal(error.code, "usage_error");
        return true;
      },
    );
    // a non-object body is not a WP Engine payload
    await assert.rejects(
      () =>
        client.action({
          kind: "create-site",
          mode: "wordpress",
          body: ["not", "an", "object"],
        }),
      (error) => {
        assert.equal(error.code, "usage_error");
        return true;
      },
    );
    assert.equal(server.requests.length, 0);
  });
});

test("wpengine requires an API user id", async () => {
  await withServer([], async (server) => {
    await assert.rejects(
      async () =>
        createWpEngineClient(
          wpEngineContext(server.baseUrl, {
            companyId: undefined,
            identity: undefined,
          }),
        ),
      (error) => {
        assert.equal(error.code, "credential_missing");
        assert.match(error.message, /WPE_API_USER_ID/);
        return true;
      },
    );
  });
});

test("wpengine never leaks the credential into errors or diagnostics", async () => {
  const diagnostics = [];
  await withServer(
    [{ status: 404, body: '{"message":"install not found"}' }],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl, {
        createHttpClient: (options) =>
          createHttpClient({
            baseUrl: server.baseUrl,
            providerLabel: "WP Engine",
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
            ...options,
          }),
      });

      await assert.rejects(
        () => client.read({ kind: "backups", envId: "missing" }),
        (error) => {
          assert.equal(error.code, "not_found");
          const serialized = JSON.stringify({
            message: error.message,
            details: error.details,
          });
          assert.ok(!serialized.includes(API_PASSWORD));
          assert.ok(!serialized.includes(EXPECTED_AUTHORIZATION));
          return true;
        },
      );
      const serializedDiagnostics = JSON.stringify(diagnostics);
      assert.ok(serializedDiagnostics.length > 0);
      assert.ok(!serializedDiagnostics.includes(API_PASSWORD));
    },
  );
});

test("wpengine never returns the credential in a successful result", async () => {
  await withServer(
    [
      {
        body: '{"count":1,"results":[{"id":"site-1","name":"Torque","installs":[]}]}',
      },
    ],
    async (server) => {
      const client = await wpEngineClient(server.baseUrl);
      const sites = await client.listSites({ includeEnvironments: true });
      const serialized = JSON.stringify(sites);
      assert.ok(!serialized.includes(API_PASSWORD));
      assert.deepEqual(sites[0].environments, []);
    },
  );
});
