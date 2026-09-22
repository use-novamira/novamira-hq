// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract test for the Pantheon provider client, ported from
 * `internal/providers/pantheon_test.go`.
 *
 * The Go original drives `PantheonClient` against an `httptest.Server` whose
 * handler asserts the request line, the `Authorization` header and body
 * substrings, then replies with a recorded-shape fixture. This suite does the
 * same with a `node:http` server on 127.0.0.1:0, except that the assertions run
 * after the call instead of inside the handler, so a failed expectation shows up
 * as a test failure rather than as a stray HTTP 500.
 *
 * Nothing here touches the network beyond loopback, and every credential is an
 * obvious fake.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { CliError } from "../dist/errors.js";
import { SecretValue } from "../dist/credentials/resolve.js";
import { wpCliResultsObservable } from "../dist/hosting/client.js";
import { createHttpClient } from "../dist/hosting/http-client.js";
import {
  serializeActionResult,
  serializeHostingSite,
  serializeProviderValidation,
} from "../dist/hosting/types.js";
import { createPantheonClient } from "../dist/hosting/providers/pantheon.js";

const MACHINE_TOKEN = "fake-machine-token-0000";
const SESSION_TOKEN = "fake-session-token-1111";
const CREDENTIAL_SOURCE = "env:PANTHEON_MACHINE_TOKEN";

const AUTHORIZE_ROUTE = {
  body: JSON.stringify({
    session: SESSION_TOKEN,
    expires_at: 1_893_456_000,
    user_id: "user-1",
  }),
};

/**
 * A sequential mock of the Pantheon Public API. Routes are consumed in order,
 * exactly like the Go `startPantheonTestServer` index counter; anything beyond
 * the script is recorded as unexpected and answered with a non-retryable 418 so
 * the shared HTTP client does not burn the retry budget on it.
 */
async function startPantheonServer(routes) {
  const calls = [];
  const unexpected = [];
  let index = 0;

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const line = `${request.method} ${request.url}`;
      const body = Buffer.concat(chunks).toString("utf8");
      const route = routes[index];
      index += 1;
      if (route === undefined) {
        unexpected.push(line);
        response.writeHead(418, { "content-type": "application/json" });
        response.end('{"message":"unexpected request"}');
        return;
      }
      calls.push({
        line,
        method: request.method,
        url: request.url,
        body,
        json: body === "" ? undefined : JSON.parse(body),
        authorization: request.headers.authorization,
        accept: request.headers.accept,
        contentType: request.headers["content-type"],
      });
      response.writeHead(route.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(route.body ?? "");
    });
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    calls,
    unexpected,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    },
  };
}

/**
 * A hand-made `ProviderClientContext` shaped exactly like the one
 * `createHostingClientFactory` builds, with `baseUrl` pointed at the mock and
 * the same `{...shared, baseUrl, providerLabel, ...overrides}` precedence.
 */
function pantheonContext(baseUrl, overrides = {}) {
  const profile = {
    provider: "pantheon",
    credential: { type: "env", name: "PANTHEON_MACHINE_TOKEN" },
    ...(overrides.companyId === undefined
      ? {}
      : { companyId: overrides.companyId }),
  };
  return {
    provider: "pantheon",
    providerLabel: "Pantheon",
    profileName: "pantheon-test",
    profile,
    baseUrl,
    secret: new SecretValue(MACHINE_TOKEN, "env", CREDENTIAL_SOURCE),
    credentialSource: CREDENTIAL_SOURCE,
    companyId: undefined,
    identity: undefined,
    tokenUrl: undefined,
    env: {},
    createHttpClient(clientOverrides) {
      return createHttpClient({
        baseUrl,
        providerLabel: "Pantheon",
        ...clientOverrides,
      });
    },
    ...overrides,
  };
}

/** Runs `body` against a scripted server and always closes it. */
async function withPantheon(routes, body, contextOverrides = {}) {
  const server = await startPantheonServer(routes);
  try {
    const client = await createPantheonClient(
      pantheonContext(server.baseUrl, contextOverrides),
    );
    return await body(client, server);
  } finally {
    await server.close();
  }
}

