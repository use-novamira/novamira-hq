// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Kinsta provider contract tests, ported from
 * `internal/providers/kinsta_test.go`.
 *
 * The Go suite drives a `httptest` server that asserts an ordered list of
 * `METHOD request-uri` lines and replies with recorded-shape bodies. This suite
 * does the same with a loopback `node:http` server, and extends it to the parts
 * of `kinsta.go` the Go tests never exercised: the full read and action
 * endpoint tables, company-id resolution, bulk update collection, metric
 * validation, and the guarantee that the API key never reaches an error, a
 * diagnostic, or a serialized result. No test performs a live provider call.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { SecretValue } from "../dist/credentials/store.js";
import { renderRaw } from "../dist/cli/print.js";
import { wpCliResultsObservable } from "../dist/hosting/client.js";
import { createHttpClient } from "../dist/hosting/http-client.js";
import { createKinstaClient } from "../dist/hosting/providers/kinsta.js";
import {
  serializeActionResult,
  serializeHostingSite,
  serializeOperationStatus,
  serializeProviderValidation,
} from "../dist/hosting/types.js";

/** An obvious fake. Nothing in this suite ever contacts a real provider. */
const API_KEY = "kinsta-fake-api-key-not-a-real-secret";

const OK = { body: "{}" };
const ACTION_BODY = '{"status":202,"operation_id":"op-1","message":"Working"}';

/**
 * The mock server is mounted under a path, like every real Kinsta base URL
 * (`https://api.kinsta.com/v2`). Expected request lines are written without it
 * and `wire` prefixes them, so the assertions read like the Go originals while
 * still checking the exact bytes on the wire.
 */
const API_PATH = "/v2";

function wire(line) {
  const space = line.indexOf(" ");
  return `${line.slice(0, space)} ${API_PATH}${line.slice(space + 1)}`;
}

function lines(requests) {
  return requests.map((request) => request.line);
}

