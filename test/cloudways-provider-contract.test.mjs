// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract test for the Cloudways provider client, ported from
 * `internal/providers/cloudways_test.go`.
 *
 * The Go original drives the client against an `httptest.Server` that replays a
 * fixed route list and asserts on the request line. This suite does the same
 * with a `node:http` server bound to 127.0.0.1:0: every request is recorded and
 * asserted after the call, so a failed assertion is reported by the test rather
 * than swallowed inside a request handler. Nothing here touches the network, a
 * real credential, or a real Cloudways account.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { SecretValue } from "../dist/credentials/store.js";
import { envCredential } from "../dist/config/schema.js";
import { createHttpClient } from "../dist/hosting/http-client.js";
import { createCloudwaysClient } from "../dist/hosting/providers/cloudways.js";

/** Obvious fake. It neither is, nor resembles, a real Cloudways credential. */
const ACCESS_TOKEN = "not-a-real-cloudways-access-token";

/**
 * The mock API is mounted under a path, like the real
 * `https://api.cloudways.com/api/v2` default, and `line` reports the request
 * with that prefix removed so every expectation below reads exactly like the
 * request line the Go test asserts on.
 */
const BASE_PATH = "/api/v2";

/**
 * Starts a mock Cloudways API that answers requests from `routes` in order and
 * fails any request past the end of the list, exactly like the Go helper.
 */
async function withServer(routes, run) {
  const requests = [];
  let index = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      assert.ok(
        request.url.startsWith(`${BASE_PATH}/`),
        `request ${request.url} escaped the configured API base path`,
      );
      const target = request.url.slice(BASE_PATH.length);
      requests.push({
        method: request.method,
        target,
        line: `${request.method} ${target}`,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const route = routes[index];
      index += 1;
      if (route === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "unexpected request" }));
        return;
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
  try {
    return await run({
      baseUrl: `http://127.0.0.1:${port}${BASE_PATH}`,
      requests,
    });
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

/**
 * A hand-made `ProviderClientContext`, the exact shape
 * `createHostingClientFactory` hands a provider module.
 */
function contextFor(baseUrl, overrides = {}, http = {}) {
  const profile = {
    provider: "cloudways",
    credential: envCredential("CLOUDWAYS_ACCESS_TOKEN"),
  };
  return {
    provider: "cloudways",
    providerLabel: "Cloudways",
    profileName: "cloudways-test",
    profile,
    baseUrl,
    secret: new SecretValue(ACCESS_TOKEN, "env", "env:CLOUDWAYS_ACCESS_TOKEN"),
    credentialSource: "env:CLOUDWAYS_ACCESS_TOKEN",
    companyId: undefined,
    identity: undefined,
    tokenUrl: undefined,
    env: {},
    createHttpClient: (options = {}) =>
      createHttpClient({
        baseUrl,
        providerLabel: "Cloudways",
        ...http,
        ...options,
      }),
    ...overrides,
  };
}

function clientFor(baseUrl, overrides, http) {
  return createCloudwaysClient(contextFor(baseUrl, overrides, http));
}

function assertAccessToken(request) {
  assert.equal(request.headers["x-access-token"], ACCESS_TOKEN);
  assert.equal(request.headers.authorization, undefined);
}

/** Nothing HQ hands back may carry the access token. */
function assertNoSecrets(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(text.includes(ACCESS_TOKEN), false);
}

test("cloudways validates credentials", async () => {
  await withServer(
    [{ body: JSON.stringify({ status: true, servers: [] }) }],
    async ({ baseUrl, requests }) => {
      const client = clientFor(baseUrl);
      const validation = await client.validate();

      assert.equal(validation.provider, "cloudways");
      assert.equal(validation.status, "active");
      assert.equal(validation.companyId, null);
      assert.equal(validation.credential, "env:CLOUDWAYS_ACCESS_TOKEN");

      assert.equal(requests.length, 1);
      assert.equal(requests[0].line, "GET /server");
      assertAccessToken(requests[0]);
      assertNoSecrets(validation);
    },
  );
});

test("cloudways requires a non-empty access token before any network call", async () => {
  await withServer([], async ({ baseUrl, requests }) => {
    assert.throws(
      () =>
        clientFor(baseUrl, {
          secret: new SecretValue("", "env", "env:CLOUDWAYS_ACCESS_TOKEN"),
        }),
      {
        code: "credential_missing",
      },
    );
    assert.equal(requests.length, 0);
  });
});

test("cloudways lists sites with one synthetic environment", async () => {
  const routes = [
    {
      body: JSON.stringify({
        status: true,
        servers: [
          {
            id: 123,
            status: "running",
            apps: [
              {
                id: 456,
                label: "Demo App",
                application: "wordpress",
                app_version: "6.5",
                cname: "demo.example.com",
              },
            ],
          },
        ],
      }),
    },
  ];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);
    const sites = await client.listSites({ includeEnvironments: true });

    assert.equal(sites.length, 1);
    const [site] = sites;
    assert.equal(site.id, "456");
    assert.equal(site.name, "Demo App");
    assert.equal(site.displayName, "Demo App");
    assert.equal(site.status, "running");
    assert.equal(site.primaryDomain, "demo.example.com");
    assert.equal(site.environments.length, 1);

    const [environment] = site.environments;
    assert.equal(environment.id, "123:456");
    assert.equal(environment.name, "wordpress");
    assert.equal(environment.displayName, "wordpress");
    assert.equal(environment.isBlocked, false);
    assert.equal(environment.isPremium, false);
    assert.equal(environment.wordpressVersion, "6.5");
    assert.equal(environment.primaryDomain, "demo.example.com");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].line, "GET /server");
    assertAccessToken(requests[0]);
  });
});

