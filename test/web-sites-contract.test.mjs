// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Sites page, `GET /_dashboard/sites` and `POST /_dashboard/connect`.
 *
 * This is the port of the sites half of Go's `server_test.go` — the toolbar, the
 * segmented control, the cache, the group and row markup, the deploy hint and
 * the setup CTA — re-expressed over the four-state `ConnectionResult` that
 * replaced Go's `site_profiles` hostname match, plus the assertions Go could not
 * make because it had no Connect action: that a failing login puts **no child
 * output** anywhere in the response, and that a malformed URL spawns nothing.
 *
 * Fully offline and socket-free. Pages come from `server.dispatch`; SSE handlers
 * run against a recording stream. Provider calls go to an injected registry
 * whose clients are local fakes and which counts its own invocations, so the
 * cache assertions are made against call counts rather than against timing, and
 * no provider endpoint is contacted, ever. The site CLI is an injected object;
 * nothing here spawns a process.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import { SITE_CLI_INSTALL_HINT } from "../dist/connection-state.js";
import { CliError } from "../dist/errors.js";
import { createHostingClientFactory } from "../dist/hosting/factory.js";
import {
  createDashboardServer,
  createSitesService,
} from "../dist/web/index.js";

const TOKEN = "f".repeat(64);
const TOKEN_HEADER = "x-novamira-dashboard-token";
const NOW = 1_700_000_000_000;

const roots = [];
const servers = [];

