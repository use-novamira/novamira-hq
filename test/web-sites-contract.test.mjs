// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Sites page, `GET /_dashboard/sites` and `POST /_dashboard/connect`.
 *
 * This is the port of the sites half of Go's `server_test.go` — the toolbar, the
 * segmented control, the cache, the group and row markup, the push hint and
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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultFileSecurity } from "../dist/config/file-security.js";
import { atomicWriteFile } from "../dist/config/atomic-write.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import { SITE_CLI_INSTALL_HINT } from "../dist/connection-state.js";
import { CliError } from "../dist/errors.js";
import { createHostingClientFactory } from "../dist/hosting/factory.js";
import {
  createDashboardServer,
  createSitesService,
  renderSitesResult,
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

/** Kinsta: environment-push capable and Novamira-setup capable. */
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

/** Pantheon: neither environment-push nor Novamira setup. */
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
  pushes: {},
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

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function serviceSite(label) {
  return {
    id: "shared",
    name: "shared",
    displayName: label,
    status: "live",
    primaryDomain: `${label.toLowerCase()}.example.com`,
    environments: [env("shared-env")],
  };
}

function emptyInventory(profileName = undefined) {
  return {
    connections: {
      byKey: new Map(),
      checkedAt: NOW,
      cliAvailable: true,
    },
    profiles: {
      profiles:
        profileName === undefined
          ? []
          : [
              {
                name: profileName,
                siteUrl: `https://${profileName}.example.com`,
                origin: `https://${profileName}.example.com`,
                state: "connected",
              },
            ],
      checkedAt: NOW,
      cliAvailable: true,
    },
  };
}

async function fixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-sites-"));
  roots.push(home);
  const environment = { NOVAMIRA_HQ_HOME: home, ...ENVIRONMENT };
  const paths = platformPaths(environment, process.platform, home);
  const security = defaultFileSecurity();
  await atomicWriteFile(
    paths.configFile,
    JSON.stringify(options.config ?? CONFIG),
    security,
  );
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
  const renameCalls = [];
  const listing = options.siteProfiles ?? {
    profiles: [],
    checkedAt: NOW,
    cliAvailable: options.cliAvailable ?? true,
  };
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
      siteInventory: async (queries) => ({
        connections: snapshotFor(
          queries,
          options.states ?? {},
          options.cliAvailable ?? true,
          options.profiles ?? {},
        ),
        profiles: listing,
      }),
      listProfiles: async () => listing,
      connect: async (siteUrl, name) => {
        connectCalls.push(name === undefined ? siteUrl : `${siteUrl} ${name}`);
        return options.connect ?? { kind: "connected" };
      },
      logoutProfile: async () => ({ kind: "done" }),
      renameProfile: async (name, newName) => {
        renameCalls.push([name, newName]);
        return options.rename ?? { kind: "done" };
      },
      removeProfile: async () => ({ kind: "done" }),
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
  return { server, store, listCalls, connectCalls, renameCalls };
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

test("1: the toolbar refreshes in background on mount and offers one Refresh action", async () => {
  const { server } = await fixture();
  const markup = await page(server, "/sites");
  for (const want of [
    'data-indicator="sites.loading"',
    "/_dashboard/sites?include_envs=true",
    // The `&` is hardened to `&` inside the JS string literal, so an
    // already-escaped attribute value cannot be re-interpreted after the HTML
    // parser un-escapes it.
    "include_envs=true\\u0026refresh=true",
    "data-on:change=",
    "data-on:submit__prevent=",
    ">Refresh</button>",
    "Last updated: never",
    'class="spinner"',
    '<option value="__all__">All hosting</option>',
    ">prod (Kinsta)<",
  ])
    assert.ok(markup.includes(want), want);
  assert.ok(markup.includes("data-init="));
  assert.ok(!markup.includes("Update hosting inventory"));
  assert.ok(!markup.includes(">Check connections</button>"));
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
    "Connected ",
    "Needs attention ",
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

test("5c-2: one offline provider keeps its last sites while healthy providers refresh", async () => {
  let now = NOW;
  let round = 1;
  const inventoryQueries = [];
  const service = createSitesService({
    store: {
      listHostingProfiles: async () => [
        { name: "prod", profile: CONFIG.hostingProfiles.prod },
        { name: "plain", profile: CONFIG.hostingProfiles.plain },
      ],
    },
    hosting: {
      clientFromEntry: async (entry) => ({
        listSites: async () => {
          if (entry.name === "plain" && round === 2) {
            throw new CliError("network_error", "Pantheon API unavailable.");
          }
          return [serviceSite(`${entry.name}-${round}`)];
        },
      }),
    },
    integration: {
      siteInventory: async (queries) => {
        inventoryQueries.push(queries);
        return emptyInventory();
      },
    },
    now: () => now,
  });

  const first = await service.list({
    profile: "__all__",
    includeEnvs: true,
    refresh: true,
  });
  assert.equal(first.storedAt, NOW);

  now += 60_000;
  round = 2;
  const refreshed = await service.list({
    profile: "__all__",
    includeEnvs: true,
    refresh: true,
  });
  const healthy = refreshed.groups.find((group) => group.profile === "prod");
  const offline = refreshed.groups.find((group) => group.profile === "plain");

  assert.equal(healthy.sites[0].displayName, "prod-2");
  assert.equal(healthy.error, undefined);
  assert.equal(offline.sites[0].displayName, "plain-1");
  assert.equal(offline.stale, true);
  assert.equal(offline.error, "Pantheon API unavailable.");
  assert.equal(
    refreshed.storedAt,
    NOW,
    "the page timestamp does not claim the retained provider data is fresh",
  );
  assert.ok(
    inventoryQueries
      .at(-1)
      .some((query) => query.key === "plain/shared/shared-env"),
    "CLI connection checks still include the retained environment",
  );
  assert.equal(service.snapshot("__all__", true), refreshed);

  const markup = renderSitesResult({
    ...refreshed,
    notice: { level: "neutral", message: "" },
  }).markup;
  assert.ok(markup.includes("plain-1"));
  assert.ok(markup.includes("API unavailable"));
  assert.ok(markup.includes("does not mean the sites are offline"));
  assert.ok(markup.includes("prod-2"));
});

test("cached snapshots survive TTL without provider calls and connection checks are separate", async () => {
  let calls = 0;
  let checks = 0;
  let now = NOW;
  const service = createSitesService({
    store: {
      listHostingProfiles: async () => [
        { name: "prod", profile: CONFIG.hostingProfiles.prod },
      ],
    },
    hosting: {
      clientFromEntry: async () => ({
        listSites: async () => {
          calls++;
          return [serviceSite("Saved")];
        },
      }),
    },
    integration: {
      siteInventory: async () => {
        checks++;
        return emptyInventory();
      },
    },
    now: () => now,
  });
  assert.equal(service.snapshot("__all__", true), undefined);
  await service.verifyConnections("__all__", true);
  assert.equal(calls, 0);
  await service.list({ profile: "__all__", includeEnvs: true, refresh: true });
  now += 600000;
  const before = checks;
  assert.equal(
    service.snapshot("__all__", true).groups[0].sites[0].displayName,
    "Saved",
  );
  assert.equal(checks, before);
  await service.verifyConnections("__all__", true);
  assert.equal(calls, 1);
  assert.equal(checks, before + 1);
  service.invalidate();
  assert.equal(service.snapshot("__all__", true), undefined);
});

test("5d: invalidation supersedes an older in-flight provider load", async () => {
  const oldLoad = deferred();
  const newLoad = deferred();
  let calls = 0;
  const service = createSitesService({
    store: {
      listHostingProfiles: async () => [
        { name: "prod", profile: CONFIG.hostingProfiles.prod },
      ],
    },
    hosting: {
      clientFromEntry: async () => ({
        listSites: async () => {
          calls += 1;
          return calls === 1 ? oldLoad.promise : newLoad.promise;
        },
      }),
    },
    integration: { siteInventory: async () => emptyInventory() },
    now: () => NOW,
  });
  const request = {
    profile: "__all__",
    includeEnvs: true,
    refresh: false,
  };

  const oldResult = service.list(request);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  service.invalidate();
  const newResult = service.list(request);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    calls,
    2,
    "post-invalidation work does not join the old promise",
  );

  newLoad.resolve([serviceSite("New")]);
  assert.equal((await newResult).groups[0].sites[0].displayName, "New");
  oldLoad.resolve([serviceSite("Old")]);
  assert.equal(
    (await oldResult).groups[0].sites[0].displayName,
    "New",
    "the obsolete request retries against the current generation",
  );
  assert.equal(
    (await service.list(request)).groups[0].sites[0].displayName,
    "New",
  );
  assert.equal(calls, 2, "the obsolete load did not repopulate the cache");
});

test("5e: invalidation discards a delayed warm CLI-profile refresh", async () => {
  const delayedInventory = deferred();
  let inventoryCalls = 0;
  const service = createSitesService({
    store: {
      listHostingProfiles: async () => [
        { name: "prod", profile: CONFIG.hostingProfiles.prod },
      ],
    },
    hosting: {
      clientFromEntry: async () => ({
        listSites: async () => [serviceSite("Current")],
      }),
    },
    integration: {
      siteInventory: async () => {
        inventoryCalls += 1;
        return inventoryCalls === 1
          ? emptyInventory()
          : delayedInventory.promise;
      },
    },
    now: () => NOW,
  });
  const request = {
    profile: "__all__",
    includeEnvs: true,
    refresh: false,
  };
  await service.list(request);

  const refresh = service.refreshWarm("__all__", true);
  await Promise.resolve();
  assert.equal(inventoryCalls, 2);
  service.invalidate();
  delayedInventory.resolve(emptyInventory("obsolete-profile"));
  assert.equal(await refresh, undefined);
  assert.equal(service.warm("__all__", true), undefined);
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

test("9: Push from here appears on each environment of a push-capable multi-env site", async () => {
  const { markup } = await resultMarkup();
  const hints = [...markup.matchAll(/class="push-hint" href="([^"]*)"/g)].map(
    (match) => match[1],
  );
  assert.equal(hints.length, 2, "kinsta's two eligible environments only");
  for (const href of hints) {
    assert.ok(href.includes("profile=prod"));
    assert.ok(href.includes("site=s1"));
    assert.ok(href.includes("source=env-"));
    assert.ok(href.startsWith("/push/new?"));
  }
  assert.equal(markup.split(">Push from here</a>").length - 1, 2);
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
  assert.ok(
    !recorder
      .find("sites-result")
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

test("16: matched CLI profiles stay in the hosting row and CLI-only sites are separate", async () => {
  const siteProfiles = {
    profiles: [
      {
        name: "prod",
        siteUrl: "https://env-a.example.com",
        origin: "https://env-a.example.com",
        state: "connected",
      },
      ...["staging", "staging-2"].map((name) => ({
        name,
        siteUrl: "https://env-c.example.com",
        origin: "https://env-c.example.com",
        state: "reconnect_required",
      })),
    ],
    checkedAt: NOW,
    cliAvailable: true,
  };
  const { server } = await fixture({
    states: { "env-a": "connected", "env-c": "reconnect_required" },
    profiles: { "env-a": ["prod"], "env-c": ["staging", "staging-2"] },
    siteProfiles,
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
    markup.includes('<span class="cli-profile-actions"><strong>prod</strong>'),
  );
  // Every matching profile is named. Two `auth login`s against one URL under
  // different names both match, and hiding the second would make "Connected"
  // look like it came from the first.
  assert.ok(markup.includes("<strong>staging</strong>"));
  assert.ok(markup.includes("<strong>staging-2</strong>"));
  assert.ok(markup.includes(">Disconnect</button>"));
  assert.ok(markup.includes('<span class="profile-menu-label">Rename</span>'));
  assert.ok(markup.includes(">Save name</button>"));
  assert.ok(markup.includes("novamira sites rename prod &lt;new-name&gt;"));
  assert.ok(markup.includes(">Remove from list</button>"));

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

test("18: the unified list renders unmatched CLI profiles as an inventory group", async () => {
  const siteProfiles = {
    profiles: [
      {
        name: "cli-prod",
        siteUrl: "https://env-a.example.com",
        origin: "https://env-a.example.com",
        state: "connected",
      },
      {
        name: "direct",
        siteUrl: "https://direct.example.com",
        origin: "https://direct.example.com",
        state: "reconnect_required",
      },
    ],
    checkedAt: NOW,
    cliAvailable: true,
  };
  const { markup } = await resultMarkup({
    states: { "env-a": "connected" },
    profiles: { "env-a": ["cli-prod"] },
    siteProfiles,
  });
  assert.ok(markup.includes('<section class="provider-sites cli-sites">'));
  assert.ok(markup.includes("<h2>Sites added by URL</h2>"));
  assert.ok(markup.includes("same site may appear here"));
  assert.ok(markup.includes("direct.example.com"));
  assert.ok(
    markup.includes(
      'data-nm-state="install"><strong class="cli-site-name">direct</strong>',
    ),
  );
  assert.ok(!markup.includes("Reconnect required"));
  assert.ok(markup.includes("name=direct"));
  assert.equal(markup.split(">cli-prod<").length - 1, 1);
});

test("19: adding a CLI site sends the optional custom name", async () => {
  const { server, connectCalls } = await fixture();
  const { recorder } = await sse(
    server,
    authorized("/_dashboard/site-profiles/connect?unified=true", {
      method: "POST",
      body: JSON.stringify({
        cliSites: { url: "https://example.com", name: "my-site" },
        sites: { profile: "__all__", includeEnvs: true },
      }),
    }),
  );
  assert.deepEqual(connectCalls, ["https://example.com my-site"]);
  assert.deepEqual(recorder.order, ["main/outer", "nav/outer", "toast/outer"]);
  assert.deepEqual(recorder.signals, [
    { cliSites: { open: false, url: "", name: "", loading: false } },
  ]);
  const main = recorder.find("main").markup;
  assert.ok(main.includes("Site connected"));
  assert.ok(main.includes("my-site"));
  assert.ok(main.includes("https://example.com"));
  assert.ok(main.includes('href="/sites">Open Sites</a>'));
  assert.ok(main.includes('href="/sites?new=cli">Connect another site</a>'));
  assert.ok(!recorder.find("toast").markup.includes("Connected."));
});

test("a CLI profile on a site without a compatible Novamira setup is explicit", async () => {
  const siteProfiles = {
    profiles: [
      {
        name: "not-ready",
        siteUrl: "https://direct.example.com",
        origin: "https://direct.example.com",
        state: "unknown",
        reason: "site_incompatible",
      },
    ],
    checkedAt: NOW,
    cliAvailable: true,
  };
  const { markup } = await resultMarkup({ siteProfiles });
  assert.ok(markup.includes("Novamira not ready"));
  assert.ok(markup.includes("plugin may be missing"));
  assert.ok(markup.includes(">Reconnect</button>"));
  assert.ok(!markup.includes(">Unknown</span>"));
});

test("20: renaming a CLI site posts the new name and uses only warm hosting inventory", async () => {
  const siteProfiles = {
    profiles: [
      {
        name: "prod",
        siteUrl: "https://env-a.example.com",
        origin: "https://env-a.example.com",
        state: "connected",
      },
    ],
    checkedAt: NOW,
    cliAvailable: true,
  };
  const { server, listCalls, renameCalls } = await fixture({
    states: { "env-a": "connected" },
    profiles: { "env-a": ["prod"] },
    siteProfiles,
  });
  await sse(server, sitesRequest());
  const before = listCalls.length;
  const renameSignal = "rename_" + Buffer.from("prod").toString("hex");

  const { recorder } = await sse(
    server,
    authorized(
      "/_dashboard/site-profiles/rename?name=prod&profile=__all__&include_envs=true&unified=true",
      {
        method: "POST",
        body: JSON.stringify({ [renameSignal]: " production " }),
      },
    ),
  );
  assert.deepEqual(renameCalls, [["prod", "production"]]);
  assert.equal(listCalls.length, before, "rename uses the warm provider cache");
  assert.deepEqual(recorder.order, [
    "sites-status/inner",
    "sites-result/outer",
    "toast/outer",
  ]);
  assert.ok(
    recorder.find("toast").markup.includes("Renamed prod to production."),
  );
});

test("21: invalid rename values spawn nothing", async () => {
  for (const newName of ["", "--json", "prod", "a b"]) {
    const { server, renameCalls } = await fixture();
    const renameSignal = "rename_" + Buffer.from("prod").toString("hex");
    const { recorder } = await sse(
      server,
      authorized("/_dashboard/site-profiles/rename?name=prod", {
        method: "POST",
        body: JSON.stringify({ [renameSignal]: newName }),
      }),
    );
    assert.deepEqual(renameCalls, [], newName);
    assert.deepEqual(recorder.order, ["toast/outer"], newName);
    assert.ok(recorder.find("toast").markup.includes("danger"), newName);
  }
});
