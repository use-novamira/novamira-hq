// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract tests for the Hostinger provider client, ported from
 * `internal/providers/hostinger_test.go`.
 *
 * The Go suite drives an `httptest.Server` that replays a fixed sequence of
 * routes and asserts the request line plus the `Authorization` header. This file
 * does the same with a `node:http` server bound to 127.0.0.1 on an ephemeral
 * port. No test performs a live provider call, and the only credential is an
 * obvious placeholder.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { SecretValue } from "../dist/credentials/resolve.js";
import { envCredential } from "../dist/config/schema.js";
import { createHttpClient } from "../dist/hosting/http-client.js";
import { serializeActionResult } from "../dist/hosting/types.js";
import { createHostingerClient } from "../dist/hosting/providers/hostinger.js";

/** Never a real token: these tests only prove the header travels and is scrubbed. */
const TOKEN = "placeholder-not-a-secret";
const CREDENTIAL_SOURCE = "env:HOSTINGER_API_TOKEN";

/**
 * A replay server shaped like `startHostingerTestServer`: each request must
 * match the next expected `"METHOD /path?query"` line, and must carry the bearer
 * token. Mismatches are recorded and asserted by the caller through `finish()`.
 */
async function startServer(routes) {
  const problems = [];
  const seen = [];
  let index = 0;

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const line = `${request.method} ${request.url}`;
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({
        line,
        body,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
      });
      const route = routes[index];
      index += 1;
      if (route === undefined) {
        problems.push(`unexpected request: ${line}`);
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"message":"unexpected"}');
        return;
      }
      if (line !== route.expected) {
        problems.push(
          `request line mismatch: got ${line} want ${route.expected}`,
        );
      }
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        problems.push(
          `authorization header = ${String(request.headers.authorization)}, want Bearer ${TOKEN}`,
        );
      }
      response.writeHead(route.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(route.body ?? "");
    });
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    /** Assert every route was consumed and nothing went wrong, then close. */
    async finish({ expectAllRoutes = true } = {}) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      assert.deepEqual(problems, []);
      if (expectAllRoutes) assert.equal(index, routes.length);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** The `ProviderClientContext` the factory would hand a real provider module. */
function context(baseUrl, overrides = {}) {
  return {
    provider: "hostinger",
    providerLabel: "Hostinger",
    profileName: "production",
    profile: {
      provider: "hostinger",
      credential: envCredential("HOSTINGER_API_TOKEN"),
    },
    baseUrl,
    secret: new SecretValue(TOKEN, "env", CREDENTIAL_SOURCE),
    credentialSource: CREDENTIAL_SOURCE,
    companyId: undefined,
    identity: undefined,
    tokenUrl: undefined,
    env: {},
    createHttpClient(options = {}) {
      return createHttpClient({
        baseUrl,
        providerLabel: "Hostinger",
        // Deterministic: the Go client never retries, so neither may the test.
        retry: { maxAttempts: 1 },
        ...options,
      });
    },
    ...overrides,
  };
}

function client(baseUrl, overrides) {
  return createHostingerClient(context(baseUrl, overrides));
}

const WEBSITE = {
  domain: "example.com",
  vhost_type: "main",
  is_enabled: true,
  username: "u123",
  order_id: 42,
};

/* -------------------------------------------------------------------------- */
/* Ported directly from hostinger_test.go                                      */
/* -------------------------------------------------------------------------- */

// TestHostingerValidatesCredentials
test("hostinger validates credentials", async () => {
  const server = await startServer([
    {
      expected: "GET /api/hosting/v1/websites?page=1&per_page=1",
      body: JSON.stringify({
        data: [WEBSITE],
        meta: { current_page: 1, per_page: 1, total: 1 },
      }),
    },
  ]);
  try {
    const validation = await client(server.baseUrl).validate();
    assert.equal(validation.provider, "hostinger");
    assert.equal(validation.status, "active");
    assert.equal(validation.companyId, "u123");
    assert.equal(validation.credential, CREDENTIAL_SOURCE);
  } finally {
    await server.finish();
  }
});