function assertNoUnexpected(server) {
  assert.deepEqual(server.unexpected, []);
}

async function rejectsWithCode(promise, code) {
  const error = await promise.then(
    () => undefined,
    (caught) => caught,
  );
  assert.ok(error instanceof CliError, `expected a CliError, got ${error}`);
  assert.equal(error.code, code);
  return error;
}

/* -------------------------------------------------------------------------- */
/* Ported from pantheon_test.go                                               */
/* -------------------------------------------------------------------------- */

// TestPantheonValidatesMachineToken
test("pantheon validates the machine token against the session endpoint", async () => {
  await withPantheon([AUTHORIZE_ROUTE], async (client, server) => {
    const validation = await client.validate();

    assert.equal(validation.provider, "pantheon");
    assert.equal(validation.status, "active");
    assert.equal(validation.companyId, "user-1");
    assert.equal(validation.credential, CREDENTIAL_SOURCE);

    assert.equal(server.calls.length, 1);
    const [authorize] = server.calls;
    assert.equal(authorize.line, "POST /v0/authorize/machine-token");
    assert.deepEqual(authorize.json, {
      machine_token: MACHINE_TOKEN,
      client: "novamira",
    });
    // The token exchange must not carry an Authorization header.
    assert.equal(authorize.authorization, undefined);
    assert.equal(authorize.accept, "application/json");
    assert.equal(authorize.contentType, "application/json");

    assert.deepEqual(serializeProviderValidation(validation), {
      provider: "pantheon",
      status: "active",
      company_id: "user-1",
      credential: CREDENTIAL_SOURCE,
    });
    assertNoUnexpected(server);
  });
});

// TestPantheonListsSitesAndEnvironments
test("pantheon lists sites with composite environment ids", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    {
      body: JSON.stringify([
        {
          id: "site-1",
          site: {
            id: "site-1",
            name: "example",
            label: "Example",
            frozen: false,
          },
        },
      ]),
    },
    {
      body: JSON.stringify({
        dev: { id: "dev", initialized: true, php_version: "8.3" },
        live: { id: "live", initialized: true },
      }),
    },
  ];

  await withPantheon(routes, async (client, server) => {
    const sites = await client.listSites({ includeEnvironments: true });

    assert.equal(sites.length, 1);
    const [site] = sites;
    assert.equal(site.id, "site-1");
    assert.equal(site.name, "example");
    assert.equal(site.displayName, "Example");
    assert.equal(site.status, "active");
    assert.equal(site.environments.length, 2);
    // The Go test asserts the id is NOT the bare "dev".
    assert.notEqual(site.environments[0].id, "dev");
    assert.deepEqual(site.environments[0], {
      id: "site-1:dev",
      name: "dev",
      displayName: "Dev",
      isBlocked: false,
      isPremium: false,
    });
    assert.deepEqual(site.environments[1], {
      id: "site-1:live",
      name: "live",
      displayName: "Live",
      isBlocked: false,
      isPremium: false,
    });

    assert.deepEqual(
      server.calls.map((call) => call.line),
      [
        "POST /v0/authorize/machine-token",
        "GET /v0/users/user-1/memberships/sites?limit=100",
        "GET /v0/sites/site-1/environments",
      ],
    );
    assert.equal(server.calls[1].authorization, `Bearer ${SESSION_TOKEN}`);
    assert.equal(server.calls[2].authorization, `Bearer ${SESSION_TOKEN}`);

    assert.deepEqual(serializeHostingSite(site).environments[0], {
      id: "site-1:dev",
      name: "dev",
      display_name: "Dev",
      is_blocked: false,
      is_premium: false,
    });
    assertNoUnexpected(server);
  });
});