async function startServer(routes) {
  const requests = [];
  let index = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const route = routes[index] ?? {
        status: 500,
        body: '{"message":"unexpected request"}',
      };
      index += 1;
      requests.push({
        line: `${request.method} ${request.url}`,
        authorization: request.headers.authorization ?? null,
        contentType: request.headers["content-type"] ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(route.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(route.body ?? "");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}${API_PATH}`,
  };
}

async function stopServer(state) {
  state.server.closeAllConnections();
  state.server.close();
  await once(state.server, "close");
}

/**
 * A hand-made `ProviderClientContext`, shaped exactly like the one
 * `createHostingClientFactory` builds, but pointed at the mock server.
 */
function kinstaContext(baseUrl, overrides = {}) {
  const diagnostics = [];
  const context = {
    provider: "kinsta",
    providerLabel: "Kinsta",
    profileName: "production",
    profile: {
      provider: "kinsta",
      credential: { type: "env", name: "KINSTA_API_KEY" },
    },
    baseUrl,
    secret: new SecretValue(API_KEY, "env", "env:KINSTA_API_KEY"),
    credentialSource: "env:KINSTA_API_KEY",
    companyId: undefined,
    identity: undefined,
    tokenUrl: undefined,
    env: {},
    createHttpClient: (options) =>
      createHttpClient({
        retry: { maxAttempts: 1 },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        baseUrl,
        providerLabel: "Kinsta",
        ...options,
      }),
    ...overrides,
  };
  return { context, diagnostics };
}

async function withKinsta(routes, overrides, run) {
  const state = await startServer(routes);
  const { context, diagnostics } = kinstaContext(state.baseUrl, overrides);
  const client = await createKinstaClient(context);
  try {
    await run({ client, requests: state.requests, diagnostics });
  } finally {
    await stopServer(state);
  }
}

/** A profile that already knows its company, so nothing calls `/validate`. */
const SCOPED = { companyId: "company-config" };

/* -------------------------------------------------------------------------- */
/* ported Go tests                                                            */
/* -------------------------------------------------------------------------- */

test("validates credentials", async () => {
  await withKinsta(
    [
      {
        body: '{"name":"key","expires_at":null,"company":"company-1","status":"active"}',
      },
    ],
    {},
    async ({ client, requests }) => {
      const validation = await client.validate();

      assert.equal(client.provider, "kinsta");
      assert.deepEqual(serializeProviderValidation(validation), {
        provider: "kinsta",
        status: "active",
        company_id: "company-1",
        credential: "env:KINSTA_API_KEY",
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].line, wire("GET /validate"));
      // The credential travels as a bearer token and nowhere else.
      assert.equal(requests[0].authorization, `Bearer ${API_KEY}`);
      assert.equal(requests[0].contentType, null);
      assert.equal(requests[0].body, "");
    },
  );
});

test("lists sites", async () => {
  await withKinsta(
    [
      {
        body: '{"company":{"sites":[{"id":"site-1","name":"site-one","display_name":"Site One","status":"live","environments":[{"id":"env-1","name":"live","display_name":"Live","is_blocked":false,"is_premium":false,"wordpress_version":"6.5","primaryDomain":{"name":"example.com"}}]}]}}',
      },
    ],
    {},
    async ({ client, requests }) => {
      const sites = await client.listSites({
        companyId: "company-1",
        includeEnvironments: true,
      });

      assert.equal(
        requests[0].line,
        wire("GET /sites?company=company-1&include_environments=true"),
      );
      assert.equal(sites.length, 1);
      assert.equal(sites[0].primaryDomain, "example.com");
      assert.equal(sites[0].environments[0].id, "env-1");
      assert.deepEqual(serializeHostingSite(sites[0]), {
        id: "site-1",
        name: "site-one",
        display_name: "Site One",
        status: "live",
        primary_domain: "example.com",
        environments: [
          {
            id: "env-1",
            name: "live",
            display_name: "Live",
            is_blocked: false,
            is_premium: false,
            wordpress_version: "6.5",
            primary_domain: "example.com",
          },
        ],
      });
    },
  );
});

test("normalizes action results", async () => {
  await withKinsta(
    [
      {
        body: '{"operation_id":"cache:clear-1","message":"Clearing site cache in progress","status":202}',
      },
    ],
    {},
    async ({ client, requests }) => {
      const result = await client.action({
        kind: "clear-cache",
        cache: "site",
        body: { environment_id: "env-1" },
      });

      assert.equal(requests[0].line, wire("POST /sites/tools/clear-cache"));
      assert.equal(requests[0].contentType, "application/json");
      assert.deepEqual(JSON.parse(requests[0].body), {
        environment_id: "env-1",
      });
      assert.equal(result.action, "cache.clear");
      assert.equal(result.operationId, "cache:clear-1");
      assert.equal(result.status, 202);
      assert.deepEqual(serializeActionResult(result), {
        provider: "kinsta",
        action: "cache.clear",
        status: 202,
        message: "Clearing site cache in progress",
        operation_id: "cache:clear-1",
        raw: {
          operation_id: "cache:clear-1",
          message: "Clearing site cache in progress",
          status: 202,
        },
      });
    },
  );
});

test("polls operation status", async () => {
  await withKinsta(
    [{ body: '{"message":"Successfully finished request","status":200}' }],
    {},
    async ({ client, requests }) => {
      const status = await client.operationStatus("op-1");

      assert.equal(requests[0].line, wire("GET /operations/op-1"));
      assert.equal(status.done, true);
      assert.equal(status.failed, false);
      assert.deepEqual(serializeOperationStatus(status), {
        provider: "kinsta",
        operation_id: "op-1",
        status: 200,
        done: true,
        failed: false,
        message: "Successfully finished request",
        raw: { message: "Successfully finished request", status: 200 },
      });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* beyond the Go suite                                                        */
/* -------------------------------------------------------------------------- */

test("a failed operation is reported, not raised", async () => {
  // Kinsta answers a finished-but-failed operation with HTTP 500 and a body.
  await withKinsta(
    [{ status: 500, body: '{"message":"Operation failed","status":500}' }],
    {},
    async ({ client, requests }) => {
      const status = await client.operationStatus("op-2");
      assert.equal(requests.length, 1, "500 must not be retried");
      assert.equal(status.status, 500);
      assert.equal(status.done, false);
      assert.equal(status.failed, true);
      assert.equal(status.message, "Operation failed");
    },
  );

  // A body without a `status` falls back to the HTTP status.
  await withKinsta(
    [{ status: 202, body: '{"message":"queued"}' }],
    {},
    async ({ client }) => {
      const status = await client.operationStatus("op-3");
      assert.equal(status.status, 202);
      assert.equal(status.done, false);
      assert.equal(status.failed, false);
    },
  );
});

test("a site with no environments keeps both fields absent", async () => {
  await withKinsta(
    [
      {
        body: '{"company":{"sites":[{"id":"site-2","name":"two","display_name":"Two","status":"live","environments":[]}]}}',
      },
    ],
    SCOPED,
    async ({ client, requests }) => {
      const sites = await client.listSites();
      assert.equal(
        requests[0].line,
        wire("GET /sites?company=company-config&include_environments=false"),
      );
      assert.deepEqual(serializeHostingSite(sites[0]), {
        id: "site-2",
        name: "two",
        display_name: "Two",
        status: "live",
      });
    },
  );
});

test("the company id resolves from the request, the profile, then /validate", async () => {
  // Neither the request nor the profile carries one: `/validate` supplies it.
  await withKinsta(
    [{ body: '{"company":"company-9","status":"active"}' }, OK],
    {},
    async ({ client, requests }) => {
      await client.read({ kind: "regions" });
      assert.deepEqual(
        lines(requests),
        ["GET /validate", "GET /company/company-9/available-regions"].map(wire),
      );
    },
  );

  // The profile's company short-circuits the validation call.
  await withKinsta([OK], SCOPED, async ({ client, requests }) => {
    await client.read({ kind: "regions" });
    assert.deepEqual(
      lines(requests),
      ["GET /company/company-config/available-regions"].map(wire),
    );
  });

  // An explicit company on the request wins over the profile's.
  await withKinsta([OK], SCOPED, async ({ client, requests }) => {
    await client.read({ kind: "regions", companyId: "company-explicit" });
    assert.equal(
      requests[0].line,
      wire("GET /company/company-explicit/available-regions"),
    );
  });

  // `/validate` that answers without a company is a provider failure.
  await withKinsta(
    [{ body: '{"status":"active"}' }],
    {},
    async ({ client }) => {
      await assert.rejects(client.read({ kind: "regions" }), {
        code: "provider_error",
      });
    },
  );
});

test("read requests map to the documented Kinsta endpoints", async () => {
  const table = [
    [{ kind: "regions" }, "GET /company/company-config/available-regions"],
    [
      {
        kind: "activity",
        query: [
          ["limit", "10"],
          ["order", "desc"],
        ],
      },
      "GET /company/company-config/activity-logs?limit=10&order=desc",
    ],
    [
      { kind: "site-domains", envId: "env-1" },
      "GET /sites/environments/env-1/domains",
    ],
    [
      { kind: "site-domain-verification", siteDomainId: "sd-1" },
      "GET /sites/environments/domains/sd-1/verification-records",
    ],
    [{ kind: "dns-domains" }, "GET /domains?company=company-config"],
    [
      { kind: "dns-records", domainId: "dom-1" },
      "GET /domains/dom-1/dns-records",
    ],
    [
      { kind: "backups", envId: "env-1" },
      "GET /sites/environments/env-1/backups",
    ],
    [
      { kind: "downloadable-backups", envId: "env-1" },
      "GET /sites/environments/env-1/downloadable-backups",
    ],
    [
      { kind: "logs", envId: "env-1", fileName: "error.log", lines: 100 },
      "GET /sites/environments/env-1/logs?file_name=error.log&lines=100",
    ],
    [
      { kind: "redirects", envId: "env-1", query: [["page", "2"]] },
      "GET /sites/environments/env-1/redirect-rules?page=2",
    ],
    [
      { kind: "denied-ips", envId: "env-1" },
      "GET /sites/tools/denied-ips?environment_id=env-1",
    ],
    [
      { kind: "plugins", envId: "env-1" },
      "GET /sites/environments/env-1/wp-plugins",
    ],
    [
      { kind: "themes", envId: "env-1" },
      "GET /sites/environments/env-1/wp-themes",
    ],
    [{ kind: "company-plugins" }, "GET /company/company-config/wp-plugins"],
    [{ kind: "company-themes" }, "GET /company/company-config/wp-themes"],
    [
      { kind: "analytics-usage", siteId: "site-1", metric: "visits" },
      "GET /sites/site-1/usage/visits/this-month",
    ],
    [
      {
        kind: "analytics-env",
        envId: "env-1",
        metric: "bandwidth",
        query: [["start", "1"]],
      },
      // The company scope is appended when the caller did not supply one.
      "GET /sites/environments/env-1/analytics/bandwidth?start=1&company_id=company-config",
    ],
    [
      {
        kind: "analytics-env",
        envId: "env-1",
        metric: "top-cities",
        query: [["company_id", "company-explicit"]],
      },
      "GET /sites/environments/env-1/analytics/top-cities?company_id=company-explicit",
    ],
    [
      { kind: "file-list", envId: "env-1" },
      "GET /sites/environments/env-1/file-list",
    ],
  ];

  await withKinsta(
    table.map(() => OK),
    SCOPED,
    async ({ client, requests }) => {
      for (const [request] of table) await client.read(request);
      assert.deepEqual(
        lines(requests),
        table.map(([, line]) => wire(line)),
      );
      // Every read is a bodiless GET carrying the bearer token.
      for (const request of requests) {
        assert.equal(request.body, "");
        assert.equal(request.authorization, `Bearer ${API_KEY}`);
      }
    },
  );
});

test("the capabilities read needs no network call", async () => {
  await withKinsta([], SCOPED, async ({ client, requests }) => {
    const capabilities = await client.read({ kind: "capabilities" });
    assert.equal(requests.length, 0);
    assert.equal(capabilities.length, 44);
    assert.deepEqual(capabilities[0], {
      name: "providers.validate",
      supported: true,
    });
    assert.equal(
      capabilities.every((capability) => capability.supported === true),
      true,
    );
    assert.equal(
      capabilities.some((capability) => "notes" in capability),
      false,
    );
    for (const name of [
      "sites.clone",
      "wp-cli.run",
      "analytics.env",
      "ops.wait",
    ]) {
      assert.equal(
        capabilities.some((capability) => capability.name === name),
        true,
        `missing capability ${name}`,
      );
    }
  });
});

test("raw reads redact provider credentials echoed under ordinary keys", async () => {
  await withKinsta(
    [{ body: `{"echoed":"${API_KEY}"}` }],
    SCOPED,
    async ({ client, requests }) => {
      const value = await client.read({
        kind: "plugins",
        envId: "env-1",
      });
      assert.equal(requests[0].authorization, `Bearer ${API_KEY}`);
      const output = JSON.stringify(renderRaw(value));
      assert.equal(output.includes(API_KEY), false, output);
      assert.match(output, /\[REDACTED\]/);
    },
  );
});

test("action requests map to the documented Kinsta endpoints", async () => {
  const table = [
    [
      { kind: "create-site", mode: "wordpress", body: { name: "demo" } },
      "POST /sites",
      "sites.create",
      '{"name":"demo","company":"company-config"}',
    ],
    [
      { kind: "create-site", mode: "plain", body: { name: "demo" } },
      "POST /sites/plain",
      "sites.create-plain",
      '{"name":"demo","company":"company-config"}',
    ],
    [
      { kind: "create-site", mode: "clone", body: { company: "company-b" } },
      "POST /sites/clone",
      "sites.clone",
      '{"company":"company-b"}',
    ],
    [
      {
        kind: "create-environment",
        siteId: "site-1",
        mode: "wordpress",
        body: { name: "staging" },
      },
      "POST /sites/site-1/environments",
      "envs.create",
      '{"name":"staging"}',
    ],
    [
      { kind: "create-environment", siteId: "site-1", mode: "plain" },
      "POST /sites/site-1/environments/plain",
      "envs.create-plain",
      "",
    ],
    [
      { kind: "create-environment", siteId: "site-1", mode: "clone" },
      "POST /sites/site-1/environments/clone",
      "envs.clone",
      "",
    ],
    [
      { kind: "push-environment", siteId: "site-1", body: { source: "env-1" } },
      "PUT /sites/site-1/environments",
      "envs.push",
      '{"source":"env-1"}',
    ],
    [
      { kind: "clear-cache", cache: "edge", body: { environment_id: "env-1" } },
      "POST /sites/edge-caching/clear",
      "cache.clear-edge",
      '{"environment_id":"env-1"}',
    ],
    [
      { kind: "clear-cache", cache: "cdn", body: { environment_id: "env-1" } },
      "POST /sites/cdn/clear-cache",
      "cache.clear-cdn",
      '{"environment_id":"env-1"}',
    ],
    [
      { kind: "restart-php", envId: "env-1" },
      "POST /sites/tools/restart-php",
      "php.restart",
      '{"environment_id":"env-1"}',
    ],
    [
      { kind: "set-php-version", body: { php_version: "8.3" } },
      "PUT /sites/tools/modify-php-version",
      "php.set-version",
      '{"php_version":"8.3"}',
    ],
    [
      { kind: "add-domain", envId: "env-1", body: { domain: "example.test" } },
      "POST /sites/environments/env-1/domains",
      "domains.add",
      '{"domain":"example.test"}',
    ],
    [
      {
        kind: "change-primary-domain",
        envId: "env-1",
        body: { domain_id: "d-1" },
      },
      "PUT /sites/environments/env-1/change-primary-domain",
      "domains.primary",
      '{"domain_id":"d-1"}',
    ],
    [
      { kind: "create-backup", envId: "env-1", body: { tag: "pre-deploy" } },
      "POST /sites/environments/env-1/manual-backups",
      "backups.create",
      '{"tag":"pre-deploy"}',
    ],
    [
      { kind: "update-plugin", envId: "env-1", body: { name: "akismet" } },
      "PUT /sites/environments/env-1/plugins",
      "wp.plugins.update",
      '{"name":"akismet"}',
    ],
    [
      { kind: "update-theme", envId: "env-1", body: { name: "twentytwenty" } },
      "PUT /sites/environments/env-1/themes",
      "wp.themes.update",
      '{"name":"twentytwenty"}',
    ],
    [
      { kind: "run-wp-cli", envId: "env-1", body: { command: "plugin list" } },
      "POST /sites/environments/env-1/run-wp-cli-command",
      "wp-cli.run",
      '{"command":"plugin list"}',
    ],
    [
      { kind: "set-denied-ips", body: { environment_id: "env-1", ips: [] } },
      "PUT /sites/tools/denied-ips",
      "denied-ips.set",
      '{"environment_id":"env-1","ips":[]}',
    ],
    [
      { kind: "apply-redirects", envId: "env-1", body: { rules: [] } },
      "POST /sites/environments/env-1/redirect-rules",
      "redirects.apply",
      '{"rules":[]}',
    ],
  ];

  await withKinsta(
    table.map(() => ({ body: ACTION_BODY })),
    SCOPED,
    async ({ client, requests }) => {
      for (const [request, , action] of table) {
        const result = await client.action(request);
        assert.equal(result.action, action);
        assert.equal(result.provider, "kinsta");
        assert.equal(result.status, 202);
        assert.equal(result.operationId, "op-1");
      }
      assert.deepEqual(
        lines(requests),
        table.map(([, line]) => wire(line)),
      );
      assert.deepEqual(
        requests.map((request) => request.body),
        table.map(([, , , body]) => body),
      );
      // A bodiless action must not announce a JSON content type.
      for (const [index, request] of requests.entries()) {
        assert.equal(
          request.contentType,
          request.body === "" ? null : "application/json",
          `content type for ${table[index][1]}`,
        );
      }
    },
  );
});

test("an action result falls back to the HTTP status", async () => {
  await withKinsta(
    [
      { status: 201, body: '{"operation_id":"op-9"}' },
      { status: 204, body: "" },
    ],
    SCOPED,
    async ({ client }) => {
      const created = await client.action({
        kind: "create-backup",
        envId: "env-1",
        body: { tag: "t" },
      });
      assert.equal(created.status, 201);
      assert.equal(created.operationId, "op-9");
      assert.equal(created.message, undefined);

      // An empty body parses to `null`, exactly like Go's `parseJSONBody`.
      const second = await client.action({
        kind: "create-backup",
        envId: "env-1",
      });
      assert.equal(second.status, 204);
      assert.equal(second.raw, null);
      assert.deepEqual(serializeActionResult(second), {
        provider: "kinsta",
        action: "backups.create",
        status: 204,
        raw: null,
      });
    },
  );
});

test("echoed action input secrets are redacted from successful results", async () => {
  const password = "wordpress-admin-password";
  await withKinsta(
    [
      {
        body: JSON.stringify({
          status: 202,
          message: `queued ${password}`,
          echoed: password,
        }),
      },
    ],
    SCOPED,
    async ({ client, requests }) => {
      const result = await client.action({
        kind: "create-site",
        mode: "wordpress",
        body: { admin_password: password },
      });
      assert.equal(requests[0].body.includes(password), true);
      const serialized = JSON.stringify(serializeActionResult(result));
      assert.equal(serialized.includes(password), false, serialized);
      assert.match(serialized, /\[REDACTED\]/);
    },
  );
});

test("bulk plugin updates collect the updatable inventory", async () => {
  const inventory = JSON.stringify({
    environment: {
      container_info: {
        wp_plugins: {
          data: [
            { name: "akismet", update: "available" },
            { name: "jetpack", update: "none", update_version: "13.0" },
            { name: "hello", update: "none", update_version: null },
            { name: "no-name-field", update: "none" },
            "not-an-object",
          ],
        },
      },
    },
  });

  await withKinsta(
    [{ body: inventory }, { body: ACTION_BODY }],
    SCOPED,
    async ({ client, requests }) => {
      const result = await client.action({
        kind: "bulk-update-plugins",
        envId: "env-1",
      });
      assert.deepEqual(
        lines(requests),
        [
          "GET /sites/environments/env-1/wp-plugins",
          "PUT /sites/environments/env-1/plugins/bulk-update",
        ].map(wire),
      );
      assert.deepEqual(JSON.parse(requests[1].body), {
        plugins: [{ name: "akismet" }, { name: "jetpack" }],
      });
      assert.equal(result.action, "wp.plugins.update-all");
    },
  );

  // A caller-supplied, non-empty collection is used as-is: no inventory read.
  await withKinsta(
    [{ body: ACTION_BODY }],
    SCOPED,
    async ({ client, requests }) => {
      await client.action({
        kind: "bulk-update-plugins",
        envId: "env-1",
        body: { plugins: [{ name: "akismet" }] },
      });
      assert.deepEqual(
        lines(requests),
        ["PUT /sites/environments/env-1/plugins/bulk-update"].map(wire),
      );
      assert.deepEqual(JSON.parse(requests[0].body), {
        plugins: [{ name: "akismet" }],
      });
    },
  );
});

test("bulk theme updates read the theme inventory and refuse an empty one", async () => {
  const inventory = JSON.stringify({
    environment: {
      container_info: {
        wp_themes: { data: [{ name: "twentytwenty", update: "available" }] },
      },
    },
  });

  await withKinsta(
    [{ body: inventory }, { body: ACTION_BODY }],
    SCOPED,
    async ({ client, requests }) => {
      const result = await client.action({
        kind: "bulk-update-themes",
        envId: "env-1",
        body: { themes: [] },
      });
      assert.deepEqual(
        lines(requests),
        [
          "GET /sites/environments/env-1/wp-themes",
          "PUT /sites/environments/env-1/themes/bulk-update",
        ].map(wire),
      );
      assert.deepEqual(JSON.parse(requests[1].body), {
        themes: [{ name: "twentytwenty" }],
      });
      assert.equal(result.action, "wp.themes.update-all");
    },
  );

  // Nothing to update: the mutating call is never issued.
  await withKinsta(
    [{ body: '{"environment":{"container_info":{"wp_themes":{"data":[]}}}}' }],
    SCOPED,
    async ({ client, requests }) => {
      await assert.rejects(
        client.action({ kind: "bulk-update-themes", envId: "env-1" }),
        (error) => {
          assert.equal(error.code, "not_found");
          assert.equal(error.details.provider, "kinsta");
          return true;
        },
      );
      assert.equal(requests.length, 1);
    },
  );
});

test("invalid payloads and metrics fail before any request", async () => {
  await withKinsta([], SCOPED, async ({ client, requests }) => {
    for (const request of [
      { kind: "analytics-usage", siteId: "site-1", metric: "diskspace" },
      { kind: "analytics-env", envId: "env-1", metric: "uptime" },
    ]) {
      await assert.rejects(client.read(request), { code: "usage_error" });
    }

    // Go formats these with `%d` over an unsigned integer.
    await assert.rejects(
      client.read({
        kind: "logs",
        envId: "env-1",
        fileName: "error.log",
        lines: -1,
      }),
      { code: "usage_error" },
    );
    // `objectBody` refuses a non-object create-site payload.
    await assert.rejects(
      client.action({ kind: "create-site", mode: "wordpress", body: ["nope"] }),
      { code: "usage_error" },
    );

    assert.equal(requests.length, 0);
  });
});

test("a create-site payload without a body still carries the company", async () => {
  await withKinsta(
    [{ body: ACTION_BODY }],
    SCOPED,
    async ({ client, requests }) => {
      await client.action({ kind: "create-site", mode: "wordpress" });
      assert.deepEqual(JSON.parse(requests[0].body), {
        company: "company-config",
      });
    },
  );
});

test("get-site and list-environments normalize their payloads", async () => {
  await withKinsta(
    [
      {
        body: '{"site":{"id":"site-1","name":"one","display_name":"One","status":"live"}}',
      },
      {
        body: '{"site":{"environments":[{"id":"env-1","name":"live","display_name":"Live","is_blocked":true,"is_premium":true},{"id":"env-2","name":"staging","display_name":"Staging","is_blocked":false,"is_premium":false,"primaryDomain":{"name":"staging.test"}}]}}',
      },
    ],
    SCOPED,
    async ({ client, requests }) => {
      const site = await client.getSite("site-1");
      assert.deepEqual(serializeHostingSite(site), {
        id: "site-1",
        name: "one",
        display_name: "One",
        status: "live",
      });

      const environments = await client.listEnvironments("site-1");
      assert.deepEqual(
        lines(requests),
        ["GET /sites/site-1", "GET /sites/site-1/environments"].map(wire),
      );
      assert.equal(environments.length, 2);
      assert.deepEqual(environments[0], {
        id: "env-1",
        name: "live",
        displayName: "Live",
        isBlocked: true,
        isPremium: true,
      });
      assert.equal(environments[1].primaryDomain, "staging.test");
    },
  );
});

test("a structurally wrong payload is a provider error", async () => {
  await withKinsta(
    [{ body: '{"company":{"sites":"not-a-list"}}' }],
    SCOPED,
    async ({ client }) => {
      await assert.rejects(client.listSites(), { code: "provider_error" });
    },
  );
});

test("provider failures map onto the shared taxonomy and never leak the key", async () => {
  await withKinsta(
    [{ status: 401, body: '{"message":"Invalid API key"}' }],
    SCOPED,
    async ({ client, requests, diagnostics }) => {
      await assert.rejects(
        client.read({ kind: "plugins", envId: "env-1" }),
        (error) => {
          assert.equal(error.code, "credential_invalid");
          assert.match(error.message, /HTTP 401/);
          assert.equal(error.message.includes(API_KEY), false);
          assert.equal(
            JSON.stringify(error.details ?? {}).includes(API_KEY),
            false,
          );
          return true;
        },
      );

      // The key was sent, and only as the bearer token.
      assert.equal(requests[0].authorization, `Bearer ${API_KEY}`);
      assert.equal(
        JSON.stringify(diagnostics).includes(API_KEY),
        false,
        "diagnostics must be redacted",
      );
      assert.equal(
        diagnostics.some((entry) => entry.phase === "failure"),
        true,
      );
    },
  );

  await withKinsta(
    [{ status: 404, body: '{"message":"Not found"}' }],
    SCOPED,
    async ({ client }) => {
      await assert.rejects(client.getSite("missing"), { code: "not_found" });
    },
  );

  const password = "failed-wordpress-password";
  await withKinsta(
    [{ status: 422, body: `{"message":"Rejected ${password}"}` }],
    SCOPED,
    async ({ client, requests }) => {
      await assert.rejects(
        client.action({
          kind: "create-site",
          mode: "wordpress",
          body: { admin_password: password },
        }),
        (error) => {
          const serialized = JSON.stringify({
            message: error.message,
            details: error.details,
          });
          assert.equal(serialized.includes(password), false, serialized);
          assert.match(serialized, /\[REDACTED\]/);
          return true;
        },
      );
      assert.equal(requests[0].body.includes(password), true);
    },
  );
});

test("Kinsta reports observable WP-CLI results", async () => {
  await withKinsta([], SCOPED, async ({ client }) => {
    assert.equal(wpCliResultsObservable(client), true);
  });
});
