// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract test for the Pressable provider client, ported from
 * `internal/providers/pressable_test.go`.
 *
 * The Go original drives the client against `httptest`; this suite binds a
 * `node:http` server to 127.0.0.1:0 and asserts on the method, request target,
 * authorization header and request body of every call, then answers with
 * recorded-shape fixtures. Nothing here touches a real Pressable account: the
 * client id and secret are obvious fakes and every server is closed in a
 * `finally` block so the test process exits.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  ACTION_REQUEST_KINDS,
  READ_REQUEST_KINDS,
} from "../dist/hosting/client.js";
import { createHttpClient } from "../dist/hosting/http-client.js";
import {
  serializeActionResult,
  serializeHostingSite,
  serializeOperationStatus,
  serializeProviderValidation,
} from "../dist/hosting/types.js";
import { createPressableClient } from "../dist/hosting/providers/pressable.js";
import { envCredential } from "../dist/config/schema.js";
import { SecretValue } from "../dist/credentials/store.js";

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const CREDENTIAL_SOURCE = "env:PRESSABLE_CLIENT_SECRET";
const TOKEN_BODY = `{"access_token":"test-token","token_type":"Bearer","expires_in":3600}`;

/* -------------------------------------------------------------------------- */
/* Mock Pressable API                                                         */
/* -------------------------------------------------------------------------- */

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * A Pressable mock. `/auth/token` always answers the OAuth2 client-credentials
 * exchange (overridable per suite); every other request is matched positionally
 * against `routes`, exactly like the Go helper's `idx` cursor. Observations are
 * recorded rather than asserted inside the handler so a mismatch surfaces as a
 * normal assertion in the test body.
 */
async function startPressableServer(routes = [], options = {}) {
  const record = { requests: [], tokenRequests: [], unexpected: [] };
  let cursor = 0;

  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const line = `${request.method} ${request.url}`;

      if (request.url === "/auth/token") {
        record.tokenRequests.push({ line, body });
        const token = options.token ?? { status: 200, body: TOKEN_BODY };
        response.writeHead(token.status, {
          "content-type": "application/json",
        });
        response.end(token.body);
        return;
      }

      const route = routes[cursor];
      cursor += 1;
      record.requests.push({
        line,
        authorization: request.headers.authorization ?? "",
        accept: request.headers.accept ?? "",
        contentType: request.headers["content-type"] ?? "",
        body,
      });
      if (route === undefined) {
        record.unexpected.push(line);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(`{"message":"unexpected request"}`);
        return;
      }
      response.writeHead(route.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(route.body ?? "");
    })();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    record,
    lines: () => record.requests.map((entry) => entry.line),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A hand-made `ProviderClientContext`, the exact shape the factory hands over. */
function pressableContext(server, overrides = {}) {
  const baseUrl = overrides.baseUrl ?? `${server.url}/v1`;
  const diagnostics = overrides.diagnostics ?? [];
  return {
    provider: "pressable",
    providerLabel: "Pressable",
    profileName: "pressable-test",
    profile: {
      provider: "pressable",
      credential: envCredential("PRESSABLE_CLIENT_SECRET"),
      companyId: CLIENT_ID,
    },
    baseUrl,
    secret: new SecretValue(
      overrides.secret ?? CLIENT_SECRET,
      "env",
      CREDENTIAL_SOURCE,
    ),
    credentialSource: CREDENTIAL_SOURCE,
    companyId: CLIENT_ID,
    identity: "identity" in overrides ? overrides.identity : CLIENT_ID,
    tokenUrl: overrides.tokenUrl ?? `${server.url}/auth/token`,
    env: {},
    createHttpClient: (httpOverrides) =>
      createHttpClient({
        baseUrl,
        providerLabel: "Pressable",
        // Deterministic: no retry storms against the mock, no real backoff.
        retry: { maxAttempts: 1 },
        timeoutMs: 5_000,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        ...httpOverrides,
      }),
  };
}

async function pressableClient(server, overrides = {}) {
  return createPressableClient(pressableContext(server, overrides));
}