// The profile's companyId wins over the account username in the response.
test("hostinger validate prefers the configured company id", async () => {
  const server = await startServer([
    {
      expected: "GET /api/hosting/v1/websites?page=1&per_page=1",
      body: JSON.stringify({
        data: [WEBSITE],
        meta: { current_page: 1, per_page: 1, total: 1 },
      }),
    },
  ]);
  try {
    const validation = await client(server.baseUrl, {
      companyId: "configured",
    }).validate();
    assert.equal(validation.companyId, "configured");
  } finally {
    await server.finish();
  }
});

// `company_id` carries no `omitempty` in Go, so an unknown account is null.
test("hostinger validate reports a null company id when unknown", async () => {
  const server = await startServer([
    {
      expected: "GET /api/hosting/v1/websites?page=1&per_page=1",
      body: JSON.stringify({
        data: [],
        meta: { current_page: 1, per_page: 1, total: 0 },
      }),
    },
  ]);
  try {
    const validation = await client(server.baseUrl).validate();
    assert.equal(validation.companyId, null);
  } finally {
    await server.finish();
  }
});

// TestHostingerListsSites
test("hostinger lists sites", async () => {
  const server = await startServer([
    {
      expected: "GET /api/hosting/v1/websites?page=1&per_page=50",
      body: JSON.stringify({
        data: [WEBSITE],
        meta: { current_page: 1, per_page: 50, total: 1 },
      }),
    },
  ]);
  try {
    const sites = await client(server.baseUrl).listSites({
      includeEnvironments: true,
    });
    assert.equal(sites.length, 1);
    assert.equal(sites[0].id, "example.com");
    assert.equal(sites[0].name, "example.com");
    assert.equal(sites[0].displayName, "example.com (main)");
    assert.equal(sites[0].status, "active");
    assert.equal(sites[0].primaryDomain, "example.com");
    assert.equal(sites[0].environments.length, 1);
    const environment = sites[0].environments[0];
    assert.equal(environment.id, "u123:example.com");
    assert.equal(environment.name, "live");
    assert.equal(environment.displayName, "Live");
    assert.equal(environment.isBlocked, false);
    assert.equal(environment.isPremium, false);
    assert.equal(environment.primaryDomain, "example.com");
  } finally {
    await server.finish();
  }
});

// TestHostingerListsSitesReturnsEmptySlice
test("hostinger lists sites returns an empty array", async () => {
  const server = await startServer([
    {
      expected: "GET /api/hosting/v1/websites?page=1&per_page=50",
      body: JSON.stringify({
        data: [],
        meta: { current_page: 1, per_page: 50, total: 0 },
      }),
    },
  ]);
  try {
    const sites = await client(server.baseUrl).listSites({
      includeEnvironments: true,
    });
    assert.ok(Array.isArray(sites));
    assert.equal(sites.length, 0);
  } finally {
    await server.finish();
  }
});

// TestHostingerRegionsRequireOrderID
test("hostinger regions require an order id", async () => {
  const server = await startServer([]);
  try {
    await assert.rejects(
      client(server.baseUrl).read({ kind: "regions" }),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.match(error.message, /order_id/);
        return true;
      },
    );
    await assert.rejects(
      client(server.baseUrl).read({ kind: "regions", companyId: "" }),
      (error) => error.code === "usage_error",
    );
  } finally {
    await server.finish();
  }
});

// TestHostingerReadsRegions
test("hostinger reads regions", async () => {
  const server = await startServer([
    {
      expected: "GET /api/hosting/v1/datacenters?order_id=42",
      body: JSON.stringify([{ title: "Europe (UK)", code: "uk-fast" }]),
    },
  ]);
  try {
    const raw = await client(server.baseUrl).read({
      kind: "regions",
      companyId: "42",
    });
    assert.deepEqual(raw, [{ title: "Europe (UK)", code: "uk-fast" }]);
  } finally {
    await server.finish();
  }
});

