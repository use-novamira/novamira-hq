// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Rocket.net provider contract test, ported from
 * `internal/providers/rocketnet_test.go`.
 *
 * The Go suite drives the client against an `httptest` server that asserts on
 * the request line (`METHOD /path?query`), the bearer token, and a request-body
 * substring. This suite keeps the same shape with a local `node:http` server on
 * 127.0.0.1:0, and adds the cases the Go suite left implicit: the deliberate
 * `provider_unsupported` gaps, the domain fan-out, the token exchange, and the
 * "no secret ever escapes" guarantee.
 *
 * Nothing here touches the network beyond loopback and no credential is real.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { wpCliResultsObservable } from "../dist/hosting/client.js";
import { createHttpClient } from "../dist/hosting/http-client.js";
import { createRocketNetClient } from "../dist/hosting/providers/rocketnet.js";

/** Obvious fakes. Neither may ever appear in an error, detail, or result. */
const PASSWORD = "not-a-real-password";
const TOKEN = "not-a-real-token";
const USERNAME = "user@example.com";

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * A mock Rocket.net API. `/v1/login` always answers the token exchange; every
 * other request is matched against the next queued route, exactly like the Go
 * helper's `idx` cursor.
 */
async function startRocketNet(routes, login = {}) {
  const failures = [];
  const seen = [];
  let index = 0;
  let logins = 0;

  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      if (request.url === "/v1/login") {
        logins += 1;
        for (const want of [
          `"username":"${USERNAME}"`,
          `"password":"${PASSWORD}"`,
        ]) {
          if (!body.includes(want))
            failures.push(`login body ${body} is missing ${want}`);
        }
        if (request.method !== "POST")
          failures.push(`login method = ${request.method}, want POST`);
        response.writeHead(login.status ?? 200, {
          "content-type": "application/json",
        });
        response.end(login.body ?? JSON.stringify({ token: TOKEN }));
        return;
      }

      const line = `${request.method} ${request.url}`;
      seen.push(line);
      const route = routes[index];
      index += 1;
      if (route === undefined) {
        failures.push(`unexpected request: ${line}`);
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"message":"unexpected"}');
        return;
      }
      if (line !== route.expected)
        failures.push(`request line = ${line}, want ${route.expected}`);
      if (request.headers.authorization !== `Bearer ${TOKEN}`)
        failures.push(
          `authorization = ${String(request.headers.authorization)}, want Bearer ${TOKEN}`,
        );
      if (route.bodyLike !== undefined && !body.includes(route.bodyLike))
        failures.push(
          `request body = ${body}, want substring ${route.bodyLike}`,
        );
      if (route.noBody === true && body !== "")
        failures.push(`request body = ${body}, want empty`);
      response.writeHead(route.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(route.body ?? "");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    failures,
    seen,
    get logins() {
      return logins;
    },
    get consumed() {
      return index;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A `ProviderClientContext` shaped exactly like `factory.ts` builds one, with a
 * `SecretValue` stand-in and the retry policy pinned to a single attempt so the
 * route queue stays in lockstep with the requests.
 */
function rocketNetContext(baseUrl, overrides = {}) {
  const secret = {
    source: "env",
    description: "env:ROCKETNET_PASSWORD",
    length: PASSWORD.length,
    reveal: () => PASSWORD,
    toString: () => "[redacted]",
    toJSON: () => "[redacted]",
  };
  return {
    provider: "rocketnet",
    providerLabel: "Rocket.net",
    profileName: "rocketnet-test",
    profile: {
      provider: "rocketnet",
      credential: { type: "env", name: "ROCKETNET_PASSWORD" },
    },
    baseUrl,
    secret,
    credentialSource: "env:ROCKETNET_PASSWORD",
    companyId: USERNAME,
    identity: USERNAME,
    tokenUrl: undefined,
    env: {},
    createHttpClient: (httpOverrides) =>
      createHttpClient({
        baseUrl,
        providerLabel: "Rocket.net",
        retry: { maxAttempts: 1 },
        ...httpOverrides,
      }),
    ...overrides,
  };
}

/** Runs `body` against a fresh mock server and always closes it. */
async function withRocketNet(routes, body) {
  const server = await startRocketNet(routes);
  try {
    const client = await createRocketNetClient(
      rocketNetContext(server.baseUrl),
    );
    await body(client, server);
  } finally {
    await server.close();
  }
  assert.deepEqual(server.failures, []);
  assert.equal(
    server.consumed,
    routes.length,
    `consumed ${String(server.consumed)} of ${String(routes.length)} routes: ${server.seen.join(", ")}`,
  );
}

const OK = '{"success":true,"messages":[],"errors":[],"result":[]}';

/* -------------------------------------------------------------------------- */
/* Ported Go cases                                                            */
/* -------------------------------------------------------------------------- */

test("rocketnet validates credentials", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/account/me",
        body: '{"success":true,"messages":[],"errors":[],"result":{"client":{"email":"user@example.com"}}}',
      },
    ],
    async (client, server) => {
      const validation = await client.validate();
      assert.equal(validation.provider, "rocketnet");
      assert.equal(validation.status, "active");
      assert.equal(validation.companyId, USERNAME);
      assert.equal(validation.credential, "env:ROCKETNET_PASSWORD");
      assert.equal(server.logins, 1);
      assert.equal(client.provider, "rocketnet");
    },
  );
});