// TestPantheonDomainsListUsesCompositeEnvID
test("pantheon domain list splits a composite environment id", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    { body: JSON.stringify({ domains: [{ domain: "example.com" }] }) },
  ];

  await withPantheon(routes, async (client, server) => {
    const raw = await client.read({
      kind: "site-domains",
      envId: "site-1:dev",
    });

    assert.ok(JSON.stringify(raw).includes("example.com"));
    assert.equal(
      server.calls[1].line,
      "GET /v0/sites/site-1/environments/dev/domains",
    );
    assert.equal(server.calls[1].authorization, `Bearer ${SESSION_TOKEN}`);
    assertNoUnexpected(server);
  });
});

// TestPantheonClearCacheAcceptsSiteIDInPayload
test("pantheon clear cache accepts the site id in the payload", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    {
      body: JSON.stringify({
        id: "workflow-1",
        active_description: "Clearing cache",
      }),
    },
  ];

  await withPantheon(routes, async (client, server) => {
    const result = await client.action({
      kind: "clear-cache",
      cache: "site",
      body: { site_id: "site-1", environment_id: "dev" },
    });

    assert.equal(result.operationId, "site-1:workflow-1");
    assert.equal(result.provider, "pantheon");
    assert.equal(result.action, "cache.clear");
    assert.equal(result.status, 200);
    assert.equal(result.message, "Clearing cache");

    assert.equal(
      server.calls[1].line,
      "POST /v0/sites/site-1/environments/dev/cache/clear",
    );
    // site_id and environment_id are consumed, framework_cache defaults to true.
    assert.deepEqual(server.calls[1].json, { framework_cache: true });
    assertNoUnexpected(server);
  });
});

/* -------------------------------------------------------------------------- */
/* Additional coverage of the ported surface                                  */
/* -------------------------------------------------------------------------- */

test("pantheon reports its capability list without any network call", async () => {
  await withPantheon([], async (client, server) => {
    const capabilities = await client.read({ kind: "capabilities" });

    assert.ok(Array.isArray(capabilities));
    assert.equal(capabilities.length, 35);
    const byName = new Map(capabilities.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("backups.restore").supported, true);

    assert.deepEqual(byName.get("providers.validate"), {
      name: "providers.validate",
      supported: true,
    });
    assert.deepEqual(byName.get("sites.list"), {
      name: "sites.list",
      supported: true,
      notes: "uses GET /v0/users/{user_id}/memberships/sites",
    });
    assert.deepEqual(byName.get("sites.clone"), {
      name: "sites.clone",
      supported: false,
      notes: "not supported by Pantheon's provider-neutral Novamira mapping",
    });
    assert.deepEqual(byName.get("wp-cli.run"), {
      name: "wp-cli.run",
      supported: false,
      notes: "not mapped for Pantheon in Novamira",
    });
    assert.equal(byName.get("analytics.env").supported, true);
    assert.equal(server.calls.length, 0);
    assertNoUnexpected(server);
  });
});

test("pantheon defaults to observable WP-CLI results", async () => {
  await withPantheon([], (client) => {
    // Go registers no WPCLIResultObserver for Pantheon, so the default holds.
    assert.equal(wpCliResultsObservable(client), true);
  });
});

test("pantheon rejects read requests it does not map", async () => {
  const unsupported = [
    { kind: "regions" },
    { kind: "activity" },
    { kind: "site-domain-verification", siteDomainId: "d-1" },
    { kind: "dns-domains" },
    { kind: "dns-records", domainId: "d-1" },
    { kind: "logs", envId: "s:dev", fileName: "error.log", lines: 10 },
    { kind: "redirects", envId: "s:dev" },
    { kind: "denied-ips", envId: "s:dev" },
    { kind: "plugins", envId: "s:dev" },
    { kind: "themes", envId: "s:dev" },
    { kind: "company-plugins" },
    { kind: "company-themes" },
    { kind: "analytics-usage", siteId: "s", metric: "visits" },
    { kind: "file-list", envId: "s:dev" },
  ];

  await withPantheon([], async (client, server) => {
    for (const request of unsupported) {
      const error = await rejectsWithCode(
        client.read(request),
        "provider_unsupported",
      );
      assert.ok(error.message.includes(request.kind));
      assert.equal(error.details.provider, "pantheon");
    }
    assert.equal(server.calls.length, 0);
    assertNoUnexpected(server);
  });
});