test.after(async () => {
  for (const server of servers) await server.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Inventory fixtures                                                         */
/* -------------------------------------------------------------------------- */

function env(id, overrides = {}) {
  return {
    id,
    name: id,
    displayName: `${id} display`,
    isBlocked: false,
    isPremium: false,
    primaryDomain: `${id}.example.com`,
    ...overrides,
  };
}

/** Kinsta: deploy-push capable and Novamira-setup capable. */
const KINSTA_SITES = [
  {
    id: "s1",
    name: "s1",
    displayName: "Multi Site",
    status: "live",
    primaryDomain: "multi.example.com",
    environments: [env("env-a"), env("env-b", { isPremium: true })],
  },
  {
    id: "s2",
    name: "s2",
    displayName: "Single Site",
    status: "live",
    primaryDomain: "single.example.com",
    environments: [env("env-c")],
  },
  {
    id: "s3",
    name: "",
    displayName: "",
    status: "live",
    environments: [],
  },
];

/** Pantheon: neither deploy-push nor Novamira setup. */
const PANTHEON_SITES = [
  {
    id: "p1",
    name: "p1",
    displayName: "Plain Multi",
    status: "live",
    primaryDomain: "plain.example.com",
    environments: [env("env-p1"), env("env-p2")],
  },
];

const CONFIG = {
  version: 1,
  hostingProfiles: {
    prod: {
      provider: "kinsta",
      credential: { type: "env", name: "KINSTA_API_KEY" },
    },
    plain: {
      provider: "pantheon",
      credential: { type: "env", name: "PANTHEON_MACHINE_TOKEN" },
    },
  },
  deployPaths: {},
};

const ENVIRONMENT = {
  KINSTA_API_KEY: "kinsta-fake",
  PANTHEON_MACHINE_TOKEN: "pantheon-fake",
};

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A snapshot builder: every environment id in `states` gets that state, and
 * anything not listed is left out of the map (which the view reads as
 * `not_configured`).
 */
function snapshotFor(queries, states, cliAvailable = true, profiles = {}) {
  const byKey = new Map();
  for (const query of queries) {
    const envId = query.key.split("/").at(-1);
    const state = states[envId];
    if (state !== undefined)
      byKey.set(query.key, { state, profiles: profiles[envId] ?? [] });
  }
  return { byKey, checkedAt: NOW, cliAvailable };
}

async function fixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-sites-"));
  roots.push(home);
  const environment = { NOVAMIRA_HQ_HOME: home, ...ENVIRONMENT };
  const paths = platformPaths(environment, process.platform, home);
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(paths.configFile, JSON.stringify(options.config ?? CONFIG));
  const security = defaultFileSecurity();
  const store = new ConfigStore(
    paths.configFile,
    new ProfileLockManager(paths.stateDir, security),
    security,
  );

  const listCalls = [];
  const client = (provider, sites) => ({
    provider,
    validate: async () => ({
      provider,
      status: "ok",
      companyId: null,
      credential: "env:X",
    }),
    listSites: async (listOptions) => {
      listCalls.push({ provider, options: listOptions });
      if (options.listError !== undefined && provider === "pantheon")
        throw options.listError;
      return sites;
    },
    getSite: async () => ({}),
    listEnvironments: async () => [],
    read: async () => [],
    action: async () => ({}),
    operationStatus: async () => ({}),
  });

  const hosting = createHostingClientFactory({
    store,
    registry: {
      kinsta: () => client("kinsta", options.kinstaSites ?? KINSTA_SITES),
      pantheon: () =>
        client("pantheon", options.pantheonSites ?? PANTHEON_SITES),
    },
    env: environment,
  });

  const connectCalls = [];
  const server = createDashboardServer({
    version: "0.1.0-test",
    paths,
    store,
    hosting,
    credentials: async () => {
      throw new Error("the sites suite must not build a credential store");
    },
    environment,
    fetch: async () => {
      throw new Error("the sites suite must not make an outbound request");
    },
    now: options.now ?? (() => NOW),
    randomToken: () => TOKEN,
    integration: {
      connectionStates: async (queries) =>
        snapshotFor(
          queries,
          options.states ?? {},
          options.cliAvailable ?? true,
          options.profiles ?? {},
        ),
      connect: async (siteUrl) => {
        connectCalls.push(siteUrl);
        return options.connect ?? { kind: "connected" };
      },
    },
    doctor: async () => {
      throw new Error("the sites suite runs no doctor report");
    },
    updates: {
      check: async () => {
        throw new Error("the sites suite must not reach a package registry");
      },
      install: async () => {
        throw new Error("the sites suite must not run a package manager");
      },
    },
  });
  servers.push(server);
  return { server, store, listCalls, connectCalls };
}

function request(path, options = {}) {
  const target = new URL(path, "http://127.0.0.1:8787");
  return {
    method: options.method ?? "GET",
    path: decodeURIComponent(target.pathname),
    query: target.searchParams,
    headers: { host: "127.0.0.1:8787", ...options.headers },
    signal: new AbortController().signal,
    body: async () => options.body ?? "",
  };
}

function authorized(path, options = {}) {
  return request(path, {
    ...options,
    headers: { [TOKEN_HEADER]: TOKEN, ...options.headers },
  });
}

async function page(server, path) {
  const response = await server.dispatch(request(path));
  assert.equal(response.kind, "html", path);
  assert.equal(response.status, 200, path);
  return response.body.markup;
}

function fakeSseStream() {
  const elements = [];
  const signals = [];
  return {
    elements,
    signals,
    get body() {
      return [
        ...signals.map((value) => JSON.stringify(value)),
        ...elements.map((patch) => patch.markup),
      ].join("\n");
    },
    get order() {
      return elements.map((patch) => `${patch.selectorId}/${patch.mode}`);
    },
    find(selectorId) {
      return elements.find((patch) => patch.selectorId === selectorId);
    },
    stream: {
      patchElements(markup, target) {
        elements.push({
          selectorId: target.selectorId,
          mode: target.mode,
          markup: markup.markup,
        });
      },
      patchSignals(values) {
        signals.push(values);
      },
      close() {},
    },
  };
}

async function sse(server, incoming) {
  const response = await server.dispatch(incoming);
  if (response.kind !== "sse") return { response, recorder: undefined };
  const recorder = fakeSseStream();
  await response.run(recorder.stream);
  return { response, recorder };
}

/** The one route this suite drives for inventory. */
function sitesRequest(query = "include_envs=true") {
  return authorized(`/_dashboard/sites?${query}`);
}

/* -------------------------------------------------------------------------- */
/* 1-3: the static page                                                       */
/* -------------------------------------------------------------------------- */

test("1: the toolbar loads on mount, reloads on change and refreshes on submit", async () => {
  const { server } = await fixture();
  const markup = await page(server, "/sites");
  for (const want of [
    'data-indicator="sites.loading"',
    "/_dashboard/sites?include_envs=true",
    // The `&` is hardened to `&` inside the JS string literal, so an
    // already-escaped attribute value cannot be re-interpreted after the HTML
    // parser un-escapes it.
    "include_envs=true\\u0026refresh=true",
    "data-init=",
    "data-on:change=",
    "data-on:submit__prevent=",
    ">Refresh</button>",
    "Last updated: never",
    'class="spinner"',
    '<option value="__all__">All hosting</option>',
    ">prod (Kinsta)<",
  ])
    assert.ok(markup.includes(want), want);
  // Go's controls that HQ deletes: the site form, the manual load button and
  // the environments checkbox (the toolbar always asks for environments).
  for (const gone of [
    "Load Sites",
    "Include environments",
    "Add a site",
    "site-name",
    "siteForm",
  ])
    assert.ok(!markup.includes(gone), gone);
  assert.ok(!/application[-_ ]?password/i.test(markup));
});

test("2: the segmented control carries the five frozen data-sf-* values", async () => {
  const { server } = await fixture();
  const markup = await page(server, "/sites");
  for (const want of [
    'data-sf-status="all"',
    'data-sf-status="with"',
    'data-sf-status="without"',
    'data-sf-count="with"',
    'data-sf-count="without"',
    "With Novamira ",
    "To install ",
    'class="seg-btn on"',
  ])
    assert.ok(markup.includes(want), want);
});

test("3: the search box is the selector sites-filter.js delegates on", async () => {
  const { server } = await fixture();
  const markup = await page(server, "/sites");
  assert.ok(markup.includes('data-bind="sites.search"'));
  assert.ok(markup.includes('<div id="sites-result" class="results empty">'));
  assert.ok(markup.includes('<div id="sites-status" class="sites-status">'));
});

/* -------------------------------------------------------------------------- */
/* 4-5: the route and its cache                                               */
/* -------------------------------------------------------------------------- */

test("4: the route patches status inner, result outer and toast outer, in that order", async () => {
  const { server } = await fixture();
  const { recorder } = await sse(server, sitesRequest());
  assert.deepEqual(recorder.order, [
    "sites-status/inner",
    "sites-result/outer",
    "toast/outer",
  ]);
  const result = recorder.find("sites-result").markup;
  assert.ok(result.startsWith('<div id="sites-result" class="results">'));
  // The inner fragment must not carry a wrapper of its own.
  const status = recorder.find("sites-status").markup;
  assert.ok(!status.includes('id="sites-status"'));
  assert.ok(status.includes(`data-checked-at="${String(NOW)}"`));
  assert.ok(status.includes("Last updated: "));
  // Never the page.
  assert.equal(recorder.find("main"), undefined);
  assert.equal(recorder.find("nav"), undefined);
});

test("5: a second call inside the TTL makes no provider request; refresh does", async () => {
  const { server, listCalls } = await fixture();
  await sse(server, sitesRequest());
  const first = listCalls.length;
  assert.equal(first, 2, "one listSites per hosting profile");
  assert.deepEqual(listCalls[0].options, { includeEnvironments: true });

  await sse(server, sitesRequest());
  assert.equal(listCalls.length, first, "the warm cache answered");

  await sse(server, sitesRequest("include_envs=true&refresh=true"));
  assert.equal(listCalls.length, first * 2, "refresh re-listed every profile");

  // A different cache key is a different entry, not a hit.
  await sse(server, sitesRequest("include_envs=false"));
  assert.equal(listCalls.length, first * 2 + 2);
});

test("5b: a provider mutation invalidates the cache, as Go's clearSitesCacheLocked did", async () => {
  const { server, listCalls } = await fixture();
  await sse(server, sitesRequest());
  const before = listCalls.length;
  await sse(
    server,
    authorized("/_dashboard/providers/remove?profile=plain", {
      method: "POST",
      body: JSON.stringify({ token: TOKEN }),
    }),
  );
  await sse(server, sitesRequest());
  assert.ok(listCalls.length > before, "the cache was dropped");
});

test("5c: a failing provider is a group error, and the others still render", async () => {
  const { server } = await fixture({
    listError: new CliError("network_error", "Pantheon said no.", {
      details: { host: "api.pantheon.invalid" },
    }),
  });
  const { recorder } = await sse(server, sitesRequest());
  const result = recorder.find("sites-result").markup;
  assert.ok(result.includes('<span class="pill danger">error</span>'));
  assert.ok(result.includes("Pantheon said no."));
  assert.ok(result.includes("Multi Site"), "the healthy group still rendered");
  // A group failure is not a page failure: the toast stays quiet.
  assert.ok(!recorder.find("toast").markup.includes("show"));
  // The message reaches the page; `details` never does, because a notice
  // bypasses `failureEnvelope`'s redaction entirely.
  assert.ok(!recorder.body.includes("api.pantheon.invalid"));
});

/* -------------------------------------------------------------------------- */
/* 6-10: the result markup                                                    */
/* -------------------------------------------------------------------------- */

async function resultMarkup(options = {}) {
  const { server, ...rest } = await fixture(options);
  const { recorder } = await sse(server, sitesRequest());
  return { markup: recorder.find("sites-result").markup, server, ...rest };
}

test("6: a multi-environment site is a <details>, a single one a plain row", async () => {
  const { markup } = await resultMarkup();
  assert.ok(markup.includes('<details class="site-row site-row-multi"'));
  assert.ok(markup.includes('<span class="pill">2 environments</span>'));
  assert.equal(markup.split('class="env-subrow"').length - 1, 4);
  assert.ok(markup.includes('<span class="env-tag">premium</span>'));
  assert.ok(markup.includes(">env-a display<"));
  // The single-environment site is a div with no summary of its own.
  assert.ok(markup.includes('<div class="site-row" data-nm-state='));
  assert.ok(markup.includes(">Single Site<"));
  // The zero-environment site falls back to its id for a title.
  assert.ok(markup.includes(">s3<"));
  assert.ok(markup.includes('<span class="pill">3 sites</span>'));
});

test("7: every .site-row carries data-nm-state, and only the two frozen values", async () => {
  const connected = await resultMarkup({
    states: {
      "env-a": "connected",
      "env-b": "connected",
      "env-c": "connected",
      "env-p1": "connected",
      "env-p2": "connected",
    },
  });
  const values = [...connected.markup.matchAll(/data-nm-state="([^"]*)"/g)].map(
    (match) => match[1],
  );
  assert.equal(values.length, 4, "one per site row");
  for (const value of values)
    assert.ok(["installed", "install"].includes(value), value);
  // s1, s2 and p1 are fully connected; s3 has no environment at all.
  assert.deepEqual(values.filter((value) => value === "installed").length, 3);
  assert.deepEqual(values.filter((value) => value === "install").length, 1);

  // One environment short of connected demotes the whole row.
  const partial = await resultMarkup({
    states: { "env-a": "connected", "env-c": "connected" },
  });
  const partialValues = [
    ...partial.markup.matchAll(/data-nm-state="([^"]*)"/g),
  ].map((match) => match[1]);
  assert.deepEqual(partialValues.filter((v) => v === "installed").length, 1);
});