// TestHostingerReadsDNSRecords
test("hostinger reads dns records", async () => {
  const server = await startServer([
    {
      expected: "GET /api/dns/v1/zones/example.com",
      body: JSON.stringify([
        {
          name: "@",
          type: "A",
          ttl: 14400,
          records: [{ content: "203.0.113.10" }],
        },
      ]),
    },
  ]);
  try {
    const raw = await client(server.baseUrl).read({
      kind: "dns-records",
      domainId: "example.com",
    });
    assert.equal(raw.length, 1);
    assert.equal(raw[0].type, "A");
  } finally {
    await server.finish();
  }
});

// TestHostingerCreateSite
test("hostinger creates a site", async () => {
  const server = await startServer([
    {
      expected: "POST /api/hosting/v1/websites",
      body: JSON.stringify({ message: "success" }),
    },
  ]);
  try {
    const result = await client(server.baseUrl).action({
      kind: "create-site",
      mode: "wordpress",
      body: { domain: "example.com", order_id: 42 },
    });
    assert.equal(result.provider, "hostinger");
    assert.equal(result.action, "sites.create");
    assert.equal(result.status, 200);
    assert.deepEqual(result.raw, { message: "success" });
    assert.equal(result.operationId, undefined);
    assert.equal(
      server.seen[0].body,
      JSON.stringify({ domain: "example.com", order_id: 42 }),
    );
    assert.equal(server.seen[0].contentType, "application/json");
  } finally {
    await server.finish();
  }
});

/* -------------------------------------------------------------------------- */
/* Behaviour the Go implementation specifies but its test file does not cover  */
/* -------------------------------------------------------------------------- */

test("hostinger reports its capability table", async () => {
  const server = await startServer([]);
  try {
    const capabilities = await client(server.baseUrl).read({
      kind: "capabilities",
    });
    assert.ok(Array.isArray(capabilities));
    assert.equal(capabilities.length, 33);
    const byName = new Map(capabilities.map((entry) => [entry.name, entry]));

    assert.deepEqual(byName.get("providers.validate"), {
      name: "providers.validate",
      supported: true,
    });
    assert.deepEqual(byName.get("sites.list"), {
      name: "sites.list",
      supported: true,
      notes: "uses GET /api/hosting/v1/websites",
    });
    assert.deepEqual(byName.get("ops.get"), {
      name: "ops.get",
      supported: false,
      notes: "not mapped for Hostinger in Novamira",
    });
    assert.deepEqual(byName.get("sites.clone"), {
      name: "sites.clone",
      supported: false,
      notes: "not supported by Hostinger's provider-neutral Novamira mapping",
    });
    assert.equal(byName.get("dns.records.list").supported, true);
    assert.equal(byName.get("wp-cli.run").supported, false);
    assert.equal(
      byName.get("wp.plugins.install").notes,
      "Hostinger exposes WP-CLI through SSH/hPanel, not the public API mapped by Novamira",
    );
  } finally {
    await server.finish();
  }
});

test("hostinger list sites scopes by username and follows pagination", async () => {
  const server = await startServer([
    {
      expected: "GET /api/hosting/v1/websites?page=1&per_page=50&username=u123",
      body: JSON.stringify({
        data: [WEBSITE],
        meta: { current_page: 1, per_page: 50, total: 51 },
      }),
    },
    {
      expected: "GET /api/hosting/v1/websites?page=2&per_page=50&username=u123",
      body: JSON.stringify({
        data: [{ ...WEBSITE, domain: "second.example", is_enabled: false }],
        meta: { current_page: 2, per_page: 50, total: 51 },
      }),
    },
  ]);
  try {
    const sites = await client(server.baseUrl, {
      companyId: "u123",
    }).listSites();
    assert.equal(sites.length, 2);
    assert.equal(sites[0].id, "example.com");
    assert.equal(sites[1].id, "second.example");
    assert.equal(sites[1].status, "disabled");
    // includeEnvironments defaults to false, so no synthetic environment.
    assert.equal(sites[0].environments, undefined);
  } finally {
    await server.finish();
  }
});

