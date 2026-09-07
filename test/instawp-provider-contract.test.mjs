// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * InstaWP provider contract, ported from `internal/providers/instawp_test.go`.
 *
 * Go drives the client with `httptest`; this suite binds a `node:http` server to
 * 127.0.0.1:0 and asserts on the method, request line and body of every call.
 * Nothing here reaches the real InstaWP API and the "credential" is an obvious
 * fake, asserted never to appear in an error, a diagnostic, or a result.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { envCredential } from "../dist/config/schema.js";
import { SecretValue } from "../dist/credentials/store.js";
import {
  ACTION_REQUEST_KINDS,
  READ_REQUEST_KINDS,
} from "../dist/hosting/client.js";
import { createHttpClient } from "../dist/hosting/http-client.js";
import { createInstaWpClient } from "../dist/hosting/providers/instawp.js";
import {
  serializeActionResult,
  serializeHostingSite,
  serializeOperationStatus,
  serializeProviderValidation,
} from "../dist/hosting/types.js";

/** An obvious fake. The Go suite asserts `Bearer secret`; this is its analogue. */
const API_KEY = "instawp-fake-api-key-not-a-secret";
const AUTHORIZATION = `Bearer ${API_KEY}`;

/**
 * The mock server is mounted below a base path, matching InstaWP's real
 * `https://app.instawp.io/api/v2` root, so the ported request lines exercise
 * path joining as well. `requestLines` strips it back off so each expectation
 * reads exactly like its Go original.
 */
const BASE_PATH = "/api/v2";

/** Every action InstaWP maps; the rest must report `provider_unsupported`. */
const SUPPORTED_ACTIONS = ["create-site", "run-wp-cli"];

/** `capabilities()` in the Go declaration order. */
const EXPECTED_CAPABILITIES = [
  ["providers.validate", true],
  ["providers.capabilities", true],
  ["sites.list", true],
  ["sites.get", true],
  ["envs.list", true, "InstaWP sites are exposed as one synthetic environment"],
  ["envs.get", true, "InstaWP sites are exposed as one synthetic environment"],
  ["ops.get", true, "uses the InstaWP task status endpoint"],
  ["ops.wait", true, "uses the InstaWP task status endpoint"],
  ["regions.list", false, "not mapped for InstaWP in Novamira"],
  ["activity.list", false, "not mapped for InstaWP in Novamira"],
  [
    "sites.create",
    true,
    "uses POST /sites or POST /sites/template when template_slug is supplied",
  ],
  ["sites.create-plain", true, "uses POST /sites"],
  [
    "sites.clone",
    true,
    "uses POST /sites/template when template_slug is supplied",
  ],
  [
    "envs.create",
    false,
    "InstaWP sites are exposed as one synthetic environment",
  ],
  [
    "envs.create-plain",
    false,
    "InstaWP sites are exposed as one synthetic environment",
  ],
  [
    "envs.clone",
    false,
    "InstaWP sites are exposed as one synthetic environment",
  ],
  [
    "envs.push",
    false,
    "InstaWP sites are exposed as one synthetic environment",
  ],
  ["domains.list", false, "not mapped for InstaWP in Novamira"],
  ["dns.domains.list", false, "not mapped for InstaWP in Novamira"],
  ["backups.list", false, "not mapped for InstaWP in Novamira"],
  [
    "cache.clear",
    false,
    "not supported by InstaWP's provider-neutral Novamira mapping",
  ],
  [
    "php.restart",
    false,
    "not supported by InstaWP's provider-neutral Novamira mapping",
  ],
  [
    "php.set-version",
    false,
    "not supported by InstaWP's provider-neutral Novamira mapping",
  ],
  ["wp.plugins.list", false, "not mapped for InstaWP in Novamira"],
  [
    "wp.plugins.install",
    true,
    "uses the InstaWP run-cmd endpoint for arbitrary WP-CLI commands",
  ],
  ["wp.themes.list", false, "not mapped for InstaWP in Novamira"],
  [
    "wp-cli.run",
    true,
    "uses the InstaWP run-cmd endpoint; command_id remains supported for saved commands",
  ],
  ["logs.get", false, "not mapped for InstaWP in Novamira"],
  ["analytics.usage", false, "not mapped for InstaWP in Novamira"],
  ["analytics.env", false, "not mapped for InstaWP in Novamira"],
];

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Serve `routes` in order, one per request, mirroring Go's
 * `startInstaWPTestServer`. An unexpected request answers 400 (a status the
 * shared HTTP client never retries) and is recorded for the assertion below.
 */