/** Every request the client made carried the exchanged bearer token. */
function assertAuthenticated(server) {
  for (const entry of server.record.requests) {
    assert.equal(entry.authorization, "Bearer test-token");
  }
}

/* -------------------------------------------------------------------------- */
/* Validate                                                                   */
/* -------------------------------------------------------------------------- */

test("validates credentials against /account", async () => {
  const server = await startPressableServer([
    {
      body: `{"message":"Success","data":{"email":"user@example.com","name":"John Doe","organization":"Personal"},"errors":null}`,
    },
  ]);
  try {
    const client = await pressableClient(server);
    assert.equal(client.provider, "pressable");

    const validation = await client.validate();
    assert.deepEqual(serializeProviderValidation(validation), {
      provider: "pressable",
      status: "active",
      company_id: "user@example.com",
      credential: CREDENTIAL_SOURCE,
    });
    assert.deepEqual(server.lines(), ["GET /v1/account"]);
    assertAuthenticated(server);

    // The token exchange is an anonymous, form-encoded client_credentials POST.
    assert.equal(server.record.tokenRequests.length, 1);
    const token = server.record.tokenRequests[0];
    assert.equal(token.line, "POST /auth/token");
    assert.deepEqual(
      Object.fromEntries(new URLSearchParams(token.body).entries()),
      {
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      },
    );
  } finally {
    await server.close();
  }
});