test("rocketnet reports a failed validation", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/account/me",
        body: '{"success":false,"messages":["account suspended"],"errors":[]}',
      },
    ],
    async (client) => {
      await assert.rejects(client.validate(), (error) => {
        assert.equal(error.code, "provider_error");
        assert.match(error.message, /account suspended/);
        return true;
      });
    },
  );
});

test("rocketnet falls back to the username when the account has no email", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/account/me",
        body: '{"success":true,"messages":[],"errors":[],"result":{"client":{}}}',
      },
    ],
    async (client) => {
      const validation = await client.validate();
      assert.equal(validation.companyId, USERNAME);
    },
  );
});

test("rocketnet lists sites", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/sites?page=1&per_page=100",
        body: '{"success":true,"messages":[],"errors":[],"metadata":{"page":1,"page_size":100,"total":1},"result":[{"id":8880000888,"domain":"example.com","display_domain":"example.com","label":"Example","status":"active","metadata":{"wordpress_version":"6.8.1"}}]}',
      },
    ],
    async (client) => {
      const sites = await client.listSites({ includeEnvironments: true });
      assert.equal(sites.length, 1);
      const [site] = sites;
      assert.equal(site.id, "8880000888");
      assert.equal(site.name, "example.com");
      assert.equal(site.displayName, "Example");
      assert.equal(site.status, "active");
      assert.equal(site.primaryDomain, "example.com");
      assert.equal(site.environments?.length, 1);
      const [environment] = site.environments;
      assert.equal(environment.id, "8880000888");
      assert.equal(environment.name, "live");
      assert.equal(environment.displayName, "Example");
      assert.equal(environment.isBlocked, false);
      assert.equal(environment.isPremium, false);
      assert.equal(environment.wordpressVersion, "6.8.1");
      assert.equal(environment.primaryDomain, "example.com");
    },
  );
});

test("rocketnet omits environments when they were not requested", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/sites?page=1&per_page=100",
        body: '{"success":true,"messages":[],"errors":[],"result":[{"id":"1","domain":"a.example","status":"locked","production":1,"site_type":1}]}',
      },
    ],
    async (client) => {
      const sites = await client.listSites();
      assert.equal(sites.length, 1);
      assert.equal(sites[0].environments, undefined);
      assert.equal(sites[0].status, "suspended");
    },
  );
});

test("rocketnet follows site pagination", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/sites?page=1&per_page=100",
        body: '{"success":true,"metadata":{"page":1,"page_size":2,"total":3},"result":[{"id":1,"domain":"a.example"},{"id":2,"domain":"b.example"}]}',
      },
      {
        expected: "GET /v1/sites?page=2&per_page=100",
        body: '{"success":true,"metadata":{"page":2,"page_size":2,"total":3},"result":[{"id":3,"domain":"c.example"}]}',
      },
    ],
    async (client) => {
      const sites = await client.listSites();
      assert.deepEqual(
        sites.map((site) => site.id),
        ["1", "2", "3"],
      );
    },
  );
});

test("rocketnet reports a failed site listing", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/sites?page=1&per_page=100",
        body: '{"success":false,"messages":[],"errors":[]}',
      },
    ],
    async (client) => {
      await assert.rejects(client.listSites(), (error) => {
        assert.equal(error.code, "provider_error");
        assert.match(error.message, /\(no message\)/);
        return true;
      });
    },
  );
});