test("cloudways omits environments unless they are requested", async () => {
  const routes = [
    {
      body: JSON.stringify({
        servers: [
          { id: "s1", status: "running", apps: [{ id: "a1", name: "one" }] },
        ],
      }),
    },
  ];
  await withServer(routes, async ({ baseUrl }) => {
    const client = clientFor(baseUrl);
    const sites = await client.listSites();
    assert.deepEqual(sites, [
      { id: "a1", name: "one", displayName: "one", status: "running" },
    ]);
  });
});

test("cloudways inherits the server id and status onto its apps", async () => {
  const routes = [
    {
      body: JSON.stringify({
        data: {
          servers: [
            {
              id: 7,
              status: "stopped",
              apps: [
                {
                  app_id: 8,
                  app_label: "Blog",
                  installed_app: "WordPress 6.4",
                },
              ],
            },
          ],
        },
      }),
    },
  ];
  await withServer(routes, async ({ baseUrl }) => {
    const client = clientFor(baseUrl);
    const sites = await client.listSites({ includeEnvironments: true });
    assert.equal(sites.length, 1);
    assert.equal(sites[0].id, "8");
    assert.equal(sites[0].status, "stopped");
    assert.equal(sites[0].primaryDomain, undefined);
    const [environment] = sites[0].environments;
    assert.equal(environment.id, "7:8");
    assert.equal(environment.name, "live");
    assert.equal(environment.displayName, "Live");
    // "stopped" is not one of the healthy statuses, so the env reads as blocked.
    assert.equal(environment.isBlocked, true);
    // No wordpress_version/app_version, so nothing to report.
    assert.equal(environment.wordpressVersion, undefined);
  });
});

test("cloudways reports a version only for WordPress applications", async () => {
  const routes = [
    {
      body: JSON.stringify([
        {
          id: 1,
          status: "running",
          apps: [
            { id: 2, application: "php", app_version: "8.2", server_id: 1 },
          ],
        },
      ]),
    },
  ];
  await withServer(routes, async ({ baseUrl }) => {
    const client = clientFor(baseUrl);
    const sites = await client.listSites({ includeEnvironments: true });
    assert.equal(sites[0].environments[0].wordpressVersion, undefined);
    assert.equal(sites[0].environments[0].name, "php");
  });
});

test("cloudways resolves a site by app id, by server:app id, and reports a miss", async () => {
  const servers = JSON.stringify({
    servers: [
      {
        id: 123,
        status: "running",
        apps: [{ id: 456, label: "Demo", application: "wordpress" }],
      },
    ],
  });
  const routes = [
    { body: servers },
    { body: servers },
    { body: servers },
    { body: servers },
  ];
  await withServer(routes, async ({ baseUrl }) => {
    const client = clientFor(baseUrl);

    const byApp = await client.getSite("456");
    assert.equal(byApp.id, "456");
    assert.equal(byApp.environments.length, 1);

    const byPair = await client.getSite("123:456");
    assert.equal(byPair.id, "456");

    const environments = await client.listEnvironments("123:456");
    assert.deepEqual(
      environments.map((environment) => environment.id),
      ["123:456"],
    );

    await assert.rejects(client.getSite("999"), (error) => {
      assert.equal(error.code, "not_found");
      assert.match(error.message, /999/);
      return true;
    });
  });
});