test("hostinger list sites prefers the requested company id", async () => {
  const server = await startServer([
    {
      expected:
        "GET /api/hosting/v1/websites?page=1&per_page=50&username=requested",
      body: JSON.stringify({
        data: [],
        meta: { current_page: 1, per_page: 50, total: 0 },
      }),
    },
  ]);
  try {
    const sites = await client(server.baseUrl, {
      companyId: "configured",
    }).listSites({ companyId: "requested" });
    assert.deepEqual(sites, []);
  } finally {
    await server.finish();
  }
});

test("hostinger gets a site by domain", async () => {
  const server = await startServer([
    {
      expected:
        "GET /api/hosting/v1/websites?page=1&per_page=50&domain=example.com",
      body: JSON.stringify({
        data: [{ ...WEBSITE, domain: "other.example" }, WEBSITE],
        meta: { current_page: 1, per_page: 50, total: 2 },
      }),
    },
  ]);
  try {
    const site = await client(server.baseUrl).getSite("example.com");
    assert.equal(site.id, "example.com");
    // getSite always includes the synthetic environment.
    assert.equal(site.environments.length, 1);
    assert.equal(site.environments[0].id, "u123:example.com");
  } finally {
    await server.finish();
  }
});

test("hostinger gets a site from a single unmatched result", async () => {
  const server = await startServer([
    {
      expected: "GET /api/hosting/v1/websites?page=1&per_page=50&domain=alias",
      body: JSON.stringify({
        data: [WEBSITE],
        meta: { current_page: 1, per_page: 50, total: 1 },
      }),
    },
  ]);
  try {
    const site = await client(server.baseUrl).getSite("alias");
    assert.equal(site.id, "example.com");
  } finally {
    await server.finish();
  }
});

test("hostinger reports a missing site as not_found", async () => {
  const server = await startServer([
    {
      expected:
        "GET /api/hosting/v1/websites?page=1&per_page=50&domain=missing.example",
      body: JSON.stringify({
        data: [],
        meta: { current_page: 1, per_page: 50, total: 0 },
      }),
    },
  ]);
  try {
    await assert.rejects(
      client(server.baseUrl).getSite("missing.example"),
      (error) => {
        assert.equal(error.code, "not_found");
        assert.match(error.message, /missing\.example/);
        return true;
      },
    );
  } finally {
    await server.finish();
  }
});

test("hostinger lists WordPress installations as environments", async () => {
  const server = await startServer([
    {
      expected:
        "GET /api/hosting/v1/websites?page=1&per_page=50&domain=example.com",
      body: JSON.stringify({
        data: [WEBSITE],
        meta: { current_page: 1, per_page: 50, total: 1 },
      }),
    },
    {
      expected:
        "GET /api/hosting/v1/wordpress/installations?domain=example.com&ownership=all&username=u123",
      body: JSON.stringify([
        {
          id: "install-1",
          username: "u123",
          domain: "example.com",
          site_title: "Example",
          url: "https://example.com",
          directory: "/public_html",
          is_valid: true,
        },
        {
          id: "",
          username: "u123",
          domain: "blog.example.com",
          site_title: "",
          url: "",
          is_valid: false,
        },
      ]),
    },
  ]);
  try {
    const environments = await client(server.baseUrl).listEnvironments(
      "example.com",
    );
    assert.equal(environments.length, 2);
    assert.deepEqual(environments[0], {
      id: "install-1",
      name: "Example",
      displayName: "Example",
      isBlocked: false,
      isPremium: false,
      primaryDomain: "https://example.com",
    });
    assert.deepEqual(environments[1], {
      id: "u123:blog.example.com",
      name: "blog.example.com",
      displayName: "blog.example.com",
      isBlocked: true,
      isPremium: false,
      primaryDomain: "blog.example.com",
    });
  } finally {
    await server.finish();
  }
});

