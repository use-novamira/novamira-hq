// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dashboard server: the loopback bind guard, the mutation token, the
 * DNS-rebinding guard, the route table, the status map, the static-asset
 * allowlist and the app shell.
 *
 * Fully offline. Almost every case drives `server.dispatch`, which takes a plain
 * request object and returns a plain response — no socket, no `node:http`
 * objects at all. Exactly three cases bind, all on `127.0.0.1:0`, to prove the
 * wire adapter and the listener agree with `dispatch`: the header/status case,
 * the `Host` guard (which `fetch` cannot exercise, because `Host` is a forbidden
 * header name in undici), and the oversized-body case.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderHtml } from "../dist/web/html.js";

import { defaultFileSecurity } from "../dist/config/file-security.js";
import { atomicWriteFile } from "../dist/config/atomic-write.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import { CliError } from "../dist/errors.js";
import {
  createDashboardServer,
  createRouteTable,
  parseListenAddress,
  requireLoopbackHost,
  DEFERRED_ROUTES,
  PAGE_ROUTE_PATHS,
  SECURITY_HEADERS,
  STATIC_ASSETS,
} from "../dist/web/index.js";

const TOKEN = "a".repeat(64);
const TOKEN_HEADER = "x-novamira-dashboard-token";

test("app acknowledgement and MCP connection use token-protected POST routes", async () => {
  let accepted = false;
  let checks = 0;
  const connected = [];
  const { server, cleanup } = await fixture({
    appAcknowledgement: {
      accepted: async () => accepted,
      accept: async () => {
        accepted = true;
      },
    },
    mcpConnection: {
      configuration: () => ({
        claude: '{"mcpServers":{"novamira-hq":{"command":"test","args":[]}}}',
        chatgpt: "",
        launch: { command: "test", args: [] },
      }),
      connect: async (client) => {
        connected.push(client);
        return "configured";
      },
      verify: async () => {
        checks++;
        return { toolCount: 11 };
      },
    },
  });
  try {
    const initial = await server.dispatch(request("/configure-ai"));
    assert.match(renderHtml(initial.body), /Before you start/);
    for (const path of [
      "/_dashboard/app/acknowledge",
      "/_dashboard/mcp/verify",
      "/_dashboard/mcp/connect?client=chatgpt",
      "/_dashboard/pushes/plan",
      "/_dashboard/pushes/apply",
    ]) {
      assert.equal((await server.dispatch(request(path))).status, 405);
      assert.equal(
        (await server.dispatch(request(path, { method: "POST" }))).status,
        403,
      );
    }
    assert.equal(accepted, false);
    assert.equal(checks, 0);
    const patches = [];
    const stream = {
      patchSignals() {},
      patchElements(value) {
        patches.push(value);
      },
      close() {},
    };
    const acknowledgement = await server.dispatch(
      request("/_dashboard/app/acknowledge", {
        method: "POST",
        headers: { [TOKEN_HEADER]: TOKEN },
      }),
    );
    assert.equal(acknowledgement.kind, "sse");
    await acknowledgement.run(stream);
    assert.equal(accepted, true);
    assert.ok(patches.length >= 3);
    assert.match(patches.map(renderHtml).join(""), /<h1>Add site<\/h1>/);
    assert.doesNotMatch(
      patches.map(renderHtml).join(""),
      /You can now configure hosting/,
    );
    const page = await server.dispatch(request("/configure-ai"));
    assert.doesNotMatch(renderHtml(page.body), /Before you start/);
    assert.match(renderHtml(page.body), /Claude Desktop/);
    const review = await server.dispatch(request("/?review-notice=1"));
    assert.match(renderHtml(review.body), /Before you start/);
    assert.doesNotMatch(
      renderHtml(review.body),
      /I understand and accept|\/_dashboard\/app\/acknowledge/,
    );
    assert.equal(accepted, true);
    const bundle = await server.dispatch(request("/mcp/novamira-hq.mcpb"));
    assert.equal(bundle.kind, "asset");
    assert.equal(bundle.status, 200);
    assert.equal(bundle.cacheControl, "no-store");
    assert.equal(
      bundle.contentDisposition,
      'attachment; filename="novamira-hq.mcpb"',
    );
    assert.equal(Buffer.from(bundle.body).readUInt32LE(0), 0x04034b50);
    const check = await server.dispatch(
      request("/_dashboard/mcp/verify", {
        method: "POST",
        headers: { [TOKEN_HEADER]: TOKEN },
      }),
    );
    await check.run(stream);
    assert.equal(checks, 1);
    const connect = await server.dispatch(
      request("/_dashboard/mcp/connect?client=chatgpt", {
        method: "POST",
        headers: { [TOKEN_HEADER]: TOKEN },
      }),
    );
    await connect.run(stream);
    assert.deepEqual(connected, ["chatgpt"]);
    assert.equal(checks, 2);
  } finally {
    await cleanup();
  }
});

const CONFIG = {
  version: 1,
  hostingProfiles: {
    main: {
      provider: "kinsta",
      credential: { type: "env", name: "KINSTA_API_KEY" },
      companyId: "company-1",
    },
  },
  pushes: {},
};