test("cloudways create site uses the app endpoint", async () => {
  const routes = [
    { body: JSON.stringify({ operation_id: "op-123", message: "queued" }) },
  ];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);
    const result = await client.action({
      kind: "create-site",
      mode: "wordpress",
      body: {
        server_id: "123",
        application: "wordpress",
        app_version: "6.5",
        app_label: "Demo",
      },
    });

    assert.equal(result.provider, "cloudways");
    assert.equal(result.action, "sites.create");
    assert.equal(result.status, 200);
    assert.equal(result.operationId, "op-123");
    assert.equal(result.message, "queued");
    assert.deepEqual(result.raw, {
      operation_id: "op-123",
      message: "queued",
    });

    // Cloudways takes every field as a sorted query parameter, not a body.
    assert.equal(
      requests[0].line,
      "POST /app?app_label=Demo&app_version=6.5&application=wordpress&server_id=123",
    );
    assert.equal(requests[0].body, "");
    assertAccessToken(requests[0]);
  });
});

test("cloudways create site honours plain and clone modes", async () => {
  const routes = [
    { body: JSON.stringify({ message: "queued" }) },
    { body: JSON.stringify({ message: "queued" }) },
    { body: JSON.stringify({ message: "queued" }) },
  ];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);

    const plain = await client.action({
      kind: "create-site",
      mode: "plain",
      body: { server_id: "123", application: "php" },
    });
    assert.equal(plain.action, "sites.create-plain");
    assert.equal(requests[0].line, "POST /app?application=php&server_id=123");

    const clone = await client.action({
      kind: "create-site",
      mode: "clone",
      body: { server_id: "123", app_id: "456" },
    });
    assert.equal(clone.action, "sites.clone");
    assert.equal(requests[1].line, "POST /app/clone?app_id=456&server_id=123");

    const remote = await client.action({
      kind: "create-site",
      mode: "clone",
      body: { server_id: "123", app_id: "456", destination_server_id: "789" },
    });
    assert.equal(remote.action, "sites.clone");
    assert.equal(
      requests[2].line,
      "POST /app/cloneToOtherServer?app_id=456&destination_server_id=789&server_id=123",
    );
  });
});

test("cloudways clear cache uses the varnish endpoint", async () => {
  const routes = [{ body: JSON.stringify({ message: "queued" }) }];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);
    const result = await client.action({
      kind: "clear-cache",
      cache: "site",
      body: { environment_id: "123:456" },
    });

    assert.equal(result.action, "cache.clear");
    assert.equal(
      requests[0].line,
      "POST /service/varnish?action=purge&app_id=456&environment_id=123%3A456&server_id=123",
    );
  });
});

test("cloudways restart php discovers the versioned fpm service", async () => {
  const routes = [
    {
      body: JSON.stringify({
        status: true,
        services: {
          status: {
            apache2: "running",
            "php8.2-fpm": "running",
            varnish: "running",
          },
        },
      }),
    },
    { body: JSON.stringify({ message: "queued" }) },
  ];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);
    const result = await client.action({
      kind: "restart-php",
      envId: "123:456",
    });

    assert.equal(result.action, "php.restart");
    // The env query keeps its declared order; the body-derived query is sorted.
    assert.equal(requests[0].line, "GET /service?server_id=123&app_id=456");
    assert.equal(
      requests[1].line,
      "POST /service/state?app_id=456&server_id=123&service=php8.2-fpm&state=restart",
    );
  });
});

test("cloudways restart php picks the highest reported fpm version", async () => {
  const routes = [
    {
      body: JSON.stringify({
        services: {
          status: {
            "php7.4-fpm": "running",
            "php8.1-fpm": "stopped",
            "php8.3-fpm": "unknown",
            mysql: "running",
          },
        },
      }),
    },
    { body: JSON.stringify({ message: "queued" }) },
  ];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);
    await client.action({ kind: "restart-php", envId: "123:456" });
    // "unknown" services are ignored, and the last name in sort order wins.
    assert.equal(
      requests[1].line,
      "POST /service/state?app_id=456&server_id=123&service=php8.1-fpm&state=restart",
    );
  });
});