test("rocketnet get site synthesizes one environment", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/sites/8880000888",
        body: '{"success":true,"messages":[],"errors":[],"result":{"id":8880000888,"domain":"example.com","display_domain":"example.com","status":"active"}}',
      },
    ],
    async (client) => {
      const site = await client.getSite("8880000888");
      assert.equal(site.environments?.length, 1);
      assert.equal(site.environments[0].id, "8880000888");
    },
  );
});

test("rocketnet list environments returns the synthetic environment", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/sites/123",
        body: '{"success":true,"result":{"id":"123","domain":"example.com","production":"1","status":"active"}}',
      },
    ],
    async (client) => {
      const environments = await client.listEnvironments("123");
      assert.equal(environments.length, 1);
      assert.equal(environments[0].name, "staging");
    },
  );
});

test("rocketnet create site redacts secrets", async () => {
  await withRocketNet(
    [
      {
        expected: "POST /v1/sites",
        bodyLike: '"name":"Demo"',
        body: '{"success":true,"messages":[],"errors":[],"result":{"id":123,"domain":"demo.rocket.net","password":"wp-secret"}}',
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "create-site",
        mode: "wordpress",
        body: { name: "Demo" },
      });
      assert.equal(result.provider, "rocketnet");
      assert.equal(result.action, "sites.create");
      assert.equal(result.status, 200);
      assert.equal(result.operationId, undefined);
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes("wp-secret"), serialized);
      assert.equal(result.raw.result.password, "redacted");
      assert.equal(result.raw.result.domain, "demo.rocket.net");
    },
  );
});

test("rocketnet create plain site keeps its own action name", async () => {
  await withRocketNet(
    [
      {
        expected: "POST /v1/sites",
        bodyLike: '"static_site":true',
        body: '{"success":true,"result":{"id":9}}',
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "create-site",
        mode: "plain",
        body: { static_site: true },
      });
      assert.equal(result.action, "sites.create-plain");
    },
  );
});

test("rocketnet clone site uses the source site id", async () => {
  await withRocketNet(
    [
      {
        expected: "POST /v1/sites/123/clone",
        bodyLike: '"label":"copy"',
        body: '{"success":true,"messages":[],"errors":[],"result":{"task_id":"task-1","task_level":"site"}}',
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "create-site",
        mode: "clone",
        body: { source_site_id: "123", label: "copy" },
      });
      assert.equal(result.action, "sites.clone");
      assert.equal(result.operationId, "task-1");
    },
  );
});

test("rocketnet clone site requires a source site id", async () => {
  await withRocketNet([], async (client) => {
    await assert.rejects(
      client.action({
        kind: "create-site",
        mode: "clone",
        body: { label: "x" },
      }),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.match(error.message, /source_site_id/);
        return true;
      },
    );
  });
});

test("rocketnet clears the site cache", async () => {
  await withRocketNet(
    [
      {
        expected: "POST /v1/sites/123/cache/purge_everything",
        noBody: true,
        body: '{"success":true,"messages":[],"errors":[],"result":{"status":"success"}}',
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "clear-cache",
        cache: "site",
        body: { site_id: "123" },
      });
      assert.equal(result.action, "cache.clear");
      assert.equal(result.message, "success");
    },
  );
});

test("rocketnet clears the edge cache with the caller's body", async () => {
  await withRocketNet(
    [
      {
        expected: "POST /v1/sites/123/cache/purge",
        bodyLike: '"files"',
        body: '{"success":true,"result":{"status":"success"}}',
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "clear-cache",
        cache: "edge",
        body: { site_id: "123", files: ["https://a.example/x.css"] },
      });
      assert.equal(result.action, "cache.clear");
    },
  );
});

test("rocketnet cache clear requires a site id", async () => {
  await withRocketNet([], async (client) => {
    await assert.rejects(
      client.action({ kind: "clear-cache", cache: "site", body: {} }),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.match(error.message, /site_id/);
        return true;
      },
    );
  });
});

test("rocketnet run wp-cli normalizes the command", async () => {
  await withRocketNet(
    [
      {
        expected: "POST /v1/sites/123/wpcli",
        bodyLike: '"command":"plugin list"',
        body: '{"success":true,"messages":[],"errors":[],"result":{"response":"ok"}}',
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "run-wp-cli",
        envId: "123",
        body: { wp_command: "wp plugin list" },
      });
      assert.equal(result.action, "wp-cli.run");
      assert.equal(wpCliResultsObservable(client), true);
    },
  );
});