test("8: the four connection states render their documented pill and actions", async () => {
  const { markup } = await resultMarkup({
    states: {
      "env-a": "connected",
      "env-b": "reconnect_required",
      "env-c": "not_configured",
      "env-p1": "unavailable",
    },
  });
  assert.ok(markup.includes('<span class="pill ok">Connected</span>'));
  assert.ok(markup.includes('<span class="pill warn">Reconnect</span>'));
  assert.ok(markup.includes('<span class="pill">Not connected</span>'));
  assert.ok(markup.includes(">Unknown</span>"));
  assert.ok(markup.includes("novamira auth login https://env-c.example.com"));
  assert.ok(markup.includes("/_dashboard/connect?url="));
  // `connected` offers nothing; the Setup CTA belongs to the two unconnected
  // states only.
  assert.ok(!markup.includes("novamira auth login https://env-a.example.com"));

  // With the site CLI absent every cell is Unknown, every Connect is disabled,
  // and the install hint is the only sentence on the page.
  const absent = await resultMarkup({
    cliAvailable: false,
    states: { "env-a": "connected" },
  });
  assert.ok(!absent.markup.includes('class="pill ok">Connected'));
  assert.equal(
    absent.markup.split(">Unknown</span>").length - 1,
    5,
    "one per environment",
  );
  assert.ok(absent.markup.includes(SITE_CLI_INSTALL_HINT));
  assert.equal(absent.markup.split(">Connect</button>").length - 1, 5);
  assert.equal(absent.markup.split("disabled").length - 1 >= 5, true);
  assert.ok(!absent.markup.includes("novamira auth login"));
});