async function startServer(routes) {
  const state = { index: 0, requests: [], unexpected: [] };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const route = routes[state.index];
      state.index += 1;
      state.requests.push({
        line: `${request.method} ${request.url}`,
        body: Buffer.concat(chunks).toString("utf8"),
        authorization: request.headers.authorization ?? "",
        contentType: request.headers["content-type"] ?? "",
      });
      if (route === undefined) {
        state.unexpected.push(`${request.method} ${request.url}`);
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "unexpected request" }));
        return;
      }
      response.writeHead(route.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(route.body ?? "");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}${BASE_PATH}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A hand-made `ProviderClientContext`, the exact shape `factory.ts` hands a
 * provider module. Retries are disabled so a deliberate failure fixture does not
 * replay, and diagnostics are captured to prove the token never reaches them.
 */
function makeContext(baseUrl, options = {}) {
  const diagnostics = [];
  const context = {
    provider: "instawp",
    providerLabel: "InstaWP",
    profileName: "instawp-test",
    profile: {
      provider: "instawp",
      credential: envCredential("INSTAWP_API_KEY"),
      ...(options.companyId === undefined
        ? {}
        : { companyId: options.companyId }),
      apiBaseUrl: baseUrl,
    },
    baseUrl,
    secret: new SecretValue(API_KEY, "env", "env:INSTAWP_API_KEY"),
    credentialSource: "env:INSTAWP_API_KEY",
    companyId: options.companyId,
    identity: options.companyId,
    tokenUrl: undefined,
    env: {},
    createHttpClient: (overrides) =>
      createHttpClient({
        baseUrl,
        providerLabel: "InstaWP",
        retry: { maxAttempts: 1 },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        ...overrides,
      }),
  };
  return { context, diagnostics };
}

/**
 * Run `body` against a client wired to a mock server, then assert the exact
 * request lines the client produced and that every one carried the bearer token.
 */
async function withClient(routes, body, options = {}) {
  const server = await startServer(routes);
  try {
    const { context, diagnostics } = makeContext(server.url, options);
    const client = await createInstaWpClient(context);
    const result = await body(client, server.state, diagnostics);
    assert.deepEqual(server.state.unexpected, []);
    for (const request of server.state.requests)
      assert.equal(request.authorization, AUTHORIZATION);
    return result;
  } finally {
    await server.close();
  }
}

/** The request lines with the base path removed, asserting it was honoured. */
function requestLines(state) {
  return state.requests.map((request) => {
    const [method, target] = request.line.split(" ");
    assert.equal(
      target.startsWith(`${BASE_PATH}/`),
      true,
      `request escaped the API base path: ${request.line}`,
    );
    return `${method} ${target.slice(BASE_PATH.length)}`;
  });
}

/* -------------------------------------------------------------------------- */
/* Ported Go tests                                                            */
/* -------------------------------------------------------------------------- */

// TestInstaWPValidatesCredentials
test("validate reports the team id from GET /teams", async () => {
  await withClient(
    [
      {
        body: `{"status":true,"message":"Teams fetched successfully","data":[{"id":1179,"name":"Demo Team"}]}`,
      },
    ],
    async (client, state) => {
      const validation = await client.validate();
      assert.deepEqual(state.requests[0].line, `GET ${BASE_PATH}/teams`);
      assert.deepEqual(requestLines(state), ["GET /teams"]);
      assert.equal(validation.provider, "instawp");
      assert.equal(validation.status, "active");
      assert.equal(validation.companyId, "1179");
      assert.equal(validation.credential, "env:INSTAWP_API_KEY");
      assert.deepEqual(serializeProviderValidation(validation), {
        provider: "instawp",
        status: "active",
        company_id: "1179",
        credential: "env:INSTAWP_API_KEY",
      });
      assert.equal(client.provider, "instawp");
    },
  );
});

test("validate prefers the profile team id and tolerates an empty team list", async () => {
  await withClient(
    [{ body: `{"status":true,"data":[{"id":1179}]}` }],
    async (client) => {
      const validation = await client.validate();
      assert.equal(validation.companyId, "team-42");
    },
    { companyId: "team-42" },
  );

  await withClient([{ body: `{"status":true,"data":[]}` }], async (client) => {
    const validation = await client.validate();
    assert.equal(validation.companyId, null);
    assert.deepEqual(serializeProviderValidation(validation).company_id, null);
  });
});