test("a non-Success validation envelope is a provider error", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Unauthorized","data":null,"errors":["nope"]}` },
  ]);
  try {
    const client = await pressableClient(server);
    await assert.rejects(client.validate(), (error) => {
      assert.equal(error.code, "provider_error");
      assert.match(error.message, /Unauthorized/);
      return true;
    });
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* -------------------------------------------------------------------------- */

test("lists sites and synthesizes one environment per site", async () => {
  const server = await startPressableServer([
    {
      body: `{"message":"Success","data":[{"id":123,"name":"my-site","displayName":"My Site","state":"live","url":"https://my-site.pressable.com","staging":false,"sandbox":false,"phpVersion":"8.2","ecommerce":false}],"page":{"currentPage":1,"nextPage":0,"lastPage":1,"perPage":50,"totalItems":1},"errors":null}`,
    },
  ]);
  try {
    const client = await pressableClient(server);
    const sites = await client.listSites({ includeEnvironments: true });

    assert.equal(sites.length, 1);
    assert.deepEqual(serializeHostingSite(sites[0]), {
      id: "123",
      name: "my-site",
      display_name: "My Site",
      status: "active",
      primary_domain: "https://my-site.pressable.com",
      environments: [
        {
          id: "123",
          name: "live",
          display_name: "My Site",
          is_blocked: false,
          is_premium: false,
          primary_domain: "https://my-site.pressable.com",
        },
      ],
    });
    assert.deepEqual(server.lines(), ["GET /v1/sites?page=1&per_page=50"]);
    assertAuthenticated(server);
  } finally {
    await server.close();
  }
});

test("omits environments unless the caller asks for them", async () => {
  const server = await startPressableServer([
    {
      body: `{"message":"Success","data":[{"id":7,"name":"solo","state":"disabled","url":"","staging":true,"ecommerce":true}],"page":null,"errors":null}`,
    },
  ]);
  try {
    const client = await pressableClient(server);
    const sites = await client.listSites();

    // No url: the site name becomes the primary domain (Go's primaryDomain()).
    // displayName falls back to name, and "disabled" maps to "suspended".
    assert.deepEqual(serializeHostingSite(sites[0]), {
      id: "7",
      name: "solo",
      display_name: "solo",
      status: "suspended",
      primary_domain: "solo",
    });
  } finally {
    await server.close();
  }
});

test("getSite synthesizes an environment and listEnvironments returns it", async () => {
  const siteBody = `{"message":"Success","data":{"id":123,"name":"my-site","displayName":"My Site","state":"live","url":"https://my-site.pressable.com","staging":true,"sandbox":false,"phpVersion":"8.2"},"errors":null}`;
  const server = await startPressableServer([
    { body: siteBody },
    { body: siteBody },
  ]);
  try {
    const client = await pressableClient(server);

    const site = await client.getSite("123");
    assert.equal(site.environments.length, 1);
    assert.equal(site.environments[0].name, "staging");

    const environments = await client.listEnvironments("123");
    assert.deepEqual(environments, site.environments);
    assert.deepEqual(server.lines(), [
      "GET /v1/sites/123",
      "GET /v1/sites/123",
    ]);
  } finally {
    await server.close();
  }
});

test("paginates /sites until the last page", async () => {
  const server = await startPressableServer([
    {
      body: `{"message":"Success","data":[{"id":1,"name":"site-1","state":"live","url":"https://site-1.pressable.com"}],"page":{"currentPage":1,"nextPage":2,"lastPage":2,"perPage":50,"totalItems":2},"errors":null}`,
    },
    {
      body: `{"message":"Success","data":[{"id":2,"name":"site-2","state":"live","url":"https://site-2.pressable.com"}],"page":{"currentPage":2,"nextPage":0,"lastPage":2,"perPage":50,"totalItems":2},"errors":null}`,
    },
  ]);
  try {
    const client = await pressableClient(server);
    const sites = await client.listSites({ includeEnvironments: false });

    assert.deepEqual(
      sites.map((site) => site.id),
      ["1", "2"],
    );
    assert.equal(sites[0].environments, undefined);
    assert.deepEqual(server.lines(), [
      "GET /v1/sites?page=1&per_page=50",
      "GET /v1/sites?page=2&per_page=50",
    ]);
  } finally {
    await server.close();
  }
});

test("a non-Success /sites envelope is a provider error", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Throttled","data":[],"errors":null}` },
  ]);
  try {
    const client = await pressableClient(server);
    await assert.rejects(client.listSites(), { code: "provider_error" });
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

test("creates a site with POST /sites", async () => {
  const server = await startPressableServer([
    {
      body: `{"message":"Success","data":{"id":456,"name":"new-site","displayName":"New Site","state":"live","url":"https://new-site.pressable.com"},"errors":null}`,
    },
  ]);
  try {
    const client = await pressableClient(server);
    const result = await client.action({
      kind: "create-site",
      mode: "wordpress",
      body: { name: "new-site", url: "new-site.pressable.com" },
    });

    assert.equal(result.provider, "pressable");
    assert.equal(result.action, "sites.create");
    assert.equal(result.status, 200);
    assert.equal(result.message, "Success");
    assert.equal(result.raw.data.id, 456);
    assert.equal(result.operationId, undefined);

    assert.deepEqual(server.lines(), ["POST /v1/sites"]);
    assert.deepEqual(JSON.parse(server.record.requests[0].body), {
      name: "new-site",
      url: "new-site.pressable.com",
    });
    assert.match(server.record.requests[0].contentType, /application\/json/);
  } finally {
    await server.close();
  }
});

test("deletes a site with DELETE /sites/{id}", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Success","data":null,"errors":null}` },
  ]);
  try {
    const client = await pressableClient(server);
    const result = await client.action({ kind: "delete-site", siteId: "123" });

    assert.equal(result.action, "sites.delete");
    assert.deepEqual(server.lines(), ["DELETE /v1/sites/123"]);
    assert.equal(server.record.requests[0].body, "");
  } finally {
    await server.close();
  }
});

test("clears the object cache using the site id carried in the body", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Success","data":null,"errors":null}` },
    { body: `{"message":"Success","data":null,"errors":null}` },
  ]);
  try {
    const client = await pressableClient(server);

    const result = await client.action({
      kind: "clear-cache",
      cache: "site",
      body: { site_id: "123" },
    });
    assert.equal(result.action, "cache.clear");

    // Any of the accepted aliases resolves the site id.
    await client.action({
      kind: "clear-cache",
      cache: "edge",
      body: { envId: "456" },
    });

    assert.deepEqual(server.lines(), [
      "DELETE /v1/sites/123/object-cache",
      "DELETE /v1/sites/456/object-cache",
    ]);
  } finally {
    await server.close();
  }
});