test("9: + Deploy path appears only for a push-capable provider's multi-env site", async () => {
  const { markup } = await resultMarkup();
  const hints = [...markup.matchAll(/class="deploy-hint" href="([^"]*)"/g)].map(
    (match) => match[1],
  );
  assert.equal(hints.length, 1, "kinsta's multi-env site only");
  assert.ok(hints[0].includes("profile=prod"));
  assert.ok(hints[0].includes("site=s1"));
  assert.ok(hints[0].startsWith("/deploy-paths/new?"));
});

test("10: Setup Novamira is a link for the three supported providers and a disabled button otherwise", async () => {
  const { markup } = await resultMarkup();
  const links = [
    ...markup.matchAll(/class="button link setup-cta" href="([^"]*)"/g),
  ].map((match) => match[1]);
  assert.equal(links.length, 3, "kinsta's three environments");
  for (const href of links) {
    assert.ok(href.startsWith("/novamira-setup?"));
    assert.ok(href.includes("profile=prod"));
    assert.ok(href.includes("env=env-"));
    assert.ok(href.includes("envname="));
    // Deleted with the site-profile surface.
    assert.ok(!href.includes("siteprofile"));
    assert.ok(!href.includes("replace"));
  }
  assert.ok(links.some((href) => href.includes("site=")));
  assert.ok(
    markup.includes("Supported by Kinsta, InstaWP, and Rocket.net"),
    "pantheon's environments say why they cannot",
  );
  assert.ok(!markup.includes("Fix set up"));
  assert.ok(!markup.includes("connected-directly"));
});