test("cloudways restart php fails when no fpm service is reported", async () => {
  const routes = [
    { body: JSON.stringify({ services: { status: { mysql: "running" } } }) },
  ];
  await withServer(routes, async ({ baseUrl }) => {
    const client = clientFor(baseUrl);
    await assert.rejects(
      client.action({ kind: "restart-php", envId: "123:456" }),
      { code: "not_found" },
    );
  });
});

test("cloudways domain actions send the complete alias list", async () => {
  const routes = [
    { body: JSON.stringify({ message: "ok" }) },
    { body: JSON.stringify({ message: "ok" }) },
  ];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);

    const added = await client.action({
      kind: "add-domain",
      envId: "123:456",
      body: { domain: "demo.example.com" },
    });
    assert.equal(added.action, "domains.add");
    assert.equal(
      requests[0].line,
      "POST /app/manage/aliases?aliases=demo.example.com&app_id=456&domain=demo.example.com&server_id=123",
    );

    const primary = await client.action({
      kind: "change-primary-domain",
      envId: "123:456",
      body: { domain: "demo.example.com" },
    });
    assert.equal(primary.action, "domains.primary");
    assert.equal(
      requests[1].line,
      "POST /app/manage/cname?aliases=demo.example.com&app_id=456&cname=demo.example.com&domain=demo.example.com&server_id=123",
    );
  });
});

test("cloudways backup creation chooses the server or app endpoint", async () => {
  const routes = [
    { body: JSON.stringify({ message: "ok" }) },
    { body: JSON.stringify({ message: "ok" }) },
  ];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);

    const app = await client.action({
      kind: "create-backup",
      envId: "123:456",
    });
    assert.equal(app.action, "backups.create");
    assert.equal(
      requests[0].line,
      "POST /app/manage/backup?app_id=456&server_id=123",
    );

    await client.action({
      kind: "create-backup",
      envId: "",
      body: { server_id: "123" },
    });
    assert.equal(requests[1].line, "POST /server/manage/backup?server_id=123");
  });
});

test("cloudways creates a staging environment", async () => {
  const routes = [{ body: JSON.stringify({ message: "ok" }) }];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);

    const created = await client.action({
      kind: "create-environment",
      siteId: "123:456",
      mode: "clone",
      body: { server_id: "123", app_id: "456" },
    });
    assert.equal(created.action, "envs.create");
    assert.equal(
      requests[0].line,
      "POST /staging/app/cloneApp?app_id=456&server_id=123",
    );
  });
});

test("cloudways requires server_id:app_id where the API demands both", async () => {
  await withServer([], async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);

    await assert.rejects(
      client.action({ kind: "restart-php", envId: "onlyserver" }),
      { code: "usage_error" },
    );
    await assert.rejects(
      client.action({ kind: "create-backup", envId: "", body: {} }),
      { code: "usage_error" },
    );
    await assert.rejects(
      client.read({ kind: "analytics-usage", siteId: "", metric: "" }),
      { code: "usage_error" },
    );
    await assert.rejects(
      client.action({ kind: "create-site", mode: "clone", body: [1, 2] }),
      { code: "usage_error" },
    );

    // None of the above reached the network.
    assert.equal(requests.length, 0);
  });
});

test("cloudways reads regions and analytics", async () => {
  const routes = [
    { body: JSON.stringify({ regions: [{ id: "ams", name: "Amsterdam" }] }) },
    { body: JSON.stringify({ disk: { used: 1 } }) },
    { body: JSON.stringify({ summary: {} }) },
    { body: JSON.stringify({ detail: {} }) },
  ];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);

    assert.deepEqual(await client.read({ kind: "regions" }), {
      regions: [{ id: "ams", name: "Amsterdam" }],
    });
    assert.equal(requests[0].line, "GET /regions");

    await client.read({ kind: "analytics-usage", siteId: "123", metric: "" });
    assert.equal(requests[1].line, "GET /server/123/diskUsage");

    await client.read({
      kind: "analytics-usage",
      siteId: "123:456",
      metric: "bandwidth",
    });
    assert.equal(
      requests[2].line,
      "GET /app/monitor/summary?server_id=123&app_id=456&type=bandwidth",
    );

    await client.read({
      kind: "analytics-env",
      envId: "123:456",
      metric: "disk",
      query: [["duration", "1d"]],
    });
    assert.equal(
      requests[3].line,
      "GET /app/monitor/detail?server_id=123&app_id=456&duration=1d&target=disk",
    );
  });
});