test("hostinger falls back to the synthetic environment", async () => {
  const server = await startServer([
    {
      expected:
        "GET /api/hosting/v1/websites?page=1&per_page=50&domain=example.com",
      body: JSON.stringify({
        data: [{ ...WEBSITE, username: "" }],
        meta: { current_page: 1, per_page: 50, total: 1 },
      }),
    },
    {
      // No username on the website, so no username query parameter.
      expected:
        "GET /api/hosting/v1/wordpress/installations?domain=example.com&ownership=all",
      body: "[]",
    },
  ]);
  try {
    const environments = await client(server.baseUrl).listEnvironments(
      "example.com",
    );
    assert.equal(environments.length, 1);
    assert.equal(environments[0].id, "example.com");
    assert.equal(environments[0].name, "live");
  } finally {
    await server.finish();
  }
});

test("hostinger reports missing environments as not_found", async () => {
  const server = await startServer([
    {
      expected: "GET /api/hosting/v1/websites?page=1&per_page=50&domain=nope",
      body: JSON.stringify({
        data: [],
        meta: { current_page: 1, per_page: 50, total: 0 },
      }),
    },
  ]);
  try {
    await assert.rejects(
      client(server.baseUrl).listEnvironments("nope"),
      (error) => error.code === "not_found",
    );
  } finally {
    await server.finish();
  }
});

test("hostinger reads the dns portfolio", async () => {
  const server = await startServer([
    {
      expected: "GET /api/domains/v1/portfolio",
      body: JSON.stringify([{ domain: "example.com" }]),
    },
  ]);
  try {
    const raw = await client(server.baseUrl).read({ kind: "dns-domains" });
    assert.deepEqual(raw, [{ domain: "example.com" }]);
  } finally {
    await server.finish();
  }
});

test("hostinger reads parked domains from an env ref", async () => {
  const server = await startServer([
    {
      expected:
        "GET /api/hosting/v1/accounts/u123/websites/example.com/parked-domains",
      body: JSON.stringify([{ domain: "alias.com" }]),
    },
    {
      // Bare `--env domain` with the profile company id supplying the username.
      expected:
        "GET /api/hosting/v1/accounts/configured/websites/example.com/parked-domains",
      body: "[]",
    },
  ]);
  try {
    const raw = await client(server.baseUrl).read({
      kind: "site-domains",
      envId: "u123:example.com",
    });
    assert.deepEqual(raw, [{ domain: "alias.com" }]);

    const scoped = await client(server.baseUrl, {
      companyId: "configured",
    }).read({ kind: "site-domains", envId: "example.com" });
    assert.deepEqual(scoped, []);
  } finally {
    await server.finish();
  }
});

test("hostinger requires a username for env-scoped requests", async () => {
  const server = await startServer([]);
  try {
    await assert.rejects(
      client(server.baseUrl).read({
        kind: "site-domains",
        envId: "example.com",
      }),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.match(error.message, /username/);
        return true;
      },
    );
  } finally {
    await server.finish();
  }
});

test("hostinger creates a WordPress installation as an environment", async () => {
  const server = await startServer([
    {
      expected: "POST /api/hosting/v1/accounts/u123/wordpress/installations",
      body: JSON.stringify({ id: "install-9" }),
    },
  ]);
  try {
    const result = await client(server.baseUrl).action({
      kind: "create-environment",
      siteId: "example.com",
      mode: "wordpress",
      body: {
        username: "u123",
        domain: "example.com",
        directory: "public_html",
      },
    });
    assert.equal(result.action, "envs.create");
    // sendAction lifts a string `id` from the response into operation_id.
    assert.equal(result.operationId, "install-9");
    assert.deepEqual(JSON.parse(server.seen[0].body), {
      username: "u123",
      domain: "example.com",
      directory: "public_html",
    });
  } finally {
    await server.finish();
  }
});