/* -------------------------------------------------------------------------- */
/* 11-13: connect                                                             */
/* -------------------------------------------------------------------------- */

function connectRequest(query) {
  return authorized(`/_dashboard/connect?${query}`, {
    method: "POST",
    body: JSON.stringify({ token: TOKEN }),
  });
}

test("11: a successful connect repaints the sites fragments and calls no provider", async () => {
  const { server, listCalls, connectCalls } = await fixture({
    states: { "env-a": "connected" },
  });
  await sse(server, sitesRequest());
  const before = listCalls.length;

  const { recorder } = await sse(
    server,
    connectRequest(
      "url=https%3A%2F%2Fenv-a.example.com&profile=__all__&include_envs=true",
    ),
  );
  assert.deepEqual(connectCalls, ["https://env-a.example.com"]);
  assert.equal(listCalls.length, before, "the warm cache answered");
  assert.deepEqual(recorder.order, [
    "sites-status/inner",
    "sites-result/outer",
    "toast/outer",
  ]);
  assert.ok(
    recorder
      .find("toast")
      .markup.includes("Connected. https://env-a.example.com"),
  );
});

test("12: a failing connect patches only the toast, with a fixed hint and no child output", async () => {
  const { server, connectCalls } = await fixture({
    connect: { kind: "failed", reason: "cli_absent" },
  });
  const { recorder } = await sse(
    server,
    connectRequest("url=https%3A%2F%2Fenv-a.example.com&profile=__all__"),
  );
  assert.deepEqual(connectCalls, ["https://env-a.example.com"]);
  assert.deepEqual(recorder.order, ["toast/outer"]);
  const toast = recorder.find("toast").markup;
  assert.ok(toast.includes("danger"));
  assert.ok(toast.includes(SITE_CLI_INSTALL_HINT));
  // The outcome union has nowhere to put child text, so none can appear.
  for (const leak of ["stderr", "exit", "ENOENT", "spawn"])
    assert.ok(!recorder.body.includes(leak), leak);
});

test("13: a malformed or insecure ?url= spawns nothing", async () => {
  for (const raw of [
    "",
    "http%3A%2F%2Fexample.com",
    "https%3A%2F%2Fadmin%3Apw%40example.com",
    "https%3A%2F%2Fexample.com%2F%3Fa%3D1",
    "ftp%3A%2F%2Fexample.com",
  ]) {
    const { server, connectCalls } = await fixture();
    const { recorder } = await sse(server, connectRequest(`url=${raw}`));
    assert.deepEqual(connectCalls, [], raw);
    assert.deepEqual(recorder.order, ["toast/outer"], raw);
    assert.ok(recorder.find("toast").markup.includes("danger"), raw);
    // A rejected URL is never echoed with its userinfo.
    assert.ok(!recorder.body.includes("admin:pw"), raw);
  }
});