test("rocketnet run wp-cli passes a native command body through", async () => {
  await withRocketNet(
    [
      {
        expected: "POST /v1/sites/123/wpcli",
        bodyLike: '"command":"core version"',
        body: '{"success":true,"result":{"response":"6.8.1"}}',
      },
    ],
    async (client) => {
      await client.action({
        kind: "run-wp-cli",
        envId: "123",
        body: { command: "core version" },
      });
    },
  );
});

test("rocketnet run wp-cli requires a command", async () => {
  await withRocketNet([], async (client) => {
    await assert.rejects(
      client.action({ kind: "run-wp-cli", envId: "123", body: { foo: 1 } }),
      (error) => {
        assert.equal(error.code, "usage_error");
        return true;
      },
    );
  });
});

test("rocketnet polls a site operation status", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/sites/123/tasks?task_id=task-1",
        body: '{"success":true,"messages":[],"errors":[],"result":[{"id":"task-1","task_status":"DONE","message":"done"}]}',
      },
    ],
    async (client) => {
      const status = await client.operationStatus("123:task-1");
      assert.equal(status.provider, "rocketnet");
      assert.equal(status.operationId, "123:task-1");
      assert.equal(status.status, 200);
      assert.equal(status.done, true);
      assert.equal(status.failed, false);
      assert.equal(status.message, "done");
    },
  );
});

test("rocketnet reads regions", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/sites/all_locations",
        body: '{"success":true,"messages":[],"errors":[],"result":{"locations":[{"id":1,"location":"US - Ashburn","region":"United States"}]}}',
      },
    ],
    async (client) => {
      const raw = await client.read({ kind: "regions" });
      assert.ok(JSON.stringify(raw).includes("US - Ashburn"));
    },
  );
});

test("rocketnet read activity maps the generic query", async () => {
  await withRocketNet(
    [
      {
        expected:
          "GET /v1/sites/123/activity/events?event_type=deploy&author=user-1&page=3&per_page=10",
        body: OK,
      },
    ],
    async (client) => {
      await client.read({
        kind: "activity",
        query: [
          ["limit", "10"],
          ["offset", "20"],
          ["site_id", "123"],
          ["category", "deploy"],
          ["id_initiated_by", "user-1"],
        ],
      });
    },
  );
});

test("rocketnet read logs maps duration and lines", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/sites/123/access_logs?duration=1h&per_page=20",
        body: OK,
      },
    ],
    async (client) => {
      await client.read({
        kind: "logs",
        envId: "123",
        fileName: "access",
        lines: 20,
      });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Behaviour the Go suite exercises only through the implementation           */
/* -------------------------------------------------------------------------- */

test("rocketnet read activity without a site id uses account tasks", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/account/tasks?task_type=backup&page=1&per_page=10",
        body: OK,
      },
    ],
    async (client) => {
      await client.read({
        kind: "activity",
        query: [
          ["category", "backup"],
          ["id_initiated_by", "user-1"],
          ["language", "en"],
          ["id_api_key", "abc"],
          ["empty", ""],
        ],
      });
    },
  );
});

test("rocketnet read logs rejects a non-access file", async () => {
  await withRocketNet([], async (client) => {
    await assert.rejects(
      client.read({
        kind: "logs",
        envId: "123",
        fileName: "error",
        lines: 10,
      }),
      (error) => {
        assert.equal(error.code, "provider_unsupported");
        return true;
      },
    );
  });
});

test("rocketnet read logs omits per_page without a line count", async () => {
  await withRocketNet(
    [{ expected: "GET /v1/sites/123/access_logs?duration=1h", body: OK }],
    async (client) => {
      await client.read({
        kind: "logs",
        envId: "123",
        fileName: "",
        lines: 0,
      });
    },
  );
});