async function fixture(overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-web-"));
  const environment = { NOVAMIRA_HQ_HOME: home };
  const paths = platformPaths(environment, process.platform, home);
  const security = defaultFileSecurity();
  await atomicWriteFile(paths.configFile, JSON.stringify(CONFIG), security);
  const store = new ConfigStore(
    paths.configFile,
    new ProfileLockManager(paths.stateDir, security),
    security,
  );
  const server = createDashboardServer({
    version: "0.1.0-test",
    paths,
    store,
    hosting: {},
    history: { list: async () => [] },
    credentials: async () => {
      throw new Error("the dashboard must not build a credential store here");
    },
    environment,
    fetch: async () => {
      throw new Error("the dashboard must not make an outbound request here");
    },
    now: () => 1_700_000_000_000,
    randomToken: () => TOKEN,
    integration: {
      connectionStates: async () => {
        throw new Error("this suite renders no connection state");
      },
      connect: async () => {
        throw new Error("this suite runs no site CLI");
      },
    },
    doctor: async () => {
      throw new Error("this suite runs no doctor report");
    },
    updates: {
      check: async () => {
        throw new Error("this suite must not reach a package registry");
      },
      install: async () => {
        throw new Error("this suite must not run a package manager");
      },
    },
    ...overrides,
  });
  return {
    server,
    paths,
    home,
    cleanup: async () => {
      await server.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function request(path, options = {}) {
  const target = new URL(path, "http://127.0.0.1:8787");
  return {
    method: options.method ?? "GET",
    path: decodeURIComponent(target.pathname),
    query: target.searchParams,
    headers: { host: "127.0.0.1:8787", ...options.headers },
    // Required rather than optional, so a looping handler cannot forget it; a
    // synthesized request passes a signal that simply never aborts.
    signal: new AbortController().signal,
    body: async () => options.body ?? "",
  };
}

/**
 * The minimum `RouteContext`. 6b moved the token onto the context and added the
 * service record, so building a table means supplying both.
 */
function routeContext(overrides = {}) {
  return {
    loadConfigView: async () => ({
      profiles: [],
      pushes: [],
      version: "0.0.0-test",
      configFile: "/dev/null",
    }),
    token: TOKEN,
    now: () => 1_700_000_000_000,
    providers: {
      upsert: async () => ({ name: "x" }),
      remove: async () => ({ name: "x" }),
      validate: async () => ({}),
      recordChecked: () => undefined,
      clearChecked: () => undefined,
      lastChecked: () => null,
    },
    sites: {
      list: async () => ({
        profile: "__all__",
        includeEnvs: true,
        cached: false,
        storedAt: null,
        expiresAt: null,
        groups: [],
        connections: null,
      }),
      warm: () => undefined,
      refreshWarm: async () => undefined,
      invalidate: () => undefined,
      envResolver:
        () =>
        ({ envId }) => ({ name: envId, domain: "" }),
      resolveSite: () => undefined,
    },
    pushes: { upsert: async () => "x", remove: async () => "x" },
    integration: {
      connectionStates: async () => {
        throw new Error("this suite renders no connection state");
      },
      connect: async () => {
        throw new Error("this suite runs no site CLI");
      },
    },
    doctor: async () => {
      throw new Error("this suite runs no doctor report");
    },
    updates: {
      check: async () => {
        throw new Error("this suite must not reach a package registry");
      },
      install: async () => {
        throw new Error("this suite must not run a package manager");
      },
    },
    environment: {},
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 1-4: the loopback guard                                                    */
/* -------------------------------------------------------------------------- */

test("requireLoopbackHost accepts every loopback spelling", () => {
  for (const host of [
    "",
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "127.1.2.3",
    "127.255.255.254",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:127.9.9.9",
  ])
    assert.doesNotThrow(() => requireLoopbackHost(host), host);
});

test("requireLoopbackHost rejects everything else with usage_error", () => {
  for (const host of [
    "0.0.0.0",
    "::",
    "192.168.1.10",
    "10.0.0.1",
    "example.com",
    "localhost.evil.example",
    "127.0.0.1.nip.io",
    "::ffff:192.168.1.1",
    "fe80::1",
  ]) {
    assert.throws(
      () => requireLoopbackHost(host),
      (error) => {
        assert.ok(error instanceof CliError, host);
        assert.equal(error.code, "usage_error", host);
        assert.equal(error.details.flag, "--listen", host);
        return true;
      },
      host,
    );
  }
});

test("parseListenAddress accepts the five shapes and rejects the rest", () => {
  assert.deepEqual(parseListenAddress(":8787"), {
    hostname: "127.0.0.1",
    port: 8787,
  });
  assert.deepEqual(parseListenAddress("8787"), {
    hostname: "127.0.0.1",
    port: 8787,
  });
  assert.deepEqual(parseListenAddress("127.0.0.1:8787"), {
    hostname: "127.0.0.1",
    port: 8787,
  });
  assert.deepEqual(parseListenAddress("localhost:8787"), {
    hostname: "localhost",
    port: 8787,
  });
  assert.deepEqual(parseListenAddress("[::1]:8787"), {
    hostname: "::1",
    port: 8787,
  });
  assert.deepEqual(parseListenAddress("127.0.0.1:0"), {
    hostname: "127.0.0.1",
    port: 0,
  });
  for (const value of ["127.0.0.1", ":abc", ":70000", "", "   "])
    assert.throws(() => parseListenAddress(value), CliError, value);
});

test("a --listen naming a routable host parses, then fails the loopback guard", () => {
  // The two halves are separate on purpose: parsing does not decide policy, and
  // the guard is a pure value check that runs again on the bound address.
  for (const value of ["example.com:8787", "0.0.0.0:8787", "[::]:8787"]) {
    const address = parseListenAddress(value);
    assert.equal(address.port, 8787, value);
    assert.throws(
      () => requireLoopbackHost(address.hostname),
      (error) => {
        assert.equal(error.code, "usage_error", value);
        assert.equal(error.details.flag, "--listen", value);
        return true;
      },
      value,
    );
  }
});

test("a non-loopback bind is refused before any socket is opened", async () => {
  const { server, cleanup } = await fixture();
  try {
    await assert.rejects(
      () => server.listen({ hostname: "0.0.0.0", port: 0 }),
      (error) => error.code === "usage_error",
    );
    // Nothing to close: `listen` threw before `createServer`.
    await server.closed();
  } finally {
    await cleanup();
  }
});

test("binding 127.0.0.1:0 reports the real port", async () => {
  const { server, cleanup } = await fixture();
  try {
    const bound = await server.listen({ hostname: "127.0.0.1", port: 0 });
    assert.equal(bound.hostname, "127.0.0.1");
    assert.ok(bound.port > 0);
    assert.equal(bound.url, `http://127.0.0.1:${bound.port}`);
  } finally {
    await cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* 6-10: pages, headers, 404 and 405                                          */
/* -------------------------------------------------------------------------- */

test("every routed page renders the shell with all three patch targets", async () => {
  const { server, cleanup } = await fixture();
  try {
    for (const path of PAGE_ROUTE_PATHS) {
      const response = await server.dispatch(request(path));
      assert.equal(response.kind, "html", path);
      assert.equal(response.status, 200, path);
      const markup = response.body.markup;
      for (const id of ['id="main"', 'id="nav"', 'id="toast"'])
        assert.ok(markup.includes(id), `${path} ${id}`);
      assert.ok(markup.startsWith("<!doctype html>"), path);
    }
  } finally {
    await cleanup();
  }
});

test("#main carries its per-page class, and renderPlaceholderBody is gone", async () => {
  const { server, cleanup } = await fixture();
  try {
    for (const [path, page] of [
      ["/", "sites"],
      ["/hosting-accounts", "providers"],
      ["/sites", "sites"],
      ["/how-to-use", "how-to-use"],
      ["/push", "pushes"],
      ["/push/new", "push-new"],
      ["/novamira-setup", "novamira-setup"],
      ["/diagnostics", "diagnostics"],
      ["/settings", "settings"],
    ]) {
      const markup = (await server.dispatch(request(path))).body.markup;
      assert.ok(
        markup.includes(
          `<main id="main" tabindex="-1" class="main main-${page}">`,
        ),
        `${path} is missing its per-page #main class`,
      );
    }
  } finally {
    await cleanup();
  }
  // 6a's empty body is deleted, not deprecated: `views/pages.ts` replaced it.
  const layout = await import("../dist/web/views/layout.js");
  assert.equal(layout.renderPlaceholderBody, undefined);
  const barrel = await import("../dist/web/index.js");
  assert.equal(barrel.renderPlaceholderBody, undefined);
});

test("the nav active link follows the two page aliases", async () => {
  const { server, cleanup } = await fixture();
  const activeHref = (markup) =>
    /<a class="nav-link active" href="([^"]+)"/.exec(markup)?.[1];
  try {
    for (const [path, href] of [
      ["/", "/sites"],
      ["/hosting-accounts", "/hosting-accounts"],
      ["/sites", "/sites"],
      ["/how-to-use", undefined],
      ["/novamira-setup", "/sites"],
      ["/push", "/push"],
      ["/push/new", "/push"],
      ["/diagnostics", "/diagnostics"],
      ["/settings", "/settings"],
    ]) {
      const response = await server.dispatch(request(path));
      assert.equal(activeHref(response.body.markup), href, path);
    }
  } finally {
    await cleanup();
  }
});

test("How to use it explains the complete handoff and links to both entry paths", async () => {
  const { server, cleanup } = await fixture();
  try {
    const response = await server.dispatch(request("/how-to-use"));
    const markup = response.body.markup;
    for (const want of [
      "<h1>How to use it</h1>",
      ">Prepare a site</strong>",
      ">Connect it</strong>",
      ">Ask your AI</strong>",
      'href="/hosting-accounts?new=host"',
      'href="/sites?new=cli"',
      "AI agent you selected during Novamira HQ installation",
      "does not contain an AI chat",
      "Configure a different AI agent",
      "installer already configures the agent you select",
      "installed Novamira HQ directly with npm",
      "npx skills add &quot;$(npm root --global)/@novamira/hq&quot; --skill novamira-hq --global",
      "Sites already connected on this computer do not need to be connected again.",
    ])
      assert.ok(markup.includes(want), want);
  } finally {
    await cleanup();
  }
});

test("the sidebar Connect menu puts an existing site before a hosting account", async () => {
  const { server, cleanup } = await fixture();
  try {
    const markup = (await server.dispatch(request("/hosting-accounts"))).body
      .markup;
    // Go rendered a <button>, which is inline-block; HQ renders an <a>, which is
    // inline. The pair that keeps it a full-width 38px button is this element
    // plus `.new-button`'s `display` in app.css, so pin both together.
    assert.ok(markup.includes(">Add site</button>"));
    assert.ok(
      markup.indexOf("<strong>Manually</strong>") <
        markup.indexOf("<strong>From a hosting account</strong>"),
    );
    assert.ok(markup.includes('class="new-pop"'));
    assert.ok(markup.includes('href="/hosting-accounts?new=host"'));
    assert.ok(markup.includes('href="/sites?new=cli"'));
    assert.ok(markup.includes("Connect an existing Novamira site"));
    assert.ok(markup.includes("Connect an account and discover its sites"));
    assert.ok(
      markup.indexOf('href="/sites?new=cli"') <
        markup.indexOf('href="/hosting-accounts?new=host"'),
    );
    const css = await readFile(
      new URL("../src/web/static/app.css", import.meta.url),
      "utf8",
    );
    const rule = /\.new-button \{([^}]*)\}/.exec(css)?.[1] ?? "";
    assert.match(rule, /display:\s*(flex|inline-flex|block|grid)/);
    assert.match(rule, /width:\s*100%/);
  } finally {
    await cleanup();
  }
});

test("the dashboard uses flat gold accents without yellow glows", async () => {
  const css = await readFile(
    new URL("../src/web/static/app.css", import.meta.url),
    "utf8",
  );
  assert.ok(!css.includes("gold-glow"));
  assert.ok(!css.includes("gold-focus"));
  assert.ok(!css.includes("rgba(248, 202, 80"));
  assert.match(
    css,
    /\.onboard-card\.feat \{[^}]*border-color:\s*var\(--border-strong\)/s,
  );
  assert.match(css, /input:focus,[^}]*outline:\s*2px solid var\(--gold\)/s);
});

test("every response carries all five security headers over the wire", async () => {
  const { server, cleanup } = await fixture();
  try {
    const bound = await server.listen({ hostname: "127.0.0.1", port: 0 });
    for (const path of ["/", "/assets/app.css", "/nope"]) {
      const response = await fetch(bound.url + path);
      for (const [name, value] of Object.entries(SECURITY_HEADERS))
        assert.equal(response.headers.get(name), value, `${path} ${name}`);
      await response.arrayBuffer();
    }
    const page = await fetch(bound.url + "/");
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(page.headers.get("cache-control"), "no-store");
    await page.text();
  } finally {
    await cleanup();
  }
});

test("an unknown path is a not_found failure envelope", async () => {
  const { server, cleanup } = await fixture();
  try {
    const response = await server.dispatch(request("/nope"));
    assert.equal(response.kind, "json");
    assert.equal(response.status, 404);
    assert.equal(response.envelope.ok, false);
    assert.equal(response.envelope.error.code, "not_found");
  } finally {
    await cleanup();
  }
});

test("a wrong method on a known path is 405 with Allow", async () => {
  const { server, cleanup } = await fixture();
  try {
    const response = await server.dispatch(
      request("/hosting-accounts", { method: "POST" }),
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.Allow, "GET");
    assert.equal(response.envelope.error.code, "usage_error");
    const asset = await server.dispatch(
      request("/assets/app.css", { method: "POST" }),
    );
    assert.equal(asset.status, 405);
    assert.equal(asset.headers.Allow, "GET, HEAD");
  } finally {
    await cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* 11-14: the mutation token                                                  */
/* -------------------------------------------------------------------------- */

const TEST_ROUTES = [
  {
    method: "GET",
    path: "/_dashboard/test/guarded",
    auth: "token",
    handler: () => ({
      kind: "text",
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: "reached",
    }),
  },
  // The three below are deliberately NOT under `/_dashboard/`: that prefix may
  // not carry a public row, and `createRouteTable` refuses to build a table that
  // contains one.
  {
    method: "POST",
    path: "/test/echo",
    auth: "public",
    handler: async (incoming) => ({
      kind: "text",
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: String((await incoming.body()).length),
    }),
  },
  {
    method: "GET",
    path: "/test/cli-error",
    auth: "public",
    handler: () => {
      throw new CliError("rate_limited", "Slow down.");
    },
  },
  {
    method: "GET",
    path: "/test/plain-error",
    auth: "public",
    handler: () => {
      throw new Error("a stack trace that must not reach the browser");
    },
  },
];

test("a public route under /_dashboard/ is refused when the table is built", () => {
  for (const auth of ["public", undefined]) {
    assert.throws(
      () =>
        createRouteTable(
          routeContext({
            extraRoutes: [
              {
                method: "POST",
                path: "/_dashboard/test/public",
                auth,
                handler: () => ({ kind: "text", status: 200, body: "" }),
              },
            ],
          }),
        ),
      (error) => {
        assert.equal(error.code, "internal_error");
        assert.match(error.message, /must require the mutation token/);
        return true;
      },
      String(auth),
    );
  }
  // Every shipped row keeps the invariant: nothing under the prefix is public.
  const table = createRouteTable(routeContext());
  for (const route of table)
    if (route.path.startsWith("/_dashboard/"))
      assert.equal(route.auth, "token", route.path);
  // And the three credential-touching rows 6b-1 shipped are in it.
  for (const path of [
    "/_dashboard/providers/save",
    "/_dashboard/providers/remove",
    "/_dashboard/providers/validate",
  ])
    assert.ok(
      table.some((route) => route.path === path && route.auth === "token"),
      path,
    );
});

test("a token route refuses a missing, short, long or wrong token", async () => {
  const { server, cleanup } = await fixture({ extraRoutes: TEST_ROUTES });
  try {
    for (const headers of [
      {},
      { [TOKEN_HEADER]: "" },
      { [TOKEN_HEADER]: "b".repeat(63) },
      { [TOKEN_HEADER]: "b".repeat(65) },
      { [TOKEN_HEADER]: "b".repeat(64) },
    ]) {
      const response = await server.dispatch(
        request("/_dashboard/test/guarded", { headers }),
      );
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(response.envelope.error.code, "usage_error");
      assert.equal(
        response.envelope.error.message,
        "The dashboard mutation token is missing or invalid.",
      );
      assert.equal(response.envelope.error.details, undefined);
      const body = JSON.stringify(response.envelope);
      assert.ok(!body.includes(TOKEN));
      assert.ok(!body.includes("b".repeat(63)));
    }
  } finally {
    await cleanup();
  }
});

test("the correct token reaches the handler", async () => {
  const { server, cleanup } = await fixture({ extraRoutes: TEST_ROUTES });
  try {
    assert.equal(server.token, TOKEN);
    const response = await server.dispatch(
      request("/_dashboard/test/guarded", {
        headers: { [TOKEN_HEADER]: TOKEN },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.body, "reached");
  } finally {
    await cleanup();
  }
});

test("the token appears exactly once, inside the root data-signals", async () => {
  const { server, cleanup } = await fixture();
  try {
    const bound = await server.listen({ hostname: "127.0.0.1", port: 0 });
    const response = await fetch(bound.url + "/");
    for (const [, value] of response.headers)
      assert.ok(!value.includes(TOKEN), "no header may carry the token");
    const markup = await response.text();
    assert.equal(markup.split(TOKEN).length - 1, 1);
    const signals = /<div class="shell" data-signals="([^"]*)"/.exec(markup);
    assert.ok(signals, "the shell carries the root signal object");
    const parsed = JSON.parse(unescapeHtml(signals[1]));
    assert.equal(parsed.token, server.token);
    assert.deepEqual(Object.keys(parsed).sort(), [
      "cliSites",
      "diagnostics",
      "hostingTools",
      "proForm",
      "providerForm",
      "pushForm",
      "restoreForm",
      "setup",
      "sites",
      "token",
      "updates",
    ]);
    assert.ok(!("siteForm" in parsed));
  } finally {
    await cleanup();
  }
});

function unescapeHtml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/* -------------------------------------------------------------------------- */
/* 15-17: the DNS-rebinding guard                                             */
/* -------------------------------------------------------------------------- */

function rawRequest(port, path, headers) {
  return new Promise((resolve, reject) => {
    const message = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    message.on("error", reject);
    message.end();
  });
}

test("the Host guard refuses a rebound name and a mismatched port", async () => {
  const { server, cleanup } = await fixture();
  try {
    const bound = await server.listen({ hostname: "127.0.0.1", port: 0 });
    for (const host of [
      "evil.example",
      `evil.example:${bound.port}`,
      "127.0.0.1:1",
      "localhost.evil.example",
      // An omitted host component is a malformed authority, not the "omitted
      // means loopback" spelling a *listen address* is allowed.
      `:${bound.port}`,
      // Malformed suffixes on a bracketed authority must be refused outright,
      // never read as a bracketed loopback host that ignores the bogus suffix.
      "[::1]garbage",
      "[::1]:",
      "[::1]:abc",
      `[::1]:${bound.port}junk`,
      "[::1]:8787:8787",
    ]) {
      const response = await rawRequest(bound.port, "/", { host });
      assert.equal(response.status, 403, host);
      assert.equal(
        JSON.parse(response.body).error.message,
        "The dashboard accepts loopback requests only.",
      );
    }
    for (const host of [
      `127.0.0.1:${bound.port}`,
      `localhost:${bound.port}`,
      `[::1]:${bound.port}`,
      "localhost",
    ]) {
      const response = await rawRequest(bound.port, "/", { host });
      assert.equal(response.status, 200, host);
    }
  } finally {
    await cleanup();
  }
});

test("the Origin and Sec-Fetch-Site guards", async () => {
  const { server, cleanup } = await fixture();
  try {
    const bound = await server.listen({ hostname: "127.0.0.1", port: 0 });
    const forbidden = [
      { origin: "http://evil.example" },
      { origin: `https://127.0.0.1:${bound.port}` },
      { origin: `http://127.0.0.1:${bound.port + 1}` },
      // The opaque origin: what a sandboxed iframe, a `data:`/`srcdoc`
      // document, or a request that followed a cross-origin redirect sends. It
      // is a present Origin that is not a loopback origin, so it is refused —
      // the guard has no exemption for it.
      { origin: "null" },
      { origin: "file://" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ];
    for (const headers of forbidden) {
      const response = await rawRequest(bound.port, "/", {
        host: `127.0.0.1:${bound.port}`,
        ...headers,
      });
      assert.equal(response.status, 403, JSON.stringify(headers));
    }
    const allowed = [
      {},
      { origin: `http://127.0.0.1:${bound.port}` },
      { origin: `http://localhost:${bound.port}` },
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" },
    ];
    for (const headers of allowed) {
      const response = await rawRequest(bound.port, "/", {
        host: `127.0.0.1:${bound.port}`,
        ...headers,
      });
      assert.equal(response.status, 200, JSON.stringify(headers));
    }
  } finally {
    await cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* 18-23: static assets                                                       */
/* -------------------------------------------------------------------------- */

test("all assets, including legal notices, are served with their content types", async () => {
  const { server, cleanup } = await fixture();
  try {
    for (const asset of STATIC_ASSETS) {
      const response = await server.dispatch(request(`/assets/${asset.path}`));
      assert.equal(response.kind, "asset", asset.path);
      assert.equal(response.status, 200, asset.path);
      assert.equal(response.contentType, asset.contentType, asset.path);
      assert.equal(response.cacheControl, "no-cache", asset.path);
      assert.ok(response.contentLength > 0, asset.path);
      const source = await readFile(
        new URL(
          `../${asset.path === "third-party-notices.txt" ? "dist" : "src"}/web/static/${asset.path}`,
          import.meta.url,
        ),
      );
      assert.deepEqual(Buffer.from(response.body), source, asset.path);
      assert.equal(
        response.etag,
        `"${createHash("sha256").update(source).digest("hex").slice(0, 16)}"`,
        asset.path,
      );
    }
  } finally {
    await cleanup();
  }
});

test("HEAD keeps the headers and drops the body; If-None-Match is 304", async () => {
  const { server, cleanup } = await fixture();
  try {
    const get = await server.dispatch(request("/assets/app.css"));
    const head = await server.dispatch(
      request("/assets/app.css", { method: "HEAD" }),
    );
    assert.equal(head.status, 200);
    assert.equal(head.contentType, get.contentType);
    assert.equal(head.contentLength, get.contentLength);
    assert.equal(head.etag, get.etag);
    assert.equal(head.body, undefined);

    const cached = await server.dispatch(
      request("/assets/app.css", { headers: { "if-none-match": get.etag } }),
    );
    assert.equal(cached.status, 304);
    assert.equal(cached.body, undefined);
  } finally {
    await cleanup();
  }
});

test("traversal and off-allowlist asset paths are 404", async () => {
  const { server, cleanup } = await fixture();
  try {
    for (const path of [
      "/assets/../../package.json",
      "/assets/..%2f..%2fpackage.json",
      "/assets/%2e%2e/%2e%2e/package.json",
      "/assets/fonts/../../../etc/passwd",
      "/assets/app.css%00.png",
      "/assets/nope.js",
      "/assets/",
      "/assets/.hidden",
    ]) {
      const response = await server.dispatch(request(path));
      assert.equal(response.kind, "json", path);
      assert.equal(response.status, 404, path);
      assert.equal(response.envelope.error.code, "not_found", path);
    }
  } finally {
    await cleanup();
  }
});

test("the build ships all assets under dist/web/static", async () => {
  for (const asset of STATIC_ASSETS) {
    const bytes = await readFile(
      new URL(`../dist/web/static/${asset.path}`, import.meta.url),
    );
    assert.ok(bytes.byteLength > 0, asset.path);
  }
  for (const licence of [
    "fonts/montserrat-OFL.txt",
    "fonts/jetbrains-mono-OFL.txt",
  ]) {
    const text = await readFile(
      new URL(`../dist/web/static/${licence}`, import.meta.url),
      "utf8",
    );
    assert.match(text, /SIL OPEN FONT LICENSE/i, licence);
  }
});

/* -------------------------------------------------------------------------- */
/* 24-28: deferred routes, error mapping, the body cap, adapter agreement     */
/* -------------------------------------------------------------------------- */

/**
 * The shipped route surface, exactly as `docs/v1-contract.md`'s Routes table
 * lists it. This is what replaces the old "the deferred rows still 404"
 * assertion now that `DEFERRED_ROUTES` is empty: with nothing left to defer, the
 * property worth pinning is the *positive* one — the dashboard answers these
 * paths and no others — so a route added without a contract row, a test row and
 * a reviewer's attention fails here.
 */
const SHIPPED_ROUTES = [
  "GET /_dashboard/agents/status",
  "GET /_dashboard/agents/install",
  "GET /_dashboard/agents/repair",
  "GET /_dashboard/agents/remove",
  "GET /_dashboard/agents/cancel",
  "GET /_dashboard/agents/dismiss",
  "GET /_dashboard/agents/command",
  "GET /novamira-pro",
  "GET /_dashboard/pro/save",
  "GET /_dashboard/pro/remove",
  "GET /_dashboard/pro/plan",
  "GET /_dashboard/pro/install",
  "GET /about",
  "GET /",
  "GET /_dashboard/connect",
  "GET /_dashboard/pushes/remove",
  "GET /_dashboard/pushes/save",
  "GET /_dashboard/diagnostics/capabilities",
  "GET /_dashboard/diagnostics/doctor",
  "GET /_dashboard/providers/remove",
  "GET /_dashboard/providers/save",
  "GET /_dashboard/providers/validate",
  "GET /_dashboard/setup/jobs/",
  "GET /_dashboard/setup/start",
  // The site-profile panel's four rows. They manage the *site CLI's* profiles
  // by spawning `novamira`; they are not Go's deleted `/_dashboard/sites/save`
  // and `/_dashboard/sites/remove`, which wrote HQ's own site profiles and are
  // asserted absent by the test below.
  "GET /_dashboard/site-profiles/connect",
  "GET /_dashboard/site-profiles/logout",
  "GET /_dashboard/site-profiles/rename",
  "GET /_dashboard/site-profiles/remove",
  "GET /_dashboard/sites",
  "GET /_dashboard/updates/check",
  "GET /_dashboard/updates/install",
  "GET /assets/",
  "GET /push",
  "GET /backup-restore",
  "GET /backup-create",
  "GET /hosting-tools",
  "GET /_dashboard/hosting-tools/run",
  "GET /_dashboard/backups/create-plan",
  "GET /_dashboard/backups/catalog",
  "GET /_dashboard/backups/plan",
  "GET /_dashboard/backups/apply",
  "GET /_dashboard/backups/status",
  "GET /push/new",
  "GET /diagnostics",
  "GET /history",
  "GET /hosting-activity",
  "GET /hosting-accounts",
  "GET /configure-ai",
  "GET /mcp",
  "GET /mcp/novamira-hq.mcpb",
  "GET /how-to-use",
  "GET /novamira-setup",
  "GET /providers",
  "GET /settings",
  "GET /updates",
  "GET /sites",
  "HEAD /assets/",
  "GET /_dashboard/mcp/verify",
  "GET /_dashboard/mcp/connect",
  "GET /_dashboard/app/acknowledge",
  "GET /_dashboard/pushes/plan",
  "GET /_dashboard/pushes/apply",
  "GET /_dashboard/pushes/status",
];

test("the deferred-route list is empty and the shipped surface is frozen", async () => {
  // 6b-1 moved the three provider rows out of this list and into the table,
  // 6b-2 `/sites` and `/connect`, 6b-3 the two setup rows, 7-1 the two
  // diagnostics rows with `src/doctor/`, and 7-2 the last two with
  // `src/update/`. Nothing is deferred any more.
  assert.deepEqual([...DEFERRED_ROUTES], []);

  const { server, cleanup } = await fixture();
  try {
    // The mechanism still works: a row declared here would have to 404.
    for (const entry of DEFERRED_ROUTES) {
      const response = await server.dispatch(
        request(entry.path, { headers: { [TOKEN_HEADER]: TOKEN } }),
      );
      assert.equal(response.status, 404, entry.path);
    }

    // Every path in the table answers something other than 404, and no path
    // outside it does. `matchRoute` collapses the method, so the surface is
    // listed as `GET <path>` plus the one `HEAD` row; a POST-only path is
    // reachable by GET as a 405, which is the distinction being pinned.
    const table = createRouteTable(routeContext());
    const surface = [
      ...new Set(table.map((route) => `${"GET"} ${route.path}`)),
      "HEAD /assets/",
    ].sort();
    assert.deepEqual(surface, [...SHIPPED_ROUTES].sort());
    for (const route of table)
      if (route.path.startsWith("/_dashboard/"))
        assert.equal(route.auth, "token", route.path);

    // The two rows 7-2 moved down are answered now, not 404.
    for (const [method, path] of [
      ["GET", "/_dashboard/updates/check"],
      ["POST", "/_dashboard/updates/install"],
    ]) {
      const response = await server.dispatch(
        request(path, { method, headers: { [TOKEN_HEADER]: TOKEN } }),
      );
      assert.notEqual(response.status, 404, path);
    }
    // ...and the wrong method on the install route is a 405, not a 404.
    const wrongMethod = await server.dispatch(
      request("/_dashboard/updates/install", {
        headers: { [TOKEN_HEADER]: TOKEN },
      }),
    );
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.Allow, "POST");
  } finally {
    await cleanup();
  }
});

test("the deleted site-profile routes exist nowhere", async () => {
  assert.equal(
    DEFERRED_ROUTES.some((entry) =>
      entry.path.startsWith("/_dashboard/sites/"),
    ),
    false,
  );
  const { server, cleanup } = await fixture();
  try {
    for (const path of ["/_dashboard/sites/save", "/_dashboard/sites/remove"]) {
      const get = await server.dispatch(request(path));
      assert.equal(get.status, 404, path);
      const post = await server.dispatch(request(path, { method: "POST" }));
      assert.equal(post.status, 404, path);
    }
    const page = await server.dispatch(request("/sites"));
    assert.ok(!page.body.markup.includes("/_dashboard/sites/save"));
    assert.ok(!page.body.markup.includes("/_dashboard/sites/remove"));
  } finally {
    await cleanup();
  }
});

test("the setup-jobs prefix row matches both shapes and is token-guarded", async () => {
  // The only prefix row outside `/assets/`. It has to match a job id and a job
  // id plus `/stream`, and it has to be guarded like every other
  // `/_dashboard/*` row — `createRouteTable` refuses to build a table where it
  // is not, so the guard below is the check that the row *exists* at all.
  const { server, cleanup } = await fixture();
  try {
    for (const path of [
      "/_dashboard/setup/jobs/abc123",
      "/_dashboard/setup/jobs/abc123/stream",
    ]) {
      const anonymous = await server.dispatch(request(path));
      assert.equal(anonymous.status, 403, path);
      assert.equal(anonymous.envelope.error.code, "usage_error");
      // With the token the row is reached, and the unknown id is its own 404 —
      // a *routing* 404 would answer "No such dashboard route." instead.
      const authorized = await server.dispatch(
        request(path, { headers: { [TOKEN_HEADER]: TOKEN } }),
      );
      assert.equal(authorized.status, 404, path);
      assert.equal(authorized.envelope.error.message, "Setup job not found.");
    }
    // A POST to the prefix is a 405 with an Allow header, not a 404: the path
    // exists, the method does not.
    const wrongMethod = await server.dispatch(
      request("/_dashboard/setup/jobs/abc123", {
        method: "POST",
        headers: { [TOKEN_HEADER]: TOKEN },
      }),
    );
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.Allow, "GET");
  } finally {
    await cleanup();
  }
});

test("a handler failure becomes the mapped status and a redacted envelope", async () => {
  const { server, cleanup } = await fixture({ extraRoutes: TEST_ROUTES });
  try {
    const mapped = await server.dispatch(request("/test/cli-error"));
    assert.equal(mapped.status, 429);
    assert.equal(mapped.envelope.error.code, "rate_limited");

    const plain = await server.dispatch(request("/test/plain-error"));
    assert.equal(plain.status, 500);
    assert.equal(plain.envelope.error.code, "internal_error");
    const body = JSON.stringify(plain.envelope);
    assert.ok(!body.includes("stack trace"));
    assert.ok(!body.includes("web-server-contract"));
  } finally {
    await cleanup();
  }
});

test("a request body over 256 KiB is 413", async () => {
  const { server, cleanup } = await fixture({ extraRoutes: TEST_ROUTES });
  try {
    const bound = await server.listen({ hostname: "127.0.0.1", port: 0 });
    const small = await fetch(bound.url + "/test/echo", {
      method: "POST",
      body: "x".repeat(1024),
    });
    assert.equal(small.status, 200);
    assert.equal(await small.text(), "1024");

    // The refusal must be *observable*: the server stops reading at the cap but
    // does not tear the connection down before the response is written, so the
    // client sees the documented status rather than a connection reset.
    const big = await fetch(bound.url + "/test/echo", {
      method: "POST",
      body: "x".repeat(300_000),
    });
    assert.equal(big.status, 413);
    assert.equal(JSON.parse(await big.text()).error.code, "usage_error");
  } finally {
    await cleanup();
  }
});

test("dispatch and the node:http adapter agree", async () => {
  const { server, cleanup } = await fixture();
  try {
    const bound = await server.listen({ hostname: "127.0.0.1", port: 0 });
    for (const path of ["/settings", "/nope"]) {
      // The server is bound, so the Host guard now checks the port too; the
      // hand-built request must name the same one the socket did.
      const direct = await server.dispatch(
        request(path, { headers: { host: `127.0.0.1:${bound.port}` } }),
      );
      const overWire = await fetch(bound.url + path);
      assert.equal(overWire.status, direct.status, path);
      const text = await overWire.text();
      if (direct.kind === "html") assert.equal(text, direct.body.markup, path);
      else assert.equal(text, `${JSON.stringify(direct.envelope)}\n`, path);
    }
  } finally {
    await cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* A POST route that reads its body still gets to stream                      */
/* -------------------------------------------------------------------------- */

/** `rawRequest`, with a method and a body. */
function rawPost(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body, "utf8");
    const message = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    message.on("error", reject);
    message.end(payload);
  });
}

test("a POST SSE route that reads its body still writes its patches", async () => {
  // The regression this pins: on Node an `IncomingMessage` emits `close` as soon
  // as its body has been *consumed*, and the Datastar SDK ends the response from
  // `req.on("close")`. Every `POST` under `/_dashboard/` reads its signals from
  // the body, so every one of them answered a real mutation with `200` and zero
  // bytes — the browser saw no patch and no toast while the write went through.
  //
  // Only a real socket shows it. A synthesized `DashboardRequest` resolves
  // `body()` from a string and never emits anything, which is why the whole
  // suite was green while the dashboard's every button did nothing.
  const { server, cleanup } = await fixture();
  try {
    const bound = await server.listen({ hostname: "127.0.0.1", port: 0 });
    const response = await rawPost(
      bound.port,
      "/_dashboard/pushes/save",
      { host: `127.0.0.1:${bound.port}`, [TOKEN_HEADER]: TOKEN },
      JSON.stringify({ pushForm: {} }),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /text\/event-stream/);
    assert.notEqual(response.body, "", "the SSE stream wrote nothing");
    assert.match(response.body, /^event: datastar-patch-elements$/m);
  } finally {
    await cleanup();
  }
});