test("cloudways staging activity uses the bounded documented log endpoint", async () => {
  await withServer(
    [
      {
        body: JSON.stringify({
          logs: [{ action: "sync", status: "completed" }],
        }),
      },
    ],
    async ({ baseUrl, requests }) => {
      const client = clientFor(baseUrl);
      await assert.rejects(client.read({ kind: "activity" }), {
        code: "usage_error",
      });
      assert.equal(requests.length, 0);
      const result = await client.read({
        kind: "activity",
        query: [
          ["site_id", "123:456"],
          ["unknown", "ignored"],
        ],
      });
      assert.deepEqual(result, {
        logs: [{ action: "sync", status: "completed" }],
      });
      assert.equal(
        requests[0].line,
        "GET /staging/app/logs?server_id=123&app_id=456",
      );
    },
  );
});

test("cloudways WP Manager setup uses authenticated form bodies and confirms activation", async () => {
  const inactive = {
    success: true,
    data: [{ slug: "novamira", version: "1.12.4", status: "inactive" }],
  };
  const active = {
    success: true,
    data: [{ slug: "novamira", version: "1.12.4", status: "active" }],
  };
  const routes = [
    {
      body: JSON.stringify({
        servers: [{ id: 123, apps: [{ id: 456, cname: "example.test" }] }],
      }),
    },
    {
      body: JSON.stringify({ settings: { package_versions: { php: "8.3" } } }),
    },
    { body: JSON.stringify({ success: true, data: { core_version: "6.9" } }) },
    { body: JSON.stringify(inactive) },
    { body: JSON.stringify({ success: true, operation_id: "fake-op" }) },
    { body: JSON.stringify(active) },
  ];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const result = await clientFor(baseUrl).action({
      kind: "setup-novamira",
      envId: "123:456",
    });
    assert.equal(result.raw.aiEnabled, null);
    assert.equal(result.raw.version, "1.12.4");
    assert.deepEqual(
      requests.slice(0).map((request) => request.line),
      [
        "GET /server",
        "GET /server/manage/settings?server_id=123",
        "GET /wpsite/coreinfo/123/456",
        "GET /plugins/123/456",
        "POST /plugins/activate",
        "GET /plugins/123/456",
      ],
    );
    const activation = requests[4];
    assert.match(
      activation.headers["content-type"],
      /application\/x-www-form-urlencoded/,
    );
    assert.equal(
      new URLSearchParams(activation.body).get("filename"),
      "novamira/novamira.php",
    );
    for (const request of requests.slice(0)) {
      assertAccessToken(request);
      assert.equal(request.target.includes(ACCESS_TOKEN), false);
      assert.equal(request.body.includes(ACCESS_TOKEN), false);
    }
  });
});

test("cloudways reports its capability list", async () => {
  await withServer([], async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);
    const capabilities = await client.read({ kind: "capabilities" });

    assert.ok(Array.isArray(capabilities));
    const byName = new Map(
      capabilities.map((capability) => [capability.name, capability]),
    );
    assert.equal(byName.size, capabilities.length);

    assert.deepEqual(byName.get("providers.validate"), {
      name: "providers.validate",
      supported: true,
    });
    assert.deepEqual(byName.get("sites.list"), {
      name: "sites.list",
      supported: true,
      notes: "uses GET /apps",
    });
    assert.deepEqual(byName.get("cache.clear"), {
      name: "cache.clear",
      supported: true,
      notes: "uses POST /service/varnish with action=purge",
    });
    for (const name of [
      "envs.create-plain",
      "envs.push",
      "domains.list",
      "backups.list",
      "php.set-version",
      "wp.plugins.install",
      "wp.themes.list",
      "wp-cli.run",
      "logs.get",
      "analytics.env",
    ]) {
      assert.equal(byName.get(name).supported, false, name);
      assert.equal(typeof byName.get(name).notes, "string");
    }
    for (const name of [
      "wp.plugins.list",
      "activity.list",
      "novamira.setup",
      "providers.capabilities",
      "sites.get",
      "envs.list",
      "envs.get",
      "ops.get",
      "ops.wait",
      "regions.list",
      "sites.create",
      "sites.create-plain",
      "sites.clone",
      "envs.create",
      "envs.clone",
      "domains.add",
      "domains.primary",
      "backups.create",
      "php.restart",
      "analytics.usage",
    ]) {
      assert.equal(byName.get(name).supported, true, name);
    }

    // Capabilities are a pure local answer: no request is made.
    assert.equal(requests.length, 0);
  });
});