test("clearing the cache without a site id is a usage error", async () => {
  const server = await startPressableServer([]);
  try {
    const client = await pressableClient(server);
    for (const body of [undefined, {}, { site_id: "" }]) {
      await assert.rejects(
        client.action({ kind: "clear-cache", cache: "site", body }),
        { code: "usage_error" },
      );
    }
    assert.deepEqual(server.lines(), []);
  } finally {
    await server.close();
  }
});

test("adds a domain with POST /sites/{id}/domains", async () => {
  const server = await startPressableServer([
    {
      body: `{"message":"Success","data":{"id":9,"domain":"example.test"},"errors":null}`,
    },
  ]);
  try {
    const client = await pressableClient(server);
    const result = await client.action({
      kind: "add-domain",
      envId: "123",
      body: { domain: "example.test" },
    });

    assert.equal(result.action, "domains.add");
    assert.deepEqual(server.lines(), ["POST /v1/sites/123/domains"]);
    assert.deepEqual(JSON.parse(server.record.requests[0].body), {
      domain: "example.test",
    });
  } finally {
    await server.close();
  }
});

test("deletes a single domain from the CLI domain_ids payload", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Success","data":null,"errors":null}` },
  ]);
  try {
    const client = await pressableClient(server);
    const result = await client.action({
      kind: "delete-domains",
      envId: "123",
      body: { domain_ids: ["456"] },
    });

    assert.equal(result.action, "domains.delete");
    assert.equal(result.status, 200);
    assert.deepEqual(server.lines(), ["DELETE /v1/sites/123/domains/456"]);
  } finally {
    await server.close();
  }
});

test("deletes several domains one by one and aggregates the raw bodies", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Success","data":{"id":1},"errors":null}` },
    { body: `{"message":"Success","data":{"id":2},"errors":null}` },
  ]);
  try {
    const client = await pressableClient(server);
    const result = await client.action({
      kind: "delete-domains",
      envId: "123",
      body: { domain_ids: [1, "2"] },
    });

    assert.deepEqual(serializeActionResult(result), {
      provider: "pressable",
      action: "domains.delete",
      status: 200,
      message: "Success",
      raw: {
        message: "Success",
        data: [
          { message: "Success", data: { id: 1 }, errors: null },
          { message: "Success", data: { id: 2 }, errors: null },
        ],
        errors: null,
      },
    });
    assert.deepEqual(server.lines(), [
      "DELETE /v1/sites/123/domains/1",
      "DELETE /v1/sites/123/domains/2",
    ]);
  } finally {
    await server.close();
  }
});

test("accepts domain_id and id, and rejects an unusable domain payload", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Success","data":null,"errors":null}` },
    { body: `{"message":"Success","data":null,"errors":null}` },
  ]);
  try {
    const client = await pressableClient(server);
    await client.action({
      kind: "delete-domains",
      envId: "s",
      body: { domain_id: "11" },
    });
    await client.action({
      kind: "delete-domains",
      envId: "s",
      body: { id: 12 },
    });
    assert.deepEqual(server.lines(), [
      "DELETE /v1/sites/s/domains/11",
      "DELETE /v1/sites/s/domains/12",
    ]);

    for (const body of [
      undefined,
      {},
      { domain_ids: [] },
      { domain_ids: ["ok", ""] },
      { domain_ids: "not-an-array" },
      { domain_id: null },
    ]) {
      await assert.rejects(
        client.action({ kind: "delete-domains", envId: "s", body }),
        { code: "usage_error" },
      );
    }
    assert.equal(server.record.requests.length, 2);
  } finally {
    await server.close();
  }
});