test("validate fails loudly when the envelope reports status false", async () => {
  await withClient(
    [{ body: `{"status":false,"message":"Rejected ${API_KEY}"}` }],
    async (client) => {
      await assert.rejects(client.validate(), (error) => {
        assert.equal(error.code, "provider_error");
        assert.match(error.message, /\[REDACTED\]/);
        assert.equal(error.message.includes(API_KEY), false);
        return true;
      });
    },
  );

  // Go's `fallbackMessage`: an absent message renders as "(no message)".
  await withClient([{ body: `{"status":false}` }], async (client) => {
    await assert.rejects(client.validate(), (error) => {
      assert.match(error.message, /\(no message\)/);
      return true;
    });
  });
});

// TestInstaWPListsSites
test("listSites sends the paging query and synthesizes one environment", async () => {
  await withClient(
    [
      {
        body: `{"status":true,"message":"Sites fetched Successfully.","data":[{"id":1405177,"name":"site-one","url":"https://site-one.instawp.xyz","is_expired":0,"is_suspended":0,"is_reserved":1,"wp_version":"6.7.1"}],"meta":{"current_page":1,"last_page":1}}`,
      },
    ],
    async (client, state) => {
      const sites = await client.listSites({
        companyId: "1179",
        includeEnvironments: true,
      });
      assert.deepEqual(requestLines(state), [
        "GET /sites?page=1&per_page=100&team_id=1179",
      ]);
      assert.equal(sites.length, 1);
      assert.equal(sites[0].id, "1405177");
      assert.equal(sites[0].name, "site-one");
      assert.equal(sites[0].displayName, "site-one");
      assert.equal(sites[0].status, "active");
      assert.equal(sites[0].primaryDomain, "site-one.instawp.xyz");
      assert.equal(sites[0].environments.length, 1);

      const environment = sites[0].environments[0];
      assert.equal(environment.id, "1405177");
      assert.equal(environment.name, "site");
      assert.equal(environment.displayName, "site-one");
      assert.equal(environment.isBlocked, false);
      assert.equal(environment.isPremium, false);
      assert.equal(environment.wordpressVersion, "6.7.1");
      assert.equal(environment.primaryDomain, "site-one.instawp.xyz");

      assert.deepEqual(serializeHostingSite(sites[0]), {
        id: "1405177",
        name: "site-one",
        display_name: "site-one",
        status: "active",
        primary_domain: "site-one.instawp.xyz",
        environments: [
          {
            id: "1405177",
            name: "site",
            display_name: "site-one",
            is_blocked: false,
            is_premium: false,
            wordpress_version: "6.7.1",
            primary_domain: "site-one.instawp.xyz",
          },
        ],
      });
    },
  );
});

// TestInstaWPListsSitesAcrossPages
test("listSites follows the meta pagination", async () => {
  await withClient(
    [
      {
        body: `{"status":true,"message":"Sites fetched Successfully.","data":[{"id":1,"name":"site-one","url":"https://site-one.instawp.xyz"}],"meta":{"current_page":1,"last_page":2}}`,
      },
      {
        body: `{"status":true,"message":"Sites fetched Successfully.","data":[{"id":2,"name":"site-two","url":"https://site-two.instawp.xyz"}],"meta":{"current_page":2,"last_page":2}}`,
      },
    ],
    async (client, state) => {
      const sites = await client.listSites();
      assert.deepEqual(requestLines(state), [
        "GET /sites?page=1&per_page=100",
        "GET /sites?page=2&per_page=100",
      ]);
      assert.deepEqual(
        sites.map((site) => site.id),
        ["1", "2"],
      );
      // includeEnvironments defaults to false, exactly like Go's `includeEnvs`.
      assert.equal(sites[0].environments, undefined);
    },
  );
});