test("14: a connect whose cache entry has expired says so with the toast alone", async () => {
  const { server, listCalls } = await fixture();
  const { recorder } = await sse(
    server,
    connectRequest("url=https%3A%2F%2Fenv-a.example.com&profile=__all__"),
  );
  assert.deepEqual(recorder.order, ["toast/outer"]);
  assert.ok(recorder.find("toast").markup.includes("Connected."));
  assert.equal(listCalls.length, 0, "connect never lists sites");
});

test("15: both routes refuse a missing or wrong token", async () => {
  const { server, connectCalls, listCalls } = await fixture();
  for (const [method, path] of [
    ["GET", "/_dashboard/sites?include_envs=true"],
    ["POST", "/_dashboard/connect?url=https%3A%2F%2Fexample.com"],
  ]) {
    for (const headers of [{}, { [TOKEN_HEADER]: "0".repeat(64) }]) {
      const response = await server.dispatch(
        request(path, { method, headers, body: "{}" }),
      );
      assert.equal(response.status, 403, `${path} ${JSON.stringify(headers)}`);
      assert.equal(response.envelope.error.code, "usage_error");
    }
  }
  assert.deepEqual(connectCalls, []);
  assert.equal(listCalls.length, 0);
});

test("16: a connected cell names the site-CLI profile and links to its page", async () => {
  const { server } = await fixture({
    states: { "env-a": "connected", "env-c": "reconnect_required" },
    profiles: { "env-a": ["prod"], "env-c": ["staging", "staging-2"] },
  });
  const recorder = fakeSseStream();
  const response = await server.dispatch(
    authorized("/_dashboard/sites?include_envs=true"),
  );
  await response.run(recorder.stream);
  const markup = recorder.find("sites-result").markup;

  // `ConnectionResult.profiles` has carried these names since 6a and no view
  // rendered one until now: the cell said "Connected" without saying what was
  // connected, which left two site listings with no visible relation.
  assert.ok(
    markup.includes('<a class="deploy-hint" href="/site-profiles"'),
    "a connected cell links to the Novamira CLI sites page",
  );
  assert.ok(markup.includes(">prod</a>"));
  // Every matching profile is named. Two `auth login`s against one URL under
  // different names both match, and hiding the second would make "Connected"
  // look like it came from the first.
  assert.ok(markup.includes(">staging, staging-2</a>"));
  assert.ok(markup.includes("Novamira CLI site profiles staging, staging-2."));

  // A cell with no match renders no link — `not_configured` has no profile by
  // definition, and inventing one would be worse than saying nothing.
  const { server: bare } = await fixture({ states: { "env-a": "connected" } });
  const cold = fakeSseStream();
  const plain = await bare.dispatch(
    authorized("/_dashboard/sites?include_envs=true"),
  );
  await plain.run(cold.stream);
  assert.ok(!cold.find("sites-result").markup.includes("/site-profiles"));
});

test("17: the service inverts the match into profile → hosting environments", async () => {
  // The Novamira CLI sites page reads this map backwards to draw its own
  // back-link. Both directions are the same origin match, made once by the
  // integration, so the two pages can never disagree about a pairing.
  const groups = [
    {
      profile: "prod",
      provider: "kinsta",
      sites: [
        {
          id: "s1",
          name: "s1",
          displayName: "Multi Site",
          status: "live",
          primaryDomain: "multi.example.com",
          environments: [env("env-a")],
        },
      ],
    },
  ];
  const service = createSitesService({
    store: { listHostingProfiles: async () => [] },
    hosting: {},
    integration: {
      connectionStates: async (queries) => ({
        byKey: new Map(
          queries.map((query) => [
            query.key,
            { state: "connected", profiles: ["cli-prod"] },
          ]),
        ),
        checkedAt: NOW,
        cliAvailable: true,
      }),
    },
    now: () => NOW,
  });

  // Empty until a round has run: "nobody has listed hosting sites in this
  // process yet" is a state, not a missing link to be invented.
  assert.equal(service.siteProfileLinks().size, 0);

  await service.refreshConnections(groups);
  assert.deepEqual(service.siteProfileLinks().get("cli-prod"), [
    {
      profile: "prod",
      siteId: "s1",
      siteLabel: "Multi Site",
      envId: "env-a",
      envLabel: "env-a display",
    },
  ]);

  // The links describe the listing, so dropping the listing drops them: a
  // back-link to a hosting profile that was just removed is worse than none.
  service.invalidate();
  assert.equal(service.siteProfileLinks().size, 0);
});