test("runs WP-CLI, translating wp_command into a commands array", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Success","data":{"output":"done"},"errors":null}` },
    { body: `{"message":"Success","data":{"output":"done"},"errors":null}` },
  ]);
  try {
    const client = await pressableClient(server);
    const result = await client.action({
      kind: "run-wp-cli",
      envId: "123",
      body: { wp_command: "wp plugin list" },
    });

    assert.equal(result.action, "wp-cli.run");
    assert.deepEqual(server.lines(), ["POST /v1/sites/123/wordpress/wpcli"]);
    assert.deepEqual(JSON.parse(server.record.requests[0].body), {
      commands: ["plugin list"],
    });

    // A Pressable-native payload passes straight through.
    await client.action({
      kind: "run-wp-cli",
      envId: "123",
      body: { commands: ["core version"] },
    });
    assert.deepEqual(JSON.parse(server.record.requests[1].body), {
      commands: ["core version"],
    });
  } finally {
    await server.close();
  }
});

test("WP-CLI without wp_command or commands is a usage error", async () => {
  const server = await startPressableServer([]);
  try {
    const client = await pressableClient(server);
    for (const body of [undefined, {}, { command: "plugin list" }]) {
      await assert.rejects(
        client.action({ kind: "run-wp-cli", envId: "1", body }),
        { code: "usage_error" },
      );
    }
    assert.deepEqual(server.lines(), []);
  } finally {
    await server.close();
  }
});

test("a failing action surfaces the provider status and message", async () => {
  const server = await startPressableServer([
    {
      status: 422,
      body: `{"message":"Site name already taken","data":null,"errors":["taken"]}`,
    },
  ]);
  try {
    const client = await pressableClient(server);
    await assert.rejects(
      client.action({ kind: "create-site", mode: "wordpress", body: {} }),
      (error) => {
        assert.equal(error.code, "schema_validation_failed");
        assert.match(error.message, /Site name already taken/);
        assert.equal(error.details.status, 422);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

test("reads the datacenter list for regions", async () => {
  const server = await startPressableServer([
    {
      body: `{"message":"Available datacenter options","data":[{"code":"DCA","name":"Washington, DC, USA"}],"errors":null}`,
    },
  ]);
  try {
    const client = await pressableClient(server);
    const raw = await client.read({ kind: "regions" });

    assert.equal(raw.data[0].code, "DCA");
    assert.deepEqual(server.lines(), ["GET /v1/sites/datacenters"]);
  } finally {
    await server.close();
  }
});

test("reads plugins for a site", async () => {
  const server = await startPressableServer([
    {
      body: `{"message":"Success","data":[{"name":"novamira","title":"Novamira","status":"active","version":"1.7.0"}],"errors":null}`,
    },
  ]);
  try {
    const client = await pressableClient(server);
    const raw = await client.read({ kind: "plugins", envId: "123" });

    assert.equal(raw.data[0].name, "novamira");
    assert.deepEqual(server.lines(), ["GET /v1/sites/123/plugins"]);
  } finally {
    await server.close();
  }
});

test("maps the log file name onto the php and webserver log endpoints", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Success","data":[],"errors":null}` },
    { body: `{"message":"Success","data":[],"errors":null}` },
  ]);
  try {
    const client = await pressableClient(server);
    await client.read({
      kind: "logs",
      envId: "123",
      fileName: "error",
      lines: 100,
    });
    await client.read({
      kind: "logs",
      envId: "123",
      fileName: "access",
      lines: 100,
    });

    assert.deepEqual(server.lines(), [
      "GET /v1/sites/123/logs/php",
      "GET /v1/sites/123/logs/webserver",
    ]);

    await assert.rejects(
      client.read({
        kind: "logs",
        envId: "123",
        fileName: "slow",
        lines: 10,
      }),
      { code: "usage_error" },
    );
    assert.equal(server.record.requests.length, 2);
  } finally {
    await server.close();
  }
});

test("reads domains, backups, sftp accounts, statistics and DNS zones", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Success","data":[],"errors":null}` },
    { body: `{"message":"Success","data":[],"errors":null}` },
    { body: `{"message":"Success","data":[],"errors":null}` },
    { body: `{"message":"Success","data":{},"errors":null}` },
    { body: `{"message":"Success","data":[],"errors":null}` },
  ]);
  try {
    const client = await pressableClient(server);
    await client.read({ kind: "site-domains", envId: "123" });
    await client.read({ kind: "backups", envId: "123" });
    await client.read({ kind: "sftp-accounts", envId: "123" });
    await client.read({ kind: "analytics-usage", siteId: "123", metric: "" });
    await client.read({ kind: "dns-domains" });

    assert.deepEqual(server.lines(), [
      "GET /v1/sites/123/domains",
      "GET /v1/sites/123/backups",
      "GET /v1/sites/123/ftp",
      "GET /v1/sites/123/statistics",
      "GET /v1/dns/zones",
    ]);
    assertAuthenticated(server);
  } finally {
    await server.close();
  }
});