test("pantheon rejects action requests it does not map", async () => {
  const unsupported = [
    { kind: "push-environment", siteId: "s" },
    { kind: "restart-php", envId: "s:dev" },
    { kind: "set-php-version" },
    { kind: "update-plugin", envId: "s:dev" },
    { kind: "bulk-update-plugins", envId: "s:dev" },
    { kind: "update-theme", envId: "s:dev" },
    { kind: "bulk-update-themes", envId: "s:dev" },
    { kind: "run-wp-cli", envId: "s:dev" },
    { kind: "set-denied-ips" },
    { kind: "apply-redirects", envId: "s:dev" },
  ];

  await withPantheon([], async (client, server) => {
    for (const request of unsupported) {
      const error = await rejectsWithCode(
        client.action(request),
        "provider_unsupported",
      );
      assert.equal(error.details.action, request.kind);
    }
    assert.equal(server.calls.length, 0);
    assertNoUnexpected(server);
  });
});

test("pantheon refuses to clone a site", async () => {
  await withPantheon([], async (client, server) => {
    const error = await rejectsWithCode(
      client.action({ kind: "create-site", mode: "clone", body: {} }),
      "provider_unsupported",
    );
    assert.ok(error.message.includes("sites.clone"));
    assert.equal(server.calls.length, 0);
    assertNoUnexpected(server);
  });
});

test("pantheon create-site normalizes the body and resolves the new site name", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    {
      body: JSON.stringify({
        id: "workflow-9",
        active_description: "Creating",
      }),
    },
    { body: JSON.stringify({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }) },
  ];

  await withPantheon(routes, async (client, server) => {
    const result = await client.action({
      kind: "create-site",
      mode: "wordpress",
      body: { display_name: "My Site", name: "my-site", upstream_id: "u-1" },
    });

    assert.equal(server.calls[1].line, "POST /v0/sites");
    assert.deepEqual(server.calls[1].json, {
      label: "My Site",
      name: "my-site",
      site_name: "my-site",
      upstream_id: "u-1",
    });
    assert.equal(server.calls[2].line, "GET /v0/site-names/my-site");
    assert.equal(
      result.operationId,
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:workflow-9",
    );
    assert.equal(result.action, "sites.create");
    assertNoUnexpected(server);
  });
});

test("pantheon create-environment fills the multidev defaults", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    { body: JSON.stringify({ id: "workflow-5" }) },
  ];

  await withPantheon(routes, async (client, server) => {
    const result = await client.action({
      kind: "create-environment",
      siteId: "site-1",
      mode: "clone",
      body: { display_name: "feature-x", source_env: "live" },
    });

    assert.equal(server.calls[1].line, "POST /v0/sites/site-1/environments");
    assert.deepEqual(server.calls[1].json, {
      environment_name: "feature-x",
      from_environment: "live",
      clone_database: true,
      clone_files: true,
    });
    assert.equal(result.action, "envs.create");
    assert.equal(result.operationId, "site-1:workflow-5");
    assertNoUnexpected(server);
  });

  const bare = [AUTHORIZE_ROUTE, { body: JSON.stringify({}) }];
  await withPantheon(bare, async (client, server) => {
    await client.action({
      kind: "create-environment",
      siteId: "site-1",
      mode: "wordpress",
      body: { name: "qa", clone_files: false },
    });
    assert.deepEqual(server.calls[1].json, {
      environment_name: "qa",
      from_environment: "dev",
      clone_database: true,
      clone_files: false,
    });
    assertNoUnexpected(server);
  });
});

test("pantheon add-domain accepts domain_name and requires a domain", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    { body: JSON.stringify({ id: "workflow-7" }) },
  ];
  await withPantheon(routes, async (client, server) => {
    await client.action({
      kind: "add-domain",
      envId: "site-1:live",
      body: { domain_name: "example.com" },
    });
    assert.equal(
      server.calls[1].line,
      "POST /v0/sites/site-1/environments/live/domains",
    );
    assert.deepEqual(server.calls[1].json, { domain: "example.com" });
    assertNoUnexpected(server);
  });

  await withPantheon([AUTHORIZE_ROUTE], async (client, server) => {
    await rejectsWithCode(
      client.action({ kind: "add-domain", envId: "site-1:live", body: {} }),
      "usage_error",
    );
    assert.equal(server.calls.length, 0);
    assertNoUnexpected(server);
  });
});