test("rocketnet maps the simple site reads", async () => {
  await withRocketNet(
    [
      { expected: "GET /v1/sites/123/domains", body: OK },
      { expected: "GET /v1/sites/123/backup", body: OK },
      { expected: "GET /v1/sites/123/plugins", body: OK },
      { expected: "GET /v1/sites/123/themes", body: OK },
      { expected: "GET /v1/sites/123/ftp/accounts", body: OK },
      { expected: "GET /v1/sites/123/file_manager/files", body: OK },
    ],
    async (client) => {
      await client.read({ kind: "site-domains", envId: "123" });
      await client.read({ kind: "backups", envId: "123" });
      await client.read({ kind: "plugins", envId: "123" });
      await client.read({ kind: "themes", envId: "123" });
      await client.read({ kind: "sftp-accounts", envId: "123" });
      await client.read({ kind: "file-list", envId: "123" });
    },
  );
});

test("rocketnet maps every ssh read onto the site key listing", async () => {
  await withRocketNet(
    [
      { expected: "GET /v1/sites/123/ssh/keys", body: OK },
      { expected: "GET /v1/sites/456/ssh/keys", body: OK },
      { expected: "GET /v1/sites/789/ssh/keys", body: OK },
      { expected: "GET /v1/sites/111/ssh/keys", body: OK },
    ],
    async (client) => {
      await client.read({ kind: "ssh-status", envId: "123" });
      await client.read({ kind: "ssh-allowlist", envId: "456" });
      await client.read({ kind: "ssh-config", siteId: "x", envId: "789" });
      await client.read({ kind: "ssh-config", siteId: "111", envId: "" });
    },
  );
});

test("rocketnet ssh reads require an id", async () => {
  await withRocketNet([], async (client) => {
    await assert.rejects(
      client.read({ kind: "ssh-config", siteId: "", envId: "" }),
      (error) => {
        assert.equal(error.code, "usage_error");
        return true;
      },
    );
  });
});

test("rocketnet maps the analytics endpoints", async () => {
  await withRocketNet(
    [
      { expected: "GET /v1/account/usage", body: OK },
      { expected: "GET /v1/sites/123/usage", body: OK },
      { expected: "GET /v1/sites/123/usage", body: OK },
      { expected: "GET /v1/sites/123/reporting/bandwidth?from=a", body: OK },
      { expected: "GET /v1/sites/123/reporting/bandwidth/usage", body: OK },
      { expected: "GET /v1/sites/123/reporting/total_requests", body: OK },
      { expected: "GET /v1/sites/123/reporting/total_requests", body: OK },
      { expected: "GET /v1/reporting/sites/123/cdn/requests", body: OK },
    ],
    async (client) => {
      await client.read({ kind: "analytics-usage", siteId: "", metric: "" });
      await client.read({ kind: "analytics-usage", siteId: "123", metric: "" });
      await client.read({ kind: "analytics-env", envId: "123", metric: "" });
      await client.read({
        kind: "analytics-env",
        envId: "123",
        metric: "bandwidth",
        query: [
          ["from", "a"],
          ["to", ""],
        ],
      });
      await client.read({
        kind: "analytics-env",
        envId: "123",
        metric: "bandwidth-usage",
      });
      await client.read({
        kind: "analytics-env",
        envId: "123",
        metric: "requests",
      });
      await client.read({
        kind: "analytics-env",
        envId: "123",
        metric: "total-requests",
      });
      await client.read({
        kind: "analytics-env",
        envId: "123",
        metric: "cdn-requests",
      });
    },
  );
});

test("rocketnet rejects an unknown analytics metric", async () => {
  await withRocketNet([], async (client) => {
    await assert.rejects(
      client.read({ kind: "analytics-env", envId: "1", metric: "nope" }),
      (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.match(error.message, /nope/);
        return true;
      },
    );
  });
});

test("rocketnet reports its capability list without a request", async () => {
  await withRocketNet([], async (client, server) => {
    const capabilities = await client.read({ kind: "capabilities" });
    assert.ok(Array.isArray(capabilities));
    const byName = new Map(capabilities.map((entry) => [entry.name, entry]));
    assert.deepEqual(byName.get("providers.validate"), {
      name: "providers.validate",
      supported: true,
    });
    assert.deepEqual(byName.get("sites.create"), {
      name: "sites.create",
      supported: true,
      notes: "uses POST /v1/sites",
    });
    assert.equal(byName.get("dns.domains.list").supported, false);
    assert.equal(byName.get("sites.reset").supported, false);
    assert.equal(byName.get("backups.delete").supported, false);
    assert.equal(capabilities.length, 55);
    assert.equal(server.logins, 0);
  });
});