test("hostinger adds a parked domain", async () => {
  const server = await startServer([
    {
      expected:
        "POST /api/hosting/v1/accounts/u123/websites/example.com/parked-domains",
      body: JSON.stringify({ message: "queued" }),
    },
  ]);
  try {
    const result = await client(server.baseUrl).action({
      kind: "add-domain",
      envId: "u123:example.com",
      body: { domain_name: "alias.com" },
    });
    assert.equal(result.action, "domains.add");
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(server.seen[0].body), {
      domain_name: "alias.com",
    });
  } finally {
    await server.finish();
  }
});

test("hostinger escapes path segments the way Go's url.PathEscape does", async () => {
  const server = await startServer([
    {
      expected: "GET /api/dns/v1/zones/a%2Fb.example",
      body: "[]",
    },
  ]);
  try {
    const raw = await client(server.baseUrl).read({
      kind: "dns-records",
      domainId: "a/b.example",
    });
    assert.deepEqual(raw, []);
  } finally {
    await server.finish();
  }
});

test("hostinger refuses to clone a site", async () => {
  const server = await startServer([]);
  try {
    await assert.rejects(
      client(server.baseUrl).action({ kind: "create-site", mode: "clone" }),
      (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.match(error.message, /sites\.clone/);
        return true;
      },
    );
  } finally {
    await server.finish();
  }
});

test("hostinger has no operation status endpoint", async () => {
  const server = await startServer([]);
  try {
    await assert.rejects(
      client(server.baseUrl).operationStatus("op-1"),
      (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.match(error.message, /operation status/);
        return true;
      },
    );
  } finally {
    await server.finish();
  }
});

test("hostinger reports every unmapped read as provider_unsupported", async () => {
  const server = await startServer([]);
  const hostinger = client(server.baseUrl);
  const unmapped = [
    { kind: "activity" },
    { kind: "site-domain-verification", siteDomainId: "d" },
    { kind: "backups", envId: "e" },
    { kind: "downloadable-backups", envId: "e" },
    { kind: "logs", envId: "e", fileName: "error.log", lines: 100 },
    { kind: "redirects", envId: "e" },
    { kind: "denied-ips", envId: "e" },
    { kind: "plugins", envId: "e" },
    { kind: "themes", envId: "e" },
    { kind: "company-plugins" },
    { kind: "company-themes" },
    { kind: "analytics-usage", siteId: "s", metric: "visits" },
    { kind: "analytics-env", envId: "e", metric: "visits" },
    { kind: "file-list", envId: "e" },
  ];
  try {
    for (const request of unmapped) {
      await assert.rejects(hostinger.read(request), (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.deepEqual(error.details, {
          provider: "hostinger",
          request: request.kind,
        });
        return true;
      });
    }
  } finally {
    await server.finish();
  }
});

test("hostinger reports every unmapped action as provider_unsupported", async () => {
  const server = await startServer([]);
  const hostinger = client(server.baseUrl);
  const unmapped = [
    { kind: "push-environment", siteId: "s" },
    { kind: "clear-cache", cache: "site" },
    { kind: "restart-php", envId: "e" },
    { kind: "set-php-version" },
    { kind: "change-primary-domain", envId: "e" },
    { kind: "create-backup", envId: "e" },
    { kind: "update-plugin", envId: "e" },
    { kind: "bulk-update-plugins", envId: "e" },
    { kind: "update-theme", envId: "e" },
    { kind: "bulk-update-themes", envId: "e" },
    { kind: "run-wp-cli", envId: "e" },
    { kind: "set-denied-ips" },
    { kind: "apply-redirects", envId: "e" },
  ];
  try {
    for (const request of unmapped) {
      await assert.rejects(hostinger.action(request), (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.deepEqual(error.details, {
          provider: "hostinger",
          action: request.kind,
        });
        return true;
      });
    }
  } finally {
    await server.finish();
  }
});