test("pantheon change-primary-domain promotes an alternate key and uses PUT", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    { body: JSON.stringify({ id: "workflow-8" }) },
  ];
  await withPantheon(routes, async (client, server) => {
    await client.action({
      kind: "change-primary-domain",
      envId: "site-1:live",
      body: { domain_id: "example.com" },
    });
    assert.equal(
      server.calls[1].line,
      "PUT /v0/sites/site-1/environments/live/domains/primary",
    );
    assert.deepEqual(server.calls[1].json, { domain: "example.com" });
    assertNoUnexpected(server);
  });
});

test("pantheon create-backup defaults element and keep_for and drops tag", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    { body: JSON.stringify({ id: "workflow-d" }) },
  ];
  await withPantheon(routes, async (client, server) => {
    await client.action({
      kind: "create-backup",
      envId: "site-1:live",
      body: { tag: "manual" },
    });
    assert.equal(
      server.calls[1].line,
      "POST /v0/sites/site-1/environments/live/backups",
    );
    assert.deepEqual(server.calls[1].json, { element: "all", keep_for: 30 });
    assertNoUnexpected(server);
  });
});

test("pantheon restore backup puts the verified backup id in the path", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    { body: JSON.stringify({ id: "workflow-2" }) },
  ];

  await withPantheon(routes, async (client, server) => {
    const result = await client.action({
      kind: "restore-backup",
      targetEnvId: "site-1:live",
      body: { backup_id: "backup-1" },
    });

    assert.equal(result.operationId, "site-1:workflow-2");
    assert.equal(result.action, "backups.restore");
    assert.equal(
      server.calls[1].line,
      "POST /v0/sites/site-1/environments/live/backups/backup-1/restore",
    );
    assert.deepEqual(server.calls[1].json, { element: "all" });
    assertNoUnexpected(server);
  });
});

test("pantheon backup reads use the catalog endpoint", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    { body: JSON.stringify({ backups: [] }) },
    { body: JSON.stringify({ backups: [] }) },
  ];
  await withPantheon(routes, async (client, server) => {
    await client.read({ kind: "backups", envId: "site-1:live" });
    await client.read({ kind: "downloadable-backups", envId: "site-1:live" });
    assert.deepEqual(
      server.calls.slice(1).map((call) => call.line),
      [
        "GET /v0/sites/site-1/environments/live/backups/catalog",
        "GET /v0/sites/site-1/environments/live/backups/catalog",
      ],
    );
    assertNoUnexpected(server);
  });
});

test("pantheon analytics-env forwards the query string", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    { body: JSON.stringify({ timeseries: [] }) },
  ];
  await withPantheon(routes, async (client, server) => {
    await client.read({
      kind: "analytics-env",
      envId: "site-1:live",
      metric: "visits",
      query: [
        ["duration", "28d"],
        ["granularity", "day"],
      ],
    });
    assert.equal(
      server.calls[1].line,
      "GET /v0/sites/site-1/environments/live/metrics?duration=28d&granularity=day",
    );
    assertNoUnexpected(server);
  });
});

test("pantheon requires a site id and an environment id", async () => {
  await withPantheon([], async (client, server) => {
    const missingSite = await rejectsWithCode(
      client.read({ kind: "site-domains", envId: "dev" }),
      "usage_error",
    );
    assert.ok(missingSite.message.includes("site_id"));

    const missingEnv = await rejectsWithCode(
      client.action({
        kind: "clear-cache",
        cache: "site",
        body: { site_id: "site-1" },
      }),
      "usage_error",
    );
    assert.ok(missingEnv.message.includes("environment id"));

    // A non-object body is a usage error, mirroring Go's objectBody.
    await rejectsWithCode(
      client.action({
        kind: "clear-cache",
        cache: "site",
        body: "site-1:dev",
      }),
      "usage_error",
    );

    assert.equal(server.calls.length, 0);
    assertNoUnexpected(server);
  });
});