test("rocketnet maps the site lifecycle actions", async () => {
  await withRocketNet(
    [
      { expected: "DELETE /v1/sites/123", noBody: true, body: OK },
      {
        expected: "POST /v1/sites/123/staging",
        bodyLike: '"copy":true',
        body: OK,
      },
      { expected: "POST /v1/sites/123/staging/publish", body: OK },
      { expected: "DELETE /v1/sites/123/staging", noBody: true, body: OK },
      {
        expected: "POST /v1/sites/123/domains",
        bodyLike: "a.example",
        body: OK,
      },
      {
        expected: "PUT /v1/sites/123/maindomain",
        bodyLike: "a.example",
        body: OK,
      },
      { expected: "PUT /v1/sites/123/plugins", bodyLike: "akismet", body: OK },
      { expected: "PUT /v1/sites/123/plugins", body: OK },
      { expected: "PUT /v1/sites/123/themes", bodyLike: "twenty", body: OK },
      { expected: "PUT /v1/sites/123/themes", body: OK },
      {
        expected: "POST /v1/sites/123/ftp/accounts",
        bodyLike: "deploy",
        body: OK,
      },
    ],
    async (client) => {
      const actions = [
        [{ kind: "delete-site", siteId: "123" }, "sites.delete"],
        [
          {
            kind: "create-environment",
            siteId: "123",
            mode: "clone",
            body: { copy: true },
          },
          "envs.create",
        ],
        [
          { kind: "push-environment", siteId: "123", body: { push_db: true } },
          "envs.push",
        ],
        [{ kind: "delete-environment", envId: "123" }, "envs.delete"],
        [
          { kind: "add-domain", envId: "123", body: { domain: "a.example" } },
          "domains.add",
        ],
        [
          {
            kind: "change-primary-domain",
            envId: "123",
            body: { domain: "a.example" },
          },
          "domains.primary",
        ],
        [
          { kind: "update-plugin", envId: "123", body: { plugin: "akismet" } },
          "wp.plugins.update",
        ],
        [
          { kind: "bulk-update-plugins", envId: "123" },
          "wp.plugins.update-all",
        ],
        [
          { kind: "update-theme", envId: "123", body: { theme: "twenty" } },
          "wp.themes.update",
        ],
        [{ kind: "bulk-update-themes", envId: "123" }, "wp.themes.update-all"],
        [
          {
            kind: "add-sftp-account",
            envId: "123",
            body: { username: "deploy" },
          },
          "access.sftp.add",
        ],
      ];
      for (const [request, action] of actions) {
        const result = await client.action(request);
        assert.equal(result.action, action);
        assert.equal(result.provider, "rocketnet");
      }
    },
  );
});

test("rocketnet deletes a single domain in place", async () => {
  await withRocketNet(
    [
      {
        expected: "DELETE /v1/sites/123/domains/d-1",
        noBody: true,
        body: '{"success":true,"result":{"message":"deleted"}}',
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "delete-domains",
        envId: "123",
        body: { domain_id: "d-1" },
      });
      assert.equal(result.action, "domains.delete");
      assert.equal(result.message, "deleted");
    },
  );
});

test("rocketnet fans a multi-domain delete out and aggregates the results", async () => {
  await withRocketNet(
    [
      {
        expected: "DELETE /v1/sites/123/domains/d-1",
        body: '{"success":true,"result":{"id":"d-1"}}',
      },
      {
        expected: "DELETE /v1/sites/123/domains/d-2",
        body: '{"success":true,"result":{"id":"d-2"}}',
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "delete-domains",
        envId: "123",
        body: { domain_ids: ["d-1", "d-2"] },
      });
      assert.equal(result.action, "domains.delete");
      assert.equal(result.status, 200);
      assert.equal(result.message, undefined);
      assert.equal(result.raw.success, true);
      assert.equal(result.raw.result.length, 2);
      assert.equal(result.raw.result[0].result.id, "d-1");
    },
  );
});

test("rocketnet requires a domain id for domains.delete", async () => {
  await withRocketNet([], async (client) => {
    await assert.rejects(
      client.action({ kind: "delete-domains", envId: "123", body: {} }),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.match(error.message, /domain_id/);
        return true;
      },
    );
  });
});