test("listSites stops on an empty page, a missing meta, and a stuck page counter", async () => {
  // Empty data terminates the loop even when more pages are advertised.
  await withClient(
    [
      {
        body: `{"status":true,"data":[],"meta":{"current_page":1,"last_page":9}}`,
      },
    ],
    async (client, state) => {
      assert.deepEqual(await client.listSites(), []);
      assert.equal(state.requests.length, 1);
    },
  );

  // No meta at all: one page only.
  await withClient(
    [{ body: `{"status":true,"data":[{"id":"abc","name":"only"}]}` }],
    async (client, state) => {
      const sites = await client.listSites();
      assert.deepEqual(
        sites.map((site) => site.id),
        ["abc"],
      );
      assert.equal(state.requests.length, 1);
    },
  );

  // Deviation from Go: a `current_page` that never advances would loop forever
  // there; HQ stops after the page that failed to move.
  await withClient(
    [
      {
        body: `{"status":true,"data":[{"id":1}],"meta":{"current_page":0,"last_page":5}}`,
      },
    ],
    async (client, state) => {
      assert.equal((await client.listSites()).length, 1);
      assert.equal(state.requests.length, 1);
    },
  );
});

test("listSites reports an envelope failure and omits team_id when unset", async () => {
  await withClient(
    [{ body: `{"status":false,"message":"Team not found."}` }],
    async (client, state) => {
      await assert.rejects(client.listSites(), (error) => {
        assert.equal(error.code, "provider_error");
        assert.match(error.message, /Team not found\./);
        assert.equal(error.details.provider, "instawp");
        assert.equal(error.details.path, "/sites");
        return true;
      });
      assert.deepEqual(requestLines(state), ["GET /sites?page=1&per_page=100"]);
    },
  );
});

test("listSites falls back to the profile team id", async () => {
  await withClient(
    [
      {
        body: `{"status":true,"data":[],"meta":{"current_page":1,"last_page":1}}`,
      },
    ],
    async (client, state) => {
      await client.listSites();
      assert.deepEqual(requestLines(state), [
        "GET /sites?page=1&per_page=100&team_id=team-7",
      ]);
    },
    { companyId: "team-7" },
  );
});

// TestInstaWPGetSiteSynthesizesEnvironment
test("getSite always includes the synthetic environment", async () => {
  await withClient(
    [
      {
        body: `{"status":true,"message":"Ok","data":{"id":1405177,"name":"site-one","url":"https://site-one.instawp.xyz","is_expired":0,"is_suspended":0,"wp_version":"6.7.1"}}`,
      },
    ],
    async (client, state) => {
      const site = await client.getSite("1405177");
      assert.deepEqual(requestLines(state), ["GET /sites/1405177"]);
      assert.equal(site.environments.length, 1);
      assert.equal(site.environments[0].id, "1405177");
    },
  );
});

test("getSite escapes the site id and surfaces an envelope failure", async () => {
  await withClient(
    [{ body: `{"status":false,"message":"Site not found."}` }],
    async (client, state) => {
      await assert.rejects(client.getSite("a/b c"), (error) => {
        assert.equal(error.code, "provider_error");
        assert.match(error.message, /Site not found\./);
        return true;
      });
      assert.deepEqual(requestLines(state), ["GET /sites/a%2Fb%20c"]);
    },
  );
});

// TestInstaWPPollsOperationStatus
test("operationStatus maps the InstaWP task status endpoint", async () => {
  await withClient(
    [
      {
        body: `{"status":true,"message":"Task details retrived.","data":{"status":"completed"}}`,
      },
    ],
    async (client, state) => {
      const status = await client.operationStatus("task-1");
      assert.deepEqual(requestLines(state), ["GET /tasks/task-1/status"]);
      assert.equal(status.provider, "instawp");
      assert.equal(status.operationId, "task-1");
      assert.equal(status.status, 200);
      assert.equal(status.done, true);
      assert.equal(status.failed, false);
      assert.equal(status.message, "Task details retrived.");
      assert.deepEqual(serializeOperationStatus(status), {
        provider: "instawp",
        operation_id: "task-1",
        status: 200,
        done: true,
        failed: false,
        message: "Task details retrived.",
        raw: {
          status: true,
          message: "Task details retrived.",
          data: { status: "completed" },
        },
      });
    },
  );
});

test("operationStatus classifies in-flight, failed and unreported tasks", async () => {
  const cases = [
    // task status, envelope status, expected failed, expected done
    ["progress", true, false, false],
    ["pending", true, false, false],
    ["queued", true, false, false],
    ["PROGRESS", true, false, false],
    ["", true, false, false],
    ["failed", true, true, true],
    ["error occurred", true, true, true],
    ["completed", true, false, true],
    // A false envelope status fails the operation whatever the task says.
    ["completed", false, true, true],
  ];
  for (const [taskStatus, envelopeOk, failed, done] of cases) {
    await withClient(
      [
        {
          body: JSON.stringify({
            status: envelopeOk,
            data: { status: taskStatus },
          }),
        },
      ],
      async (client) => {
        const status = await client.operationStatus("task-x");
        assert.equal(status.done, done, `done for ${taskStatus}/${envelopeOk}`);
        assert.equal(
          status.failed,
          failed,
          `failed for ${taskStatus}/${envelopeOk}`,
        );
      },
    );
  }
});