test("an empty response body reads back as null", async () => {
  const server = await startPressableServer([{ status: 204, body: "" }]);
  try {
    const client = await pressableClient(server);
    assert.equal(await client.read({ kind: "regions" }), null);
  } finally {
    await server.close();
  }
});

test("reports the capability matrix without any network call", async () => {
  const server = await startPressableServer([]);
  try {
    const client = await pressableClient(server);
    const capabilities = await client.read({ kind: "capabilities" });

    assert.equal(Array.isArray(capabilities), true);
    const byName = new Map(
      capabilities.map((capability) => [capability.name, capability]),
    );
    assert.deepEqual(byName.get("sites.list"), {
      name: "sites.list",
      supported: true,
    });
    assert.deepEqual(byName.get("wp-cli.run"), {
      name: "wp-cli.run",
      supported: true,
      notes: "uses POST /sites/{id}/wordpress/wpcli",
    });
    assert.deepEqual(byName.get("sites.clone"), {
      name: "sites.clone",
      supported: false,
      notes: "not supported by Pressable's provider-neutral Novamira mapping",
    });
    assert.deepEqual(byName.get("envs.list"), {
      name: "envs.list",
      supported: false,
      notes: "not mapped for Pressable in Novamira",
    });
    assert.equal(byName.get("access.ssh").supported, false);
    assert.equal(byName.get("access.sftp").supported, true);

    // Reading capabilities never reaches the API and never needs a token.
    assert.deepEqual(server.lines(), []);
    assert.deepEqual(server.record.tokenRequests, []);
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Activity                                                                   */
/* -------------------------------------------------------------------------- */

test("forwards activity query filters as a POST body", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Success","data":[],"errors":null}` },
  ]);
  try {
    const client = await pressableClient(server);
    await client.read({
      kind: "activity",
      query: [
        ["limit", "10"],
        ["offset", "20"],
        ["site_id", "123"],
        ["category", "deploy"],
      ],
    });

    assert.deepEqual(server.lines(), ["POST /v1/sites/123/logs/activity"]);
    assert.deepEqual(JSON.parse(server.record.requests[0].body), {
      page: 3,
      per_page: 10,
      filters: [{ field: "action", operator: "contains", value: "deploy" }],
    });
  } finally {
    await server.close();
  }
});

test("activity without a site id targets the account log", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Success","data":[],"errors":null}` },
    { body: `{"message":"Success","data":[],"errors":null}` },
  ]);
  try {
    const client = await pressableClient(server);
    await client.read({ kind: "activity" });
    await client.read({
      kind: "activity",
      query: [
        ["limit", "500"],
        ["id_initiated_by", "user@example.com"],
        ["site_id", ""],
      ],
    });

    assert.deepEqual(server.lines(), [
      "POST /v1/account/logs/activity",
      "POST /v1/account/logs/activity",
    ]);
    assert.deepEqual(JSON.parse(server.record.requests[0].body), {
      page: 1,
      per_page: 10,
    });
    // The limit is clamped to Pressable's maximum page size of 50.
    assert.deepEqual(JSON.parse(server.record.requests[1].body), {
      page: 1,
      per_page: 50,
      filters: [
        {
          field: "account_email",
          operator: "equals",
          value: "user@example.com",
        },
      ],
    });
  } finally {
    await server.close();
  }
});