test("rocketnet renames a backup tag to a label", async () => {
  await withRocketNet(
    [
      {
        expected: "POST /v1/sites/123/backup",
        bodyLike: '"label":"nightly"',
        body: '{"success":true,"result":{"task_id":"t-9"}}',
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "create-backup",
        envId: "123",
        body: { tag: "nightly" },
      });
      assert.equal(result.action, "backups.create");
      assert.equal(result.operationId, "t-9");
    },
  );
});

test("rocketnet requires a backup label", async () => {
  await withRocketNet([], async (client) => {
    await assert.rejects(
      client.action({ kind: "create-backup", envId: "123", body: {} }),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.match(error.message, /label/);
        return true;
      },
    );
  });
});

test("rocketnet restores a backup onto the target environment", async () => {
  await withRocketNet(
    [
      {
        expected: "POST /v1/sites/123/backup/b-9/restore",
        bodyLike: '"files":true',
        body: '{"success":true,"result":{"task_id":"t-1"}}',
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "restore-backup",
        targetEnvId: "123",
        body: { backup_id: "b-9", files: true },
      });
      assert.equal(result.action, "backups.restore");
      assert.equal(result.operationId, "t-1");
    },
  );
});

test("rocketnet prefers an explicit site id when restoring a backup", async () => {
  await withRocketNet(
    [
      {
        expected: "POST /v1/sites/999/backup/7/restore",
        body: '{"success":true,"result":{}}',
      },
    ],
    async (client) => {
      await client.action({
        kind: "restore-backup",
        targetEnvId: "123",
        body: { site_id: "999", id: 7 },
      });
    },
  );
});

test("rocketnet requires a backup id to restore", async () => {
  await withRocketNet([], async (client) => {
    await assert.rejects(
      client.action({
        kind: "restore-backup",
        targetEnvId: "123",
        body: { note: "x" },
      }),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.match(error.message, /backup_id/);
        return true;
      },
    );
  });
});

test("rocketnet reads an account operation status and flags failure", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/account/tasks?task_id=task-2",
        body: '{"success":true,"result":[{"id":"task-2","status":"error","description":"boom"}]}',
      },
    ],
    async (client) => {
      const status = await client.operationStatus("task-2");
      assert.equal(status.done, true);
      assert.equal(status.failed, true);
      assert.equal(status.message, "boom");
    },
  );
});

test("rocketnet treats a task list without entries as unfinished", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/sites/1/tasks?task_id=task-3",
        body: '{"success":true,"result":[]}',
      },
    ],
    async (client) => {
      const status = await client.operationStatus("1/task-3");
      assert.equal(status.done, false);
      assert.equal(status.failed, false);
      assert.equal(status.message, undefined);
    },
  );
});

test("rocketnet redacts secret-looking keys from every raw payload", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/sites/123/ftp/accounts",
        body: '{"success":true,"result":[{"username":"a","password":"hunter2","meta":{"api_token":"t","private_key":"k","note":"fine"}}]}',
      },
    ],
    async (client) => {
      const raw = await client.read({ kind: "sftp-accounts", envId: "123" });
      const serialized = JSON.stringify(raw);
      assert.ok(!serialized.includes("hunter2"), serialized);
      assert.equal(raw.result[0].password, "redacted");
      assert.equal(raw.result[0].meta.api_token, "redacted");
      assert.equal(raw.result[0].meta.private_key, "redacted");
      assert.equal(raw.result[0].meta.note, "fine");
    },
  );
});

test("rocketnet never leaks the bearer token into an error", async () => {
  await withRocketNet(
    [
      {
        expected: "GET /v1/sites/123/plugins",
        status: 401,
        body: `{"message":"token ${TOKEN} rejected"}`,
      },
    ],
    async (client) => {
      await assert.rejects(
        client.read({ kind: "plugins", envId: "123" }),
        (error) => {
          assert.equal(error.code, "credential_invalid");
          const serialized = `${error.message} ${JSON.stringify(error.details)}`;
          assert.ok(!serialized.includes(TOKEN), serialized);
          return true;
        },
      );
    },
  );
});

test("rocketnet never leaks the password into a failed token exchange", async () => {
  // The password is only ever sent to /v1/login; a hostile or noisy error body
  // that echoes it back must not survive into the CliError.
  const server = await startRocketNet([], {
    status: 401,
    body: `{"message":"bad credentials for ${USERNAME}/${PASSWORD}"}`,
  });
  try {
    const client = await createRocketNetClient(
      rocketNetContext(server.baseUrl),
    );
    await assert.rejects(client.validate(), (error) => {
      assert.equal(error.code, "credential_invalid");
      const serialized = `${error.message} ${JSON.stringify(error.details)}`;
      assert.ok(!serialized.includes(PASSWORD), serialized);
      return true;
    });
    assert.deepEqual(server.failures, []);
    assert.equal(server.consumed, 0);
  } finally {
    await server.close();
  }
});