test("operationStatus redacts secrets carried in a task payload", async () => {
  await withClient(
    [
      {
        body: `{"status":true,"data":{"status":"completed","wp_password":"wp-secret","s_hash":"hash-secret"}}`,
      },
    ],
    async (client) => {
      const status = await client.operationStatus("task-1");
      const raw = JSON.stringify(serializeOperationStatus(status));
      assert.equal(raw.includes("wp-secret"), false);
      assert.equal(raw.includes("hash-secret"), false);
      assert.equal(status.raw.data.wp_password, "redacted");
      assert.equal(status.raw.data.s_hash, "redacted");
      assert.equal(status.raw.data.status, "completed");
    },
  );
});

// TestInstaWPCreateSite
test("create-site posts to /sites and never leaks the site credentials", async () => {
  await withClient(
    [
      {
        body: `{"status":true,"message":"Completed with ${API_KEY}","echoed":"${API_KEY}","data":{"id":1405177,"wp_url":"https://demo-site.instawp.xyz","wp_username":"admin","wp_password":"wp-secret","s_hash":"hash-secret"}}`,
      },
    ],
    async (client, state) => {
      const result = await client.action({
        kind: "create-site",
        mode: "wordpress",
        body: { site_name: "demo-site" },
      });
      assert.deepEqual(requestLines(state), ["POST /sites"]);
      assert.equal(state.requests[0].contentType, "application/json");
      assert.deepEqual(JSON.parse(state.requests[0].body), {
        site_name: "demo-site",
      });

      assert.equal(result.provider, "instawp");
      assert.equal(result.action, "sites.create");
      assert.equal(result.status, 200);

      const serialized = JSON.stringify(serializeActionResult(result));
      for (const leaked of ["wp-secret", "hash-secret", API_KEY])
        assert.equal(serialized.includes(leaked), false);
      assert.equal(result.raw.data.wp_password, "redacted");
      assert.equal(result.raw.data.s_hash, "redacted");
      // Non-secret fields survive the walk untouched.
      assert.equal(result.raw.data.wp_username, "admin");
      assert.equal(result.raw.data.id, 1405177);
    },
  );
});

// TestInstaWPCreateSiteFromTemplateExtractsTask
test("create-site with a template posts to /sites/template and extracts the task", async () => {
  await withClient(
    [
      {
        body: `{"status":true,"message":"Site installation in progress","data":{"task_id":"task-1","wp_password":"wp-secret"}}`,
      },
    ],
    async (client, state) => {
      const result = await client.action({
        kind: "create-site",
        mode: "clone",
        body: { template_slug: "blueprint", site_name: "demo" },
      });
      assert.deepEqual(requestLines(state), ["POST /sites/template"]);
      assert.deepEqual(JSON.parse(state.requests[0].body), {
        template_slug: "blueprint",
        site_name: "demo",
      });
      assert.equal(result.action, "sites.clone");
      assert.equal(result.operationId, "task-1");
      assert.equal(
        JSON.stringify(serializeActionResult(result)).includes("wp-secret"),
        false,
      );
    },
  );
});

// TestInstaWPRunCommandUsesCommandID
test("run-wp-cli with a command_id uses the execute-command endpoint", async () => {
  await withClient(
    [
      {
        body: `{"status":true,"message":"Command queued.","data":{"task_id":"task-2"}}`,
      },
    ],
    async (client, state) => {
      const result = await client.action({
        kind: "run-wp-cli",
        envId: "1405177",
        body: { command_id: 42 },
      });
      assert.deepEqual(requestLines(state), [
        "POST /sites/1405177/execute-command",
      ]);
      assert.deepEqual(JSON.parse(state.requests[0].body), { command_id: 42 });
      assert.equal(result.action, "wp-cli.run");
      assert.equal(result.operationId, "task-2");
    },
  );
});