test("cloudways refuses the operations it deliberately does not map", async () => {
  await withServer([], async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);

    const unsupportedReads = [
      { kind: "site-domains", envId: "123:456" },
      { kind: "site-domain-verification", siteDomainId: "1" },
      { kind: "dns-domains" },
      { kind: "dns-records", domainId: "1" },
      { kind: "backups", envId: "123:456" },
      { kind: "downloadable-backups", envId: "123:456" },
      { kind: "logs", envId: "123:456", fileName: "error.log", lines: 10 },
      { kind: "redirects", envId: "123:456" },
      { kind: "denied-ips", envId: "123:456" },
      { kind: "themes", envId: "123:456" },
      { kind: "company-plugins" },
      { kind: "company-themes" },
      { kind: "file-list", envId: "123:456" },
    ];
    for (const request of unsupportedReads) {
      await assert.rejects(
        client.read(request),
        (error) => {
          assert.equal(error.code, "provider_unsupported");
          assert.equal(error.details.provider, "cloudways");
          assert.equal(error.details.request, request.kind);
          assert.match(error.message, /^Cloudways does not support /);
          return true;
        },
        request.kind,
      );
    }

    const unsupportedActions = [
      { kind: "push-environment", siteId: "123:456" },
      { kind: "set-php-version" },
      { kind: "update-plugin", envId: "123:456" },
      { kind: "bulk-update-plugins", envId: "123:456" },
      { kind: "update-theme", envId: "123:456" },
      { kind: "bulk-update-themes", envId: "123:456" },
      { kind: "run-wp-cli", envId: "123:456" },
      { kind: "set-denied-ips" },
      { kind: "apply-redirects", envId: "123:456" },
    ];
    for (const request of unsupportedActions) {
      await assert.rejects(
        client.action(request),
        (error) => {
          assert.equal(error.code, "provider_unsupported");
          assert.equal(error.details.provider, "cloudways");
          assert.equal(error.details.action, request.kind);
          return true;
        },
        request.kind,
      );
    }

    // A kind outside both unions is an internal error, never a silent success.
    await assert.rejects(client.read({ kind: "not-a-read" }), {
      code: "internal_error",
    });
    await assert.rejects(client.action({ kind: "not-an-action" }), {
      code: "internal_error",
    });

    assert.equal(requests.length, 0);
  });
});

test("cloudways operation status normalizes and redacts the raw payload", async () => {
  const routes = [
    {
      body: JSON.stringify({
        operation: {
          id: "op-123",
          is_completed: 1,
          status: "completed",
          message: "done",
        },
        app: [
          {
            app_password: "wp-secret",
            sys_password: "ssh-secret",
            mysql_password: "db-secret",
          },
        ],
      }),
    },
  ];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);
    const status = await client.operationStatus("op-123");

    assert.equal(status.provider, "cloudways");
    assert.equal(status.operationId, "op-123");
    assert.equal(status.status, 200);
    assert.equal(status.done, true);
    assert.equal(status.failed, false);
    assert.equal(status.message, "done");

    const raw = JSON.stringify(status.raw);
    for (const secret of ["wp-secret", "ssh-secret", "db-secret"]) {
      assert.equal(raw.includes(secret), false, `raw leaked ${secret}`);
    }
    assert.deepEqual(status.raw.app, [
      {
        app_password: "redacted",
        sys_password: "redacted",
        mysql_password: "redacted",
      },
    ]);
    assert.equal(status.raw.operation.id, "op-123");

    assert.equal(requests[0].line, "GET /operation/op-123?id=op-123");
  });
});