test("pantheon getSite embeds its environments", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    {
      body: JSON.stringify({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        name: "example",
        label: "",
        frozen: true,
      }),
    },
    {
      body: JSON.stringify({
        dev: { id: "dev", initialized: false },
        "feature-x": { initialized: true, lock: { locked: true } },
      }),
    },
  ];

  await withPantheon(routes, async (client, server) => {
    const site = await client.getSite("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    assert.equal(site.status, "frozen");
    // Falls back to `name` when `label` is empty.
    assert.equal(site.displayName, "example");
    assert.deepEqual(site.environments, [
      {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:dev",
        name: "dev",
        displayName: "Dev",
        isBlocked: true,
        isPremium: false,
      },
      {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:feature-x",
        name: "feature-x",
        displayName: "feature-x",
        isBlocked: true,
        isPremium: true,
      },
    ]);
    assert.deepEqual(
      server.calls.map((call) => call.line),
      [
        "POST /v0/authorize/machine-token",
        "GET /v0/sites/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "GET /v0/sites/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/environments",
      ],
    );
    assertNoUnexpected(server);
  });
});

test("pantheon prefers the configured company id over the session user id", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    { body: JSON.stringify([]) },
    { body: JSON.stringify([]) },
  ];
  await withPantheon(
    routes,
    async (client, server) => {
      // Go's Validate short-circuits on the profile's company id, so a profile
      // that names the Pantheon user validates without any request at all.
      const validation = await client.validate();
      assert.equal(validation.companyId, "user-9");
      assert.equal(server.calls.length, 0);

      const sites = await client.listSites();
      assert.deepEqual(sites, []);
      // The session is still exchanged (every authenticated request needs it),
      // but the user id comes from the profile, not from `user_id`.
      assert.deepEqual(
        server.calls.map((call) => call.line),
        [
          "POST /v0/authorize/machine-token",
          "GET /v0/users/user-9/memberships/sites?limit=100",
        ],
      );

      // An explicit scope wins over both.
      assert.deepEqual(await client.listSites({ companyId: "user-7" }), []);
      assert.equal(
        server.calls.at(-1).line,
        "GET /v0/users/user-7/memberships/sites?limit=100",
      );
      assertNoUnexpected(server);
    },
    { companyId: "user-9", identity: "user-9" },
  );
});

test("pantheon reuses one session across requests", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    { body: JSON.stringify({ domains: [] }) },
    { body: JSON.stringify({ domains: [] }) },
  ];
  await withPantheon(routes, async (client, server) => {
    await client.read({ kind: "site-domains", envId: "site-1:dev" });
    await client.read({ kind: "site-domains", envId: "site-1:live" });
    assert.equal(
      server.calls.filter(
        (call) => call.line === "POST /v0/authorize/machine-token",
      ).length,
      1,
    );
    assertNoUnexpected(server);
  });
});

test("pantheon operation status reads the site workflow", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    {
      body: JSON.stringify({
        id: "wf-1",
        result: "succeeded",
        active_description: "Cleared cache",
      }),
    },
  ];
  await withPantheon(routes, async (client, server) => {
    const status = await client.operationStatus(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:wf-1",
    );
    assert.equal(
      server.calls[1].line,
      "GET /v0/sites/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/workflows/wf-1",
    );
    assert.equal(status.provider, "pantheon");
    assert.equal(
      status.operationId,
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:wf-1",
    );
    assert.equal(status.status, 200);
    assert.equal(status.done, true);
    assert.equal(status.failed, false);
    assert.equal(status.message, "Cleared cache");
    assertNoUnexpected(server);
  });
});