// TestInstaWPRunCommandUsesRunCmdForWpCommand
test("run-wp-cli with a wp_command wraps it into the run-cmd batch shape", async () => {
  await withClient(
    [
      {
        body: `{"status":true,"message":"Command executed.","data":[{"output":"Success: installed"}]}`,
      },
    ],
    async (client, state) => {
      const result = await client.action({
        kind: "run-wp-cli",
        envId: "1405177",
        body: { wp_command: "wp plugin install novamira --activate" },
      });
      assert.deepEqual(requestLines(state), ["POST /sites/1405177/run-cmd"]);
      // The `wp` binary token is kept: InstaWP's run-cmd takes the full command.
      assert.deepEqual(JSON.parse(state.requests[0].body), {
        commands: ["wp plugin install novamira --activate"],
        timeout_seconds: 30,
      });
      assert.equal(result.action, "wp-cli.run");
      assert.equal(result.message, "Command executed.");
      assert.equal(result.operationId, undefined);
      assert.deepEqual(result.raw.data, [{ output: "Success: installed" }]);
    },
  );
});

// TestInstaWPUnsupportedActionsReturnExplicitError
test("an unmapped action reports provider_unsupported without any request", async () => {
  await withClient([], async (client, state) => {
    await assert.rejects(
      client.action({
        kind: "clear-cache",
        cache: "site",
        body: { environment_id: "1405177" },
      }),
      (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.equal(error.details.provider, "instawp");
        assert.equal(error.details.action, "clear-cache");
        assert.match(error.message, /^InstaWP does not support /);
        return true;
      },
    );
    assert.deepEqual(state.requests, []);
  });
});

/* -------------------------------------------------------------------------- */
/* HQ-specific contract                                                       */
/* -------------------------------------------------------------------------- */

test("read exposes the capability list and refuses every other read request", async () => {
  await withClient([], async (client, state) => {
    const capabilities = await client.read({ kind: "capabilities" });
    assert.deepEqual(
      capabilities,
      EXPECTED_CAPABILITIES.map(([name, supported, notes]) =>
        notes === undefined ? { name, supported } : { name, supported, notes },
      ),
    );

    for (const kind of READ_REQUEST_KINDS) {
      if (kind === "capabilities") continue;
      await assert.rejects(client.read({ kind }), (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.equal(error.details.provider, "instawp");
        assert.equal(error.details.request, kind);
        return true;
      });
    }
    assert.deepEqual(state.requests, []);
  });
});

test("every action outside the three mapped ones reports provider_unsupported", async () => {
  await withClient([], async (client, state) => {
    for (const kind of ACTION_REQUEST_KINDS) {
      if (SUPPORTED_ACTIONS.includes(kind)) continue;
      await assert.rejects(client.action({ kind }), (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.equal(error.details.action, kind);
        return true;
      });
    }
    assert.deepEqual(state.requests, []);
  });
});

test("an unknown request kind is an internal error, not a silent success", async () => {
  await withClient([], async (client) => {
    // The `default` arm is unreachable by construction — a value can only get
    // there by crossing a runtime boundary untyped — so `assertNever` raises
    // synchronously rather than resolving to a rejected promise.
    assert.throws(() => client.read({ kind: "not-a-read" }), {
      code: "internal_error",
    });
    assert.throws(() => client.action({ kind: "not-an-action" }), {
      code: "internal_error",
    });
  });
});

test("listEnvironments requires a site id and returns the synthetic environment", async () => {
  await withClient([], async (client, state) => {
    await assert.rejects(client.listEnvironments(""), {
      code: "usage_error",
    });
    assert.deepEqual(state.requests, []);
  });

  await withClient(
    [
      {
        body: `{"status":true,"data":{"id":"1405177","name":"site-one","url":"https://site-one.instawp.xyz","wp_version":"6.7.1"}}`,
      },
    ],
    async (client, state) => {
      const environments = await client.listEnvironments("1405177");
      assert.deepEqual(requestLines(state), ["GET /sites/1405177"]);
      assert.deepEqual(environments, [
        {
          id: "1405177",
          name: "site",
          displayName: "site-one",
          isBlocked: false,
          isPremium: false,
          wordpressVersion: "6.7.1",
          primaryDomain: "site-one.instawp.xyz",
        },
      ]);
    },
  );
});

