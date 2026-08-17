// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two deploy-path pages and their two routes.
 *
 * The port of Go's deploy-path `server_test.go` cases: the four sentences of
 * `deployPathsStatusLine`, the populated table's columns and its two
 * disabled-Deploy reasons, the environment name and domain resolution against
 * the warm sites cache, the new-path form, and the save and remove handlers.
 *
 * Fully offline and socket-free. The one place the sites cache is warmed is a
 * dispatch of `/_dashboard/sites` against an injected registry of local fakes;
 * both deploy-path pages then read that cache and must issue **no** provider
 * call of their own, which is asserted by counting the fake's invocations.
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
import { createHostingClientFactory } from "../dist/hosting/factory.js";
import { createDashboardServer } from "../dist/web/index.js";

const TOKEN = "b".repeat(64);
const TOKEN_HEADER = "x-novamira-dashboard-token";
const NOW = 1_700_000_000_000;

const roots = [];
const servers = [];

test.after(async () => {
  for (const server of servers) await server.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function env(id, domain) {
  return {
    id,
    name: id,
    displayName: `${id} display`,
    isBlocked: false,
    isPremium: false,
    primaryDomain: domain,
  };
}

const KINSTA_SITES = [
  {
    id: "s1",
    name: "s1",
    displayName: "Multi Site",
    status: "live",
    primaryDomain: "multi.example.com",
    environments: [
      env("env-a", "staging.example.com"),
      env("env-b", "live.example.com"),
    ],
  },
  {
    id: "s2",
    name: "s2",
    displayName: "Single Site",
    status: "live",
    primaryDomain: "single.example.com",
    environments: [env("env-c", "single.example.com")],
  },
];

const PROFILES = {
  prod: {
    provider: "kinsta",
    credential: { type: "env", name: "KINSTA_API_KEY" },
  },
  plain: {
    provider: "pantheon",
    credential: { type: "env", name: "PANTHEON_MACHINE_TOKEN" },
  },
};

const DEPLOY_PATHS = {
  orphan: {
    name: "orphan",
    hostingProfile: "plain",
    siteId: "p9",
    siteLabel: "Gone",
    sourceEnvId: "missing-1",
    sourceEnvName: "Stored Source",
    targetEnvId: "missing-2",
    targetEnvName: "",
    pushDb: false,
    pushFiles: false,
    searchReplace: false,
  },
  "stage-to-live": {
    name: "stage-to-live",
    hostingProfile: "prod",
    siteId: "s1",
    siteLabel: "Multi Site",
    sourceEnvId: "env-a",
    sourceEnvName: "stored-a",
    targetEnvId: "env-b",
    targetEnvName: "stored-b",
    pushDb: true,
    pushFiles: true,
    searchReplace: false,
  },
};

async function fixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-deploy-"));
  roots.push(home);
  const environment = {
    NOVAMIRA_HQ_HOME: home,
    KINSTA_API_KEY: "kinsta-fake",
    PANTHEON_MACHINE_TOKEN: "pantheon-fake",
  };
  const paths = platformPaths(environment, process.platform, home);
  const security = defaultFileSecurity();
  await atomicWriteFile(
    paths.configFile,
    JSON.stringify({
      version: 1,
      hostingProfiles: options.hostingProfiles ?? PROFILES,
      deployPaths: options.deployPaths ?? {},
    }),
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
    listSites: async () => {
      listCalls.push(provider);
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
      pantheon: () => client("pantheon", []),
    },
    env: environment,
  });

  const server = createDashboardServer({
    version: "0.1.0-test",
    paths,
    store,
    hosting,
    credentials: async () => {
      throw new Error("this suite must not build a credential store");
    },
    environment,
    fetch: async () => {
      throw new Error("this suite must not make an outbound request");
    },
    now: () => NOW,
    randomToken: () => TOKEN,
    integration: {
      connectionStates: async () => ({
        byKey: new Map(),
        checkedAt: NOW,
        cliAvailable: true,
      }),
      connect: async () => ({ kind: "connected" }),
    },
    doctor: async () => {
      throw new Error("the deploy-path pages run no doctor report");
    },
    updates: {
      check: async () => {
        throw new Error(
          "the deploy-paths suite must not reach a package registry",
        );
      },
      install: async () => {
        throw new Error(
          "the deploy-paths suite must not run a package manager",
        );
      },
    },
  });
  servers.push(server);
  return { server, store, listCalls };
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
    method: "POST",
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

/**
 * The status line is prose with apostrophes in it, and the template escapes
 * them. Un-escaping before comparing is what Go's `datastarAttrValues` did for
 * attribute values, applied here to text.
 */
function unescapeHtml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function fakeSseStream() {
  const elements = [];
  const signals = [];
  return {
    elements,
    signals,
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

/** Warm the `__all__` sites cache the way the Sites page does. */
async function warmCache(server) {
  await sse(
    server,
    authorized("/_dashboard/sites?include_envs=true", {
      method: "GET",
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* 1: the status line                                                         */
/* -------------------------------------------------------------------------- */

test("1: the empty page explains why, with Go's four sentences", async () => {
  const line = async (server) =>
    unescapeHtml(await page(server, "/deploy-paths"));

  const none = await fixture({ hostingProfiles: {} });
  assert.ok(
    (await line(none.server)).includes(
      "You haven't connected a hosting provider yet",
    ),
  );
  assert.ok(
    (await line(none.server)).includes(
      'href="/providers">Open the Hosting Providers page',
    ),
  );

  const incapable = await fixture({
    hostingProfiles: { plain: PROFILES.plain },
  });
  assert.ok(
    (await line(incapable.server)).includes(
      "None of your connected hosts support environment push: plain (Pantheon).",
    ),
  );

  // Capable host, cache never warmed: the page must not go and look.
  const cold = await fixture();
  assert.ok(
    (await line(cold.server)).includes(
      "You have a deploy-capable host: prod (Kinsta). Open the Hosting Sites page",
    ),
  );
  assert.equal(cold.listCalls.length, 0, "a page render lists no sites");

  // Warm cache with an eligible site.
  const warm = await fixture();
  await warmCache(warm.server);
  assert.ok(
    (await line(warm.server)).includes(
      "You're ready — open the Hosting Sites page and expand one of your 1 site(s)",
    ),
  );

  // Warm cache, no site with more than one environment.
  const single = await fixture({ kinstaSites: [KINSTA_SITES[1]] });
  await warmCache(single.server);
  assert.ok(
    (await line(single.server)).includes(
      "Your deploy-capable host(s) prod (Kinsta) have no site with more than one environment yet",
    ),
  );
});

/* -------------------------------------------------------------------------- */
/* 2-3: the populated table                                                   */
/* -------------------------------------------------------------------------- */

test("2: the table renders Go's five columns, both Deploy reasons and the summary", async () => {
  const { server } = await fixture({ deployPaths: DEPLOY_PATHS });
  await warmCache(server);
  const markup = await page(server, "/deploy-paths");
  for (const want of [
    "<th>Name</th>",
    "<th>Site</th>",
    "<th>Direction</th>",
    "<th>Pushes</th>",
    'class="deploy-dir-names"',
    'class="deploy-dir-domains"',
    ">DB, files<",
    ">—<",
    'title="Execution comes in the next phase"',
    'title="This provider does not support environment push"',
    "/_dashboard/deploy-paths/remove?path=stage-to-live",
    "Remove deploy path stage-to-live?",
  ])
    assert.ok(markup.includes(want), want);
  // Go's `</section></section>` bug is not ported: the tags balance.
  assert.equal(
    markup.split("<section").length,
    markup.split("</section>").length,
  );
});

test("3: environments resolve from the warm cache, then the stored name, then the id", async () => {
  const { server } = await fixture({ deployPaths: DEPLOY_PATHS });
  await warmCache(server);
  const markup = await page(server, "/deploy-paths");
  // Resolved from the inventory, so a rename in the console shows through.
  assert.ok(markup.includes("env-a display → env-b display"));
  assert.ok(markup.includes("staging.example.com → live.example.com"));
  assert.ok(!markup.includes("stored-a"));
  // Unresolvable: the stored name, then the raw id, and no domains row.
  assert.ok(markup.includes("Stored Source → missing-2"));

  // With a cold cache both fall back to the stored names.
  const cold = await fixture({ deployPaths: DEPLOY_PATHS });
  const coldMarkup = await page(cold.server, "/deploy-paths");
  assert.ok(coldMarkup.includes("stored-a → stored-b"));
  assert.equal(cold.listCalls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* 4-5: the new-path page                                                     */
/* -------------------------------------------------------------------------- */

test("4: the form renders with the cached environments and highlights Deploy paths", async () => {
  const { server, listCalls } = await fixture();
  await warmCache(server);
  const before = listCalls.length;
  const markup = await page(server, "/deploy-paths/new?profile=prod&site=s1");
  assert.equal(listCalls.length, before, "the form reads the warm cache only");
  for (const want of [
    'data-bind="deployForm.name"',
    'data-bind="deployForm.sourceEnvId"',
    'data-bind="deployForm.targetEnvId"',
    'data-bind="deployForm.pushDb"',
    'data-bind="deployForm.pushFiles"',
    'data-bind="deployForm.searchReplace"',
    '<option value="env-a">env-a display</option>',
    "/_dashboard/deploy-paths/save",
    ">Save deploy path</button>",
    "Push changes between two environments of Multi Site.",
    'class="nav-link active" href="/deploy-paths"',
  ])
    assert.ok(markup.includes(want), want);
  // The submit sets the three fields the selects do not carry.
  assert.ok(markup.includes("$deployForm.hostingProfile = "));
  assert.ok(markup.includes("$deployForm.siteId = "));
});

test("5: without two resolvable environments the page is guidance, not a form", async () => {
  const { server } = await fixture();
  for (const path of [
    "/deploy-paths/new",
    "/deploy-paths/new?profile=prod&site=s1",
    "/deploy-paths/new?profile=prod&site=nope",
  ]) {
    const markup = await page(server, path);
    assert.ok(markup.includes("Open this from the Hosting Sites page"), path);
    assert.ok(!markup.includes("deployForm.sourceEnvId"), path);
  }
  // A single-environment site is still fewer than two.
  await warmCache(server);
  const single = await page(server, "/deploy-paths/new?profile=prod&site=s2");
  assert.ok(single.includes("Open this from the Hosting Sites page"));
  assert.ok(!single.includes("deployForm.sourceEnvId"));
});

/* -------------------------------------------------------------------------- */
/* 6-8: the handlers                                                          */
/* -------------------------------------------------------------------------- */

function saveRequest(form) {
  return authorized("/_dashboard/deploy-paths/save", {
    body: JSON.stringify({ token: TOKEN, deployForm: form }),
  });
}

const VALID_FORM = {
  name: "stage-to-live",
  hostingProfile: "prod",
  siteId: "s1",
  siteLabel: "Multi Site",
  sourceEnvId: "env-a",
  sourceEnvName: "",
  targetEnvId: "env-b",
  targetEnvName: "",
  pushDb: true,
  pushFiles: false,
  searchReplace: true,
};

test("6: save persists the eleven fields, resets the form and repaints the page", async () => {
  const { server, store } = await fixture();
  const { recorder } = await sse(server, saveRequest(VALID_FORM));
  assert.deepEqual((await store.load()).deployPaths["stage-to-live"], {
    ...VALID_FORM,
  });
  assert.deepEqual(recorder.order, ["main/outer", "nav/outer", "toast/outer"]);
  assert.equal(recorder.signals.length, 1);
  assert.equal(recorder.signals[0].deployForm.name, "");
  assert.equal(recorder.signals[0].deployForm.pushDb, false);
  assert.ok(recorder.find("toast").markup.includes("Deploy path saved."));
  assert.ok(
    recorder.find("main").markup.includes('class="main main-deploy-paths"'),
  );
});

test("6b: an incomplete or self-targeting form is a danger notice and no write", async () => {
  for (const [form, sentence] of [
    [{ ...VALID_FORM, name: "" }, "are all required"],
    [{ ...VALID_FORM, siteId: "" }, "are all required"],
    [{ ...VALID_FORM, targetEnvId: "env-a" }, "must differ"],
    [{ ...VALID_FORM, name: "not a name" }, "Deploy path name must use"],
  ]) {
    const { server, store } = await fixture();
    const { recorder } = await sse(server, saveRequest(form));
    const toast = recorder.find("toast").markup;
    assert.ok(toast.includes("danger"), sentence);
    assert.ok(toast.includes(sentence), `${sentence} :: ${toast}`);
    assert.deepEqual(Object.keys((await store.load()).deployPaths), []);
    // The operator's values stay in the form: no reset on the failure path.
    assert.equal(recorder.signals.length, 0);
  }
});

test("7: remove deletes the entry and reports a path that was not there", async () => {
  const { server, store } = await fixture({ deployPaths: DEPLOY_PATHS });
  const { recorder } = await sse(
    server,
    authorized("/_dashboard/deploy-paths/remove?path=orphan", {
      body: JSON.stringify({ token: TOKEN }),
    }),
  );
  assert.deepEqual(Object.keys((await store.load()).deployPaths), [
    "stage-to-live",
  ]);
  assert.ok(recorder.find("toast").markup.includes("orphan removed."));
  assert.deepEqual(recorder.order, ["main/outer", "nav/outer", "toast/outer"]);

  // Go silently deleted a missing key and reported success; HQ says so.
  const { recorder: again } = await sse(
    server,
    authorized("/_dashboard/deploy-paths/remove?path=orphan", {
      body: JSON.stringify({ token: TOKEN }),
    }),
  );
  assert.ok(again.find("toast").markup.includes("danger"));
});

test("8: both routes refuse a missing or wrong token", async () => {
  const { server, store } = await fixture();
  for (const path of [
    "/_dashboard/deploy-paths/save",
    "/_dashboard/deploy-paths/remove?path=orphan",
  ]) {
    for (const headers of [{}, { [TOKEN_HEADER]: "9".repeat(64) }]) {
      const response = await server.dispatch(
        request(path, {
          method: "POST",
          headers,
          body: JSON.stringify({ token: TOKEN, deployForm: VALID_FORM }),
        }),
      );
      assert.equal(response.status, 403, path);
      assert.equal(response.envelope.error.code, "usage_error");
    }
  }
  assert.deepEqual(Object.keys((await store.load()).deployPaths), []);
});