test("cloudways operation status derives done and failed from the status text", async () => {
  const routes = [
    { body: JSON.stringify({ operation: { status: "Failed" } }) },
    { body: JSON.stringify({ operation: { is_failed: "1" } }) },
    { body: JSON.stringify({ status: "running", message: "in progress" }) },
    { body: JSON.stringify({ operation: { is_completed: true } }) },
  ];
  await withServer(routes, async ({ baseUrl }) => {
    const client = clientFor(baseUrl);

    const failed = await client.operationStatus("1");
    assert.equal(failed.done, true);
    assert.equal(failed.failed, true);
    assert.equal(failed.message, undefined);

    const flagged = await client.operationStatus("2");
    assert.equal(flagged.failed, true);
    assert.equal(flagged.done, false);

    const running = await client.operationStatus("3");
    assert.equal(running.done, false);
    assert.equal(running.failed, false);
    assert.equal(running.message, "in progress");

    const completed = await client.operationStatus("4");
    assert.equal(completed.done, true);
    assert.equal(completed.failed, false);
  });
});

test("cloudways extracts a nested operation id from an action response", async () => {
  const routes = [
    { body: JSON.stringify({ server: { operations: [{ id: 9001 }] } }) },
    { body: JSON.stringify({ operation: { id: 4242 } }) },
    { body: JSON.stringify({ msg: "accepted" }) },
    { body: "" },
  ];
  await withServer(routes, async ({ baseUrl }) => {
    const client = clientFor(baseUrl);

    const nested = await client.action({
      kind: "create-site",
      mode: "wordpress",
      body: {},
    });
    assert.equal(nested.operationId, "9001");

    const numeric = await client.action({
      kind: "create-site",
      mode: "wordpress",
      body: {},
    });
    assert.equal(numeric.operationId, "4242");

    const message = await client.action({
      kind: "create-site",
      mode: "wordpress",
      body: {},
    });
    assert.equal(message.operationId, undefined);
    assert.equal(message.message, "accepted");

    // An empty response body is `null`, exactly what Go's parseJSONBody yields.
    const empty = await client.action({
      kind: "create-site",
      mode: "wordpress",
      body: {},
    });
    assert.equal(empty.raw, null);
    assert.equal(empty.message, undefined);
    assert.equal(empty.operationId, undefined);
  });
});

test("cloudways encodes body values the way the Go client does", async () => {
  const routes = [{ body: JSON.stringify({ status: true }) }];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(baseUrl);
    await client.action({
      kind: "create-site",
      mode: "wordpress",
      body: {
        server_id: 123,
        ratio: 1.5,
        truthy: true,
        falsy: false,
        missing: null,
        nested: { a: 1 },
        list: ["x"],
        "": "dropped",
      },
    });

    const query = new URL(requests[0].target, "http://127.0.0.1").searchParams;
    assert.equal(query.get("server_id"), "123");
    assert.equal(query.get("ratio"), "1.5");
    assert.equal(query.get("truthy"), "1");
    assert.equal(query.get("falsy"), "0");
    assert.equal(query.get("missing"), "");
    assert.equal(query.get("nested"), '{"a":1}');
    assert.equal(query.get("list"), '["x"]');
    assert.equal(query.has(""), false);
  });
});

test("cloudways sends the access token only as a redacted header", async () => {
  const diagnostics = [];
  const routes = [
    { body: JSON.stringify({ servers: [] }) },
    { body: JSON.stringify({ servers: [] }) },
  ];
  await withServer(routes, async ({ baseUrl, requests }) => {
    const client = clientFor(
      baseUrl,
      {},
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
    );

    await client.listSites();
    await client.listSites();

    assert.equal(requests.length, 2);
    assertAccessToken(requests[0]);
    assertAccessToken(requests[1]);

    assert.ok(diagnostics.length > 0);
    assertNoSecrets(diagnostics);
  });
});

test("cloudways surfaces an API failure without echoing the credential", async () => {
  const routes = [
    { status: 404, body: JSON.stringify({ message: "Application not found" }) },
  ];
  await withServer(routes, async ({ baseUrl }) => {
    const client = clientFor(baseUrl);
    await assert.rejects(client.read({ kind: "regions" }), (error) => {
      assert.equal(error.code, "not_found");
      assert.match(error.message, /Application not found/);
      assertNoSecrets(error.message);
      assertNoSecrets(error.details);
      return true;
    });
  });
});

test("cloudways reports a rejected access token as a credential problem", async () => {
  const routes = [
    { status: 401, body: JSON.stringify({ error: "invalid_token" }) },
  ];
  await withServer(routes, async ({ baseUrl }) => {
    const client = clientFor(baseUrl);
    await assert.rejects(client.validate(), (error) => {
      assert.equal(error.code, "credential_invalid");
      assertNoSecrets(error.message);
      assertNoSecrets(error.details);
      return true;
    });
  });
});