test("site normalization follows the Go accessor order", async () => {
  const fixtures = [
    // label wins the display name; domain wins the primary domain.
    [
      {
        id: 7,
        name: "raw-name",
        label: "Pretty Label",
        domain: "custom.example",
        url: "https://ignored.instawp.xyz",
      },
      {
        id: "7",
        name: "raw-name",
        displayName: "Pretty Label",
        status: "active",
        primaryDomain: "custom.example",
      },
    ],
    // sub_domain is the name and the domain of last resort.
    [
      { id: "9", sub_domain: "fallback.instawp.xyz", url: "" },
      {
        id: "9",
        name: "fallback.instawp.xyz",
        displayName: "9",
        status: "active",
        primaryDomain: "fallback.instawp.xyz",
      },
    ],
    // A bare host in `url` has no parseable host, exactly as in Go.
    [
      { id: "10", url: "site-ten.instawp.xyz" },
      {
        id: "10",
        name: "10",
        displayName: "site-ten.instawp.xyz",
        status: "active",
      },
    ],
    // deleted_at outranks the suspension and expiry flags.
    [
      {
        id: "11",
        deleted_at: "2026-01-01T00:00:00Z",
        is_suspended: 1,
        is_expired: true,
      },
      { id: "11", name: "11", displayName: "11", status: "deleted" },
    ],
    // `is_suspended` accepts the int, string and bool spellings InstaWP uses.
    [
      { id: "12", is_suspended: "yes" },
      { id: "12", name: "12", displayName: "12", status: "suspended" },
    ],
    [
      { id: "13", is_expired: "1" },
      { id: "13", name: "13", displayName: "13", status: "expired" },
    ],
    [
      { id: "14", is_expired: false, is_suspended: "no" },
      { id: "14", name: "14", displayName: "14", status: "active" },
    ],
    // A missing id degrades to the empty string rather than throwing.
    [
      { name: "nameless" },
      { id: "", name: "nameless", displayName: "nameless", status: "active" },
    ],
  ];

  for (const [payload, expected] of fixtures) {
    await withClient(
      [{ body: JSON.stringify({ status: true, data: payload }) }],
      async (client) => {
        const site = await client.getSite(String(payload.id ?? ""));
        const { environments, ...rest } = site;
        assert.deepEqual(rest, expected, JSON.stringify(payload));
        assert.equal(environments.length, 1);
        assert.equal(environments[0].id, expected.id);
        assert.equal(environments[0].displayName, expected.displayName);
      },
    );
  }
});

test("the synthetic environment blocks on expiry or suspension", async () => {
  await withClient(
    [{ body: `{"status":true,"data":{"id":"1","is_expired":1}}` }],
    async (client) => {
      const site = await client.getSite("1");
      assert.equal(site.environments[0].isBlocked, true);
      assert.equal(site.environments[0].isPremium, false);
      assert.equal("wordpressVersion" in site.environments[0], false);
    },
  );
});

test("create-site promotes display_name and site_title to site_name", async () => {
  await withClient(
    [{ body: `{"status":true,"data":{"id":1}}` }],
    async (client, state) => {
      await client.action({
        kind: "create-site",
        mode: "plain",
        body: { display_name: "From Display" },
      });
      assert.deepEqual(JSON.parse(state.requests[0].body), {
        display_name: "From Display",
        site_name: "From Display",
      });
    },
  );

  await withClient(
    [{ body: `{"status":true,"data":{"id":1}}` }],
    async (client, state) => {
      const result = await client.action({
        kind: "create-site",
        mode: "plain",
        body: { site_title: "From Title" },
      });
      assert.equal(result.action, "sites.create-plain");
      assert.deepEqual(JSON.parse(state.requests[0].body), {
        site_title: "From Title",
        site_name: "From Title",
      });
    },
  );

  // An explicit site_name is never overwritten.
  await withClient(
    [{ body: `{"status":true,"data":{"id":1}}` }],
    async (client, state) => {
      await client.action({
        kind: "create-site",
        mode: "wordpress",
        body: { site_name: "explicit", display_name: "ignored" },
      });
      assert.equal(JSON.parse(state.requests[0].body).site_name, "explicit");
    },
  );
});

test("create-site refuses a clone without a template and a create without a name", async () => {
  await withClient([], async (client, state) => {
    await assert.rejects(
      client.action({ kind: "create-site", mode: "clone", body: {} }),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.match(error.message, /template_slug/);
        return true;
      },
    );
    await assert.rejects(
      client.action({ kind: "create-site", mode: "wordpress", body: {} }),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.match(error.message, /site_name/);
        return true;
      },
    );
    await assert.rejects(
      client.action({ kind: "create-site", mode: "wordpress", body: [1, 2] }),
      { code: "usage_error" },
    );
    assert.deepEqual(state.requests, []);
  });

  // A template_slug makes even the wordpress mode a clone.
  await withClient(
    [{ body: `{"status":true,"data":{"id":1}}` }],
    async (client, state) => {
      const result = await client.action({
        kind: "create-site",
        mode: "wordpress",
        body: { template_slug: "blueprint" },
      });
      assert.deepEqual(requestLines(state), ["POST /sites/template"]);
      assert.equal(result.action, "sites.clone");
    },
  );
});