test("hostinger maps provider HTTP failures onto the error taxonomy", async () => {
  const server = await startServer([
    {
      expected: "GET /api/hosting/v1/websites?page=1&per_page=1",
      status: 401,
      body: JSON.stringify({ message: "Unauthenticated." }),
    },
    {
      expected: "GET /api/domains/v1/portfolio",
      status: 404,
      body: JSON.stringify({ message: "Not found" }),
    },
  ]);
  try {
    const hostinger = client(server.baseUrl);
    await assert.rejects(hostinger.validate(), (error) => {
      assert.equal(error.code, "credential_invalid");
      assert.match(error.message, /Unauthenticated/);
      return true;
    });
    await assert.rejects(
      hostinger.read({ kind: "dns-domains" }),
      (error) => error.code === "not_found",
    );
  } finally {
    await server.finish();
  }
});

test("hostinger never leaks the credential", async () => {
  const diagnostics = [];
  const server = await startServer([
    {
      expected: "GET /api/hosting/v1/websites?page=1&per_page=1",
      status: 500,
      // A hostile provider echoing the token back must still be scrubbed.
      body: JSON.stringify({ message: `token ${TOKEN} rejected` }),
    },
  ]);
  try {
    const hostinger = createHostingerClient(
      context(server.baseUrl, {
        createHttpClient(options = {}) {
          return createHttpClient({
            baseUrl: server.baseUrl,
            providerLabel: "Hostinger",
            retry: { maxAttempts: 1 },
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
            ...options,
          });
        },
      }),
    );
    await assert.rejects(hostinger.validate(), (error) => {
      assert.ok(!error.message.includes(TOKEN), error.message);
      assert.ok(!JSON.stringify(error.details ?? {}).includes(TOKEN));
      return true;
    });
    assert.ok(diagnostics.length > 0);
    assert.ok(!JSON.stringify(diagnostics).includes(TOKEN));
    // The request did carry the bearer token.
    assert.equal(server.seen[0].authorization, `Bearer ${TOKEN}`);
  } finally {
    await server.finish();
  }
});

test("hostinger action results serialize to the Go wire shape", async () => {
  const server = await startServer([
    {
      expected: "POST /api/hosting/v1/websites",
      status: 201,
      body: JSON.stringify({ id: "job-7", message: "queued" }),
    },
  ]);
  try {
    const result = await client(server.baseUrl).action({
      kind: "create-site",
      mode: "plain",
      body: { domain: "example.com" },
    });
    assert.deepEqual(serializeActionResult(result), {
      provider: "hostinger",
      action: "sites.create",
      status: 201,
      operation_id: "job-7",
      raw: { id: "job-7", message: "queued" },
    });
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  } finally {
    await server.finish();
  }
});

test("hostinger treats an empty response body as null", async () => {
  const server = await startServer([
    { expected: "GET /api/domains/v1/portfolio", status: 204, body: "" },
  ]);
  try {
    const raw = await client(server.baseUrl).read({ kind: "dns-domains" });
    assert.equal(raw, null);
  } finally {
    await server.finish();
  }
});

test("hostinger rejects an empty credential", async () => {
  const server = await startServer([]);
  try {
    assert.throws(
      () =>
        createHostingerClient(
          context(server.baseUrl, {
            secret: new SecretValue("", "env", CREDENTIAL_SOURCE),
          }),
        ),
      (error) => {
        assert.equal(error.code, "credential_missing");
        return true;
      },
    );
  } finally {
    await server.finish();
  }
});

test("hostinger wp-cli results stay observable by default", async () => {
  const server = await startServer([]);
  try {
    const hostinger = client(server.baseUrl);
    // Go's HostingerClient does not implement WPCLIResultObserver.
    assert.equal(hostinger.wpCliResultsObservable, undefined);
    assert.equal(hostinger.provider, "hostinger");
  } finally {
    await server.finish();
  }
});