test("rejects an invalid or unmappable activity filter", async () => {
  const server = await startPressableServer([]);
  try {
    const client = await pressableClient(server);
    for (const query of [
      [["limit", "0"]],
      [["limit", "abc"]],
      [["offset", "-1"]],
      [["offset", "1.5"]],
    ]) {
      await assert.rejects(client.read({ kind: "activity", query }), {
        code: "usage_error",
      });
    }
    await assert.rejects(
      client.read({ kind: "activity", query: [["status", "failed"]] }),
      (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.equal(error.details.filter, "status");
        return true;
      },
    );
    assert.deepEqual(server.lines(), []);
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Unsupported surface                                                        */
/* -------------------------------------------------------------------------- */

const SUPPORTED_READS = new Set([
  "capabilities",
  "regions",
  "activity",
  "site-domains",
  "dns-domains",
  "backups",
  "logs",
  "plugins",
  "sftp-accounts",
  "analytics-usage",
]);

const SUPPORTED_ACTIONS = new Set([
  "create-site",
  "delete-site",
  "clear-cache",
  "add-domain",
  "delete-domains",
  "run-wp-cli",
]);

test("every unmapped read and action reports provider_unsupported", async () => {
  const server = await startPressableServer([]);
  try {
    const client = await pressableClient(server);

    for (const kind of READ_REQUEST_KINDS) {
      if (SUPPORTED_READS.has(kind)) continue;
      await assert.rejects(
        client.read({ kind, envId: "1", siteId: "1", domainId: "1" }),
        (error) => {
          assert.equal(error.code, "provider_unsupported");
          assert.equal(error.details.request, kind);
          assert.match(error.message, /^Pressable does not support /);
          return true;
        },
        `read ${kind}`,
      );
    }

    for (const kind of ACTION_REQUEST_KINDS) {
      if (SUPPORTED_ACTIONS.has(kind)) continue;
      await assert.rejects(
        client.action({ kind, siteId: "1", envId: "1", body: {} }),
        (error) => {
          assert.equal(error.code, "provider_unsupported");
          assert.equal(error.details.action, kind);
          return true;
        },
        `action ${kind}`,
      );
    }

    // Nothing above reached the network.
    assert.deepEqual(server.lines(), []);
  } finally {
    await server.close();
  }
});

test("an unknown request kind is an internal error, not a silent no-op", async () => {
  const server = await startPressableServer([]);
  try {
    const client = await pressableClient(server);
    await assert.rejects(client.read({ kind: "not-a-read" }), {
      code: "internal_error",
    });
    await assert.rejects(client.action({ kind: "not-an-action" }), {
      code: "internal_error",
    });
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Operations and WP-CLI observability                                        */
/* -------------------------------------------------------------------------- */

test("operation status is always reported complete", async () => {
  const server = await startPressableServer([]);
  try {
    const client = await pressableClient(server);
    const status = await client.operationStatus("any-id");

    assert.deepEqual(serializeOperationStatus(status), {
      provider: "pressable",
      operation_id: "any-id",
      status: 200,
      done: true,
      failed: false,
      message: "Pressable does not support async operation status polling",
      raw: null,
    });
    assert.deepEqual(server.lines(), []);
  } finally {
    await server.close();
  }
});

test("WP-CLI results are not observable", async () => {
  const server = await startPressableServer([]);
  try {
    const client = await pressableClient(server);
    assert.equal(client.wpCliResultsObservable(), false);
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Token handling                                                             */
/* -------------------------------------------------------------------------- */

test("exchanges the client credentials once and reuses the token", async () => {
  const account = `{"message":"Success","data":{"email":"test@example.com","name":"Test"},"errors":null}`;
  const server = await startPressableServer([
    { body: account },
    { body: account },
  ]);
  try {
    const client = await pressableClient(server);
    await client.validate();
    assert.equal(server.record.tokenRequests.length, 1);

    await client.validate();
    assert.equal(server.record.tokenRequests.length, 1);
    assertAuthenticated(server);
  } finally {
    await server.close();
  }
});

test("concurrent requests share a single token exchange", async () => {
  const account = `{"message":"Success","data":{"email":"test@example.com"},"errors":null}`;
  const server = await startPressableServer([
    { body: account },
    { body: account },
    { body: account },
  ]);
  try {
    const client = await pressableClient(server);
    await Promise.all([
      client.validate(),
      client.validate(),
      client.validate(),
    ]);
    assert.equal(server.record.tokenRequests.length, 1);
  } finally {
    await server.close();
  }
});

test("the token endpoint is rebased onto the configured API origin", async () => {
  const server = await startPressableServer([
    { body: `{"message":"Success","data":{"email":"a@b.test"},"errors":null}` },
  ]);
  try {
    // A profile with a custom apiBaseUrl keeps the default production token URL
    // in PROVIDER_DEFAULTS; the client must follow the profile's origin.
    const client = await pressableClient(server, {
      tokenUrl: "https://my.pressable.com/auth/token",
    });
    await client.validate();
    assert.equal(server.record.tokenRequests.length, 1);
    assert.equal(server.record.tokenRequests[0].line, "POST /auth/token");
  } finally {
    await server.close();
  }
});

test("a token response without an access_token is a provider error", async () => {
  const server = await startPressableServer([], {
    token: { status: 200, body: `{"token_type":"Bearer","expires_in":3600}` },
  });
  try {
    const client = await pressableClient(server);
    await assert.rejects(client.validate(), (error) => {
      assert.equal(error.code, "provider_error");
      assert.match(error.message, /access_token/);
      return true;
    });
    assert.deepEqual(server.lines(), []);
  } finally {
    await server.close();
  }
});

test("a rejected token exchange surfaces as credential_invalid", async () => {
  const server = await startPressableServer([], {
    token: { status: 401, body: `{"message":"invalid client"}` },
  });
  try {
    const client = await pressableClient(server);
    await assert.rejects(client.validate(), { code: "credential_invalid" });
  } finally {
    await server.close();
  }
});

test("a missing client id fails before any network call", async () => {
  const server = await startPressableServer([]);
  try {
    for (const identity of [undefined, "", "   "]) {
      assert.throws(
        () => createPressableClient(pressableContext(server, { identity })),
        (error) => {
          assert.equal(error.code, "credential_missing");
          assert.match(error.message, /PRESSABLE_CLIENT_ID/);
          return true;
        },
      );
    }
    assert.throws(
      () => createPressableClient(pressableContext(server, { secret: "" })),
      { code: "credential_missing" },
    );
    assert.deepEqual(server.record.tokenRequests, []);
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Secret hygiene                                                             */
/* -------------------------------------------------------------------------- */

test("no credential ever reaches an error, a diagnostic or a result", async () => {
  const diagnostics = [];
  // The token endpoint echoes the client secret back in its error body, and the
  // API echoes the bearer token: both must be scrubbed before they surface.
  const server = await startPressableServer([], {
    token: {
      status: 400,
      body: `{"message":"invalid_client: ${CLIENT_SECRET} is not valid"}`,
    },
  });
  try {
    const client = await pressableClient(server, { diagnostics });
    await assert.rejects(client.validate(), (error) => {
      const serialized = JSON.stringify({
        message: error.message,
        details: error.details,
      });
      assert.equal(serialized.includes(CLIENT_SECRET), false);
      assert.match(error.message, /REDACTED/);
      return true;
    });
    assert.equal(
      JSON.stringify(diagnostics).includes(CLIENT_SECRET),
      false,
      "diagnostics leaked the client secret",
    );
  } finally {
    await server.close();
  }

  const echo = await startPressableServer([
    {
      status: 500,
      body: `{"message":"upstream said Bearer test-token was rejected"}`,
    },
  ]);
  try {
    const client = await pressableClient(echo, { diagnostics });
    await assert.rejects(client.read({ kind: "regions" }), (error) => {
      assert.equal(error.message.includes("test-token"), false);
      return true;
    });

    const validation = JSON.stringify(diagnostics);
    assert.equal(validation.includes(CLIENT_SECRET), false);
    assert.equal(validation.includes("test-token"), false);
  } finally {
    await echo.close();
  }
});