test("run-wp-cli honours command, commands and the timeout default", async () => {
  await withClient(
    [{ body: `{"status":true,"data":{}}` }],
    async (client, state) => {
      await client.action({
        kind: "run-wp-cli",
        envId: "site-1",
        body: { command: "wp core version", timeout_seconds: 120 },
      });
      assert.deepEqual(requestLines(state), ["POST /sites/site-1/run-cmd"]);
      assert.deepEqual(JSON.parse(state.requests[0].body), {
        commands: ["wp core version"],
        timeout_seconds: 120,
      });
    },
  );

  await withClient(
    [{ body: `{"status":true,"data":{}}` }],
    async (client, state) => {
      await client.action({
        kind: "run-wp-cli",
        envId: "site-1",
        body: { commands: ["wp plugin list", "wp theme list"] },
      });
      assert.deepEqual(JSON.parse(state.requests[0].body), {
        commands: ["wp plugin list", "wp theme list"],
        timeout_seconds: 30,
      });
    },
  );

  await withClient([], async (client, state) => {
    await assert.rejects(
      client.action({ kind: "run-wp-cli", envId: "site-1", body: {} }),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.match(
          error.message,
          /wp_command, command, commands, or command_id/,
        );
        return true;
      },
    );
    // Deviation from Go's `fmt.Sprint`: a non-scalar command is refused rather
    // than stringified into a shell command.
    await assert.rejects(
      client.action({
        kind: "run-wp-cli",
        envId: "site-1",
        body: { wp_command: { not: "a string" } },
      }),
      { code: "usage_error" },
    );
    assert.deepEqual(state.requests, []);
  });
});

test("the action result prefers the HTTP status and finds a numeric cloud task id", async () => {
  await withClient(
    [
      {
        status: 201,
        body: `{"status":true,"message":"Queued","data":{"cloud_task_id":99}}`,
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "create-site",
        mode: "wordpress",
        body: { site_name: "demo" },
      });
      // InstaWP's `status` is a boolean, so the HTTP status is authoritative.
      assert.equal(result.status, 201);
      assert.equal(result.operationId, "99");
    },
  );

  // A top-level operation_id outranks a nested task id.
  await withClient(
    [
      {
        body: `{"status":true,"operation_id":"op-1","data":{"task_id":"task-9"}}`,
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "create-site",
        mode: "wordpress",
        body: { site_name: "demo" },
      });
      assert.equal(result.operationId, "op-1");
    },
  );

  // An empty body parses to null, exactly like Go's `parseJSONBody`.
  await withClient([{ body: "" }], async (client) => {
    const result = await client.action({
      kind: "create-site",
      mode: "wordpress",
      body: { site_name: "demo" },
    });
    assert.equal(result.raw, null);
    assert.equal(result.message, undefined);
    assert.equal(result.operationId, undefined);
    assert.deepEqual(serializeActionResult(result), {
      provider: "instawp",
      action: "sites.create",
      status: 200,
      raw: null,
    });
  });
});

test("an HTTP failure maps onto the shared taxonomy and never echoes the key", async () => {
  const cases = [
    [401, "credential_invalid"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "provider_error"],
  ];
  for (const [status, code] of cases) {
    await withClient(
      [{ status, body: `{"message":"nope ${API_KEY}"}` }],
      async (client, state, diagnostics) => {
        await assert.rejects(client.getSite("1"), (error) => {
          assert.equal(error.code, code);
          assert.equal(error.message.includes(API_KEY), false);
          assert.equal(JSON.stringify(error.details).includes(API_KEY), false);
          return true;
        });
        assert.equal(JSON.stringify(diagnostics).includes(API_KEY), false);
        assert.equal(state.requests[0].authorization, AUTHORIZATION);
      },
    );
  }
});

test("a non-JSON body is a provider_error rather than a crash", async () => {
  await withClient([{ body: "<html>nope</html>" }], async (client) => {
    await assert.rejects(client.validate(), { code: "provider_error" });
  });
});