test("pantheon operation status defaults to running and reports failure", async () => {
  await withPantheon(
    [AUTHORIZE_ROUTE, { body: JSON.stringify({ id: "wf-2" }) }],
    async (client, server) => {
      const status = await client.operationStatus(
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:wf-2",
      );
      assert.equal(status.done, false);
      assert.equal(status.failed, false);
      assertNoUnexpected(server);
    },
  );

  await withPantheon(
    [AUTHORIZE_ROUTE, { body: JSON.stringify({ result: "failed" }) }],
    async (client, server) => {
      const status = await client.operationStatus(
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:wf-3",
      );
      assert.equal(status.done, true);
      assert.equal(status.failed, true);
      assertNoUnexpected(server);
    },
  );
});

test("pantheon operation status falls back to the user workflow", async () => {
  const routes = [
    AUTHORIZE_ROUTE,
    { body: JSON.stringify({ id: "site-1" }) },
    { status: 404, body: JSON.stringify({ message: "not found" }) },
    { body: JSON.stringify({ result: "succeeded" }) },
  ];
  await withPantheon(routes, async (client, server) => {
    const status = await client.operationStatus("site-1:wf-4");
    assert.deepEqual(
      server.calls.map((call) => call.line),
      [
        "POST /v0/authorize/machine-token",
        "GET /v0/site-names/site-1",
        "GET /v0/sites/site-1/workflows/wf-4",
        "GET /v0/users/user-1/workflows/wf-4",
      ],
    );
    assert.equal(status.done, true);
    assertNoUnexpected(server);
  });
});

test("pantheon rejects a malformed operation id", async () => {
  await withPantheon([], async (client, server) => {
    for (const id of ["", "workflow-1", ":workflow-1", "site-1:"]) {
      const error = await rejectsWithCode(
        client.operationStatus(id),
        "usage_error",
      );
      assert.ok(error.message.includes("site_id:workflow_id"));
    }
    assert.equal(server.calls.length, 0);
    assertNoUnexpected(server);
  });
});

test("pantheon never leaks the machine token or the session token", async () => {
  const routes = [
    {
      status: 401,
      body: JSON.stringify({
        message: `machine token ${MACHINE_TOKEN} is not valid`,
      }),
    },
  ];
  await withPantheon(routes, async (client, server) => {
    const error = await rejectsWithCode(
      client.validate(),
      "credential_invalid",
    );
    const serialized = JSON.stringify({
      message: error.message,
      details: error.details,
    });
    assert.ok(!error.message.includes(MACHINE_TOKEN));
    assert.ok(!serialized.includes(MACHINE_TOKEN));
    assertNoUnexpected(server);
  });

  const ok = [AUTHORIZE_ROUTE, { body: JSON.stringify({ id: "workflow-e" }) }];
  await withPantheon(ok, async (client, server) => {
    const result = await client.action({
      kind: "clear-cache",
      cache: "site",
      body: { site_id: "site-1", environment_id: "dev" },
    });
    const serialized = JSON.stringify(serializeActionResult(result));
    assert.ok(!serialized.includes(MACHINE_TOKEN));
    assert.ok(!serialized.includes(SESSION_TOKEN));
    assertNoUnexpected(server);
  });
});

test("pantheon fails when the session response carries no session token", async () => {
  const routes = [{ body: JSON.stringify({ user_id: "user-1" }) }];
  await withPantheon(routes, async (client, server) => {
    await rejectsWithCode(client.validate(), "provider_error");
    assertNoUnexpected(server);
  });
});

test("pantheon fails when the session response carries no user id", async () => {
  const routes = [{ body: JSON.stringify({ session: SESSION_TOKEN }) }];
  await withPantheon(routes, async (client, server) => {
    await rejectsWithCode(client.validate(), "provider_error");
    assertNoUnexpected(server);
  });
});

test("pantheon rejects an empty machine token before any request", async () => {
  const server = await startPantheonServer([]);
  try {
    const context = pantheonContext(server.baseUrl, {
      secret: new SecretValue("", "env", CREDENTIAL_SOURCE),
    });
    await rejectsWithCode(
      Promise.resolve().then(() => createPantheonClient(context)),
      "credential_missing",
    );
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});