test("rocketnet exchanges the credential for a token exactly once", async () => {
  await withRocketNet(
    [
      { expected: "GET /v1/sites/1/plugins", body: OK },
      { expected: "GET /v1/sites/2/plugins", body: OK },
    ],
    async (client, server) => {
      await client.read({ kind: "plugins", envId: "1" });
      await client.read({ kind: "plugins", envId: "2" });
      assert.equal(server.logins, 1);
    },
  );
});

test("rocketnet rejects a login response without a token", async () => {
  const server = await startRocketNet([]);
  const context = rocketNetContext(server.baseUrl);
  const client = await createRocketNetClient({
    ...context,
    baseUrl: server.baseUrl,
    createHttpClient: (overrides) =>
      createHttpClient({
        baseUrl: server.baseUrl,
        providerLabel: "Rocket.net",
        retry: { maxAttempts: 1 },
        ...overrides,
        fetch: async (url, init) => {
          if (new URL(url).pathname === "/v1/login")
            return new Response('{"token":""}', {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          return fetch(url, init);
        },
      }),
  });
  try {
    await assert.rejects(
      client.read({ kind: "plugins", envId: "1" }),
      (error) => {
        assert.equal(error.code, "credential_invalid");
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("rocketnet requires a username and a password", async () => {
  const context = rocketNetContext("https://api.rocket.net");
  await assert.rejects(
    async () =>
      createRocketNetClient({
        ...context,
        identity: undefined,
        companyId: undefined,
      }),
    (error) => {
      assert.equal(error.code, "credential_missing");
      assert.match(error.message, /ROCKETNET_USERNAME/);
      return true;
    },
  );
  await assert.rejects(
    async () =>
      createRocketNetClient({
        ...context,
        secret: { ...context.secret, length: 0, reveal: () => "" },
      }),
    (error) => {
      assert.equal(error.code, "credential_missing");
      return true;
    },
  );
});

test("rocketnet reports its deliberate gaps as provider_unsupported", async () => {
  const unsupportedReads = [
    { kind: "site-domain-verification", siteDomainId: "d-1" },
    { kind: "dns-domains" },
    { kind: "dns-records", domainId: "d-1" },
    { kind: "downloadable-backups", envId: "1" },
    { kind: "redirects", envId: "1" },
    { kind: "denied-ips", envId: "1" },
    { kind: "company-plugins" },
    { kind: "company-themes" },
    { kind: "ssh-password", envId: "1" },
  ];
  const unsupportedActions = [
    { kind: "reset-site", siteId: "1" },
    { kind: "restart-php", envId: "1" },
    { kind: "set-php-version" },
    { kind: "set-denied-ips" },
    { kind: "apply-redirects", envId: "1" },
    { kind: "dns-record-create", domainId: "d-1" },
    { kind: "dns-record-update", domainId: "d-1" },
    { kind: "dns-record-delete", domainId: "d-1" },
    { kind: "set-ssh-status", envId: "1" },
    { kind: "set-ssh-password-status", envId: "1" },
    { kind: "generate-ssh-password", envId: "1" },
    { kind: "set-ssh-allowlist", envId: "1" },
    { kind: "change-ssh-password-expiration", envId: "1" },
    { kind: "toggle-sftp-accounts", envId: "1" },
    { kind: "delete-backup", backupId: 7 },
    { kind: "remove-sftp-account", sftpAccountId: "a-1" },
  ];

  await withRocketNet([], async (client) => {
    for (const request of unsupportedReads) {
      await assert.rejects(client.read(request), (error) => {
        assert.equal(error.code, "provider_unsupported", request.kind);
        assert.match(error.message, /Rocket\.net/);
        return true;
      });
    }
    for (const request of unsupportedActions) {
      await assert.rejects(client.action(request), (error) => {
        assert.equal(error.code, "provider_unsupported", request.kind);
        assert.match(error.message, /Rocket\.net/);
        return true;
      });
    }
  });
});
