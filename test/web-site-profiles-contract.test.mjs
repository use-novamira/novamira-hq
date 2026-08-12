// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `/site-profiles` page, its `#cli-sites` fragment and the four
 * `/_dashboard/site-profiles*` routes that manage the **site CLI's** profiles.
 *
 * The distinction this suite exists to pin is the one the names invite you to
 * miss. Go's deleted `/_dashboard/sites/save` and `/_dashboard/sites/remove`
 * wrote **HQ's own** `site_profiles`, complete with a WordPress Application
 * Password HQ had created over the site's REST API. These four routes write
 * nothing: each spawns one `novamira` command and reads the v1 envelope's `ok`,
 * so the page is a report of what the site CLI actually holds rather than of
 * anything HQ stores. `web-server-contract.test.mjs` still asserts the two
 * deleted paths appear nowhere.
 *
 * Case 1b is the regression for where this feature started: the panel was
 * briefly nested on `/sites`, and it does not belong there.
 *
 * Fully offline and socket-free. Pages come from `server.dispatch`, SSE handlers
 * run against a recording stream, and the integration is an injected object that
 * records its calls — nothing here spawns a process or contacts a provider.
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
import {
  SITE_CLI_INSTALL_HINT,
  unavailableHint,
} from "../dist/connection-state.js";
import { createHostingClientFactory } from "../dist/hosting/factory.js";
import { createDashboardServer } from "../dist/web/index.js";

const TOKEN = "f".repeat(64);
const TOKEN_HEADER = "x-novamira-dashboard-token";
const NOW = 1_700_000_000_000;

const LIST = "/_dashboard/site-profiles";
const CONNECT = "/_dashboard/site-profiles/connect";
const LOGOUT = "/_dashboard/site-profiles/logout";
const REMOVE = "/_dashboard/site-profiles/remove";

const CONFIG = { version: 1, hostingProfiles: {}, deployPaths: {} };

const roots = [];
const servers = [];

test.after(async () => {
  for (const server of servers) await server.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

function profile(name, state, overrides = {}) {
  return {
    name,
    siteUrl: `https://${name}.example.com`,
    origin: `https://${name}.example.com`,
    state,
    ...overrides,
  };
}

const LISTING = {
  profiles: [
    profile("prod", "connected", { expiresAt: "2026-09-01T00:00:00.000Z" }),
    profile("staging", "reconnect_required"),
    profile("old", "unknown", { reason: "cli_timeout" }),
  ],
  checkedAt: NOW,
  cliAvailable: true,
};

async function fixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-cli-sites-"));
  roots.push(home);
  const environment = { NOVAMIRA_HQ_HOME: home };
  const paths = platformPaths(environment, process.platform, home);
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(paths.configFile, JSON.stringify(CONFIG));
  const security = defaultFileSecurity();
  const store = new ConfigStore(
    paths.configFile,
    new ProfileLockManager(paths.stateDir, security),
    security,
  );

  const calls = [];
  const answer = (kind, value) => {
    calls.push(kind);
    if (value instanceof Error) throw value;
    return value;
  };

  const server = createDashboardServer({
    version: "0.1.0-test",
    paths,
    store,
    hosting: createHostingClientFactory({
      store,
      registry: {},
      env: environment,
    }),
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
      connect: async (siteUrl) => {
        calls.push(`connect ${siteUrl}`);
        return options.connect ?? { kind: "connected" };
      },
      listProfiles: async () => answer("list", options.listing ?? LISTING),
      logoutProfile: async (name) =>
        answer(`logout ${name}`, options.logout ?? { kind: "done" }),
      removeProfile: async (name) =>
        answer(`remove ${name}`, options.remove ?? { kind: "done" }),
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
  });
  servers.push(server);
  return { server, calls };
}

function request(path, options = {}) {
  const target = new URL(path, "http://127.0.0.1:8787");
  return {
    method: options.method ?? "GET",
    path: decodeURIComponent(target.pathname),
    query: target.searchParams,
    headers: { host: "127.0.0.1:8787", ...options.headers },
    signal: new AbortController().signal,
    body: async () => options.body ?? "{}",
  };
}

function authorized(path, options = {}) {
  return request(path, {
    ...options,
    headers: { [TOKEN_HEADER]: TOKEN, ...options.headers },
  });
}

function fakeSseStream() {
  const elements = [];
  return {
    elements,
    get body() {
      return elements.map((patch) => patch.markup).join("\n");
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
      patchSignals() {
        throw new Error("no site-profile route patches signals");
      },
      close() {},
    },
  };
}

/** Drive one SSE route and return the recorded patches. */
async function sse(server, message) {
  const response = await server.dispatch(message);
  assert.equal(response.kind, "sse", message.path);
  const recorder = fakeSseStream();
  await response.run(recorder.stream);
  return recorder;
}

/* -------------------------------------------------------------------------- */
/* 1-2: the page                                                              */
/* -------------------------------------------------------------------------- */

test("1: /site-profiles is its own page and mounts the panel empty", async () => {
  const { server, calls } = await fixture();
  const response = await server.dispatch(request("/site-profiles"));
  assert.equal(response.status, 200);
  const markup = response.body.markup;

  assert.ok(
    markup.includes('<main id="main" class="main main-site-profiles">'),
  );
  assert.ok(markup.includes("<h1>Novamira CLI sites</h1>"));
  assert.ok(markup.includes('id="cli-sites"'));
  // Its own nav link, active, and no alias onto Sites: this is not a detail
  // view of the hosting inventory, which is why it left that page.
  assert.ok(
    markup.includes('<a class="nav-link active" href="/site-profiles">'),
  );

  // The panel loads itself, from its own route, with an include scope that
  // matches nothing: a `@get`'s signals are serialized into `?datastar=…`, and
  // the panel has nothing to send.
  assert.match(
    markup,
    /id="cli-sites"[^>]*data-init="@get\(&quot;\/_dashboard\/site-profiles&quot;[^"]*include: \/\(\?!\)\//,
  );
  // Refresh sits in the page header, outside the fragment, so an outer patch of
  // `#cli-sites` cannot replace the button that fired it.
  assert.ok(markup.indexOf(">Refresh<") < markup.indexOf('id="cli-sites"'));

  // The page render itself asks the site CLI nothing: the panel's own request
  // does, which is what keeps a local `sites list` off the page-load path.
  assert.deepEqual(calls, []);

  // Go's deleted site-profile surface stays deleted.
  for (const gone of ["/_dashboard/sites/save", "/_dashboard/sites/remove"])
    assert.ok(!markup.includes(gone), gone);
});

test("1b: the Sites page is untouched — no panel, no site-CLI call", async () => {
  const { server, calls } = await fixture();
  const markup = (await server.dispatch(request("/sites"))).body.markup;
  // The panel was briefly nested here and is not any more. `sites-filter.js`
  // observes `#sites-result` and buckets `.site-row` children; nothing about
  // site profiles belongs inside that element or beside it.
  assert.ok(!markup.includes('id="cli-sites"'));
  assert.ok(markup.includes('id="sites-result"'));
  assert.deepEqual(calls, []);
});

test("2: every /_dashboard/site-profiles* route requires the token", async () => {
  const { server, calls } = await fixture();
  for (const [method, path] of [
    ["GET", LIST],
    ["POST", CONNECT],
    ["POST", LOGOUT],
    ["POST", REMOVE],
  ]) {
    const response = await server.dispatch(request(path, { method }));
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  // A refused request runs no handler, so it spawns nothing.
  assert.deepEqual(calls, []);

  // The GET row is GET-only and the three action rows are POST-only.
  assert.equal(
    (await server.dispatch(authorized(LIST, { method: "POST" }))).status,
    405,
  );
  assert.equal((await server.dispatch(authorized(REMOVE))).status, 405);
});

/* -------------------------------------------------------------------------- */
/* 3-5: the listing route                                                     */
/* -------------------------------------------------------------------------- */

test("3: the list route patches cli-sites then toast, and nothing else", async () => {
  const { server, calls } = await fixture();
  const recorder = await sse(server, authorized(LIST));

  assert.deepEqual(recorder.order, ["cli-sites/outer", "toast/outer"]);
  assert.deepEqual(calls, ["list"]);
  // Never `#main` — it carries the page's own Refresh button, and a repaint
  // would replace it out from under the click that fired this request. Never
  // the hosting-sites fragments either: those cost a provider call each.
  for (const id of ["main", "sites-result", "sites-status", "nav"])
    assert.equal(recorder.find(id), undefined, id);
  // A plain load says nothing: a toast on every page mount is noise.
  assert.ok(!recorder.find("toast").markup.includes("notice"));
});

test("4: each state renders its pill, and Reconnect is absent when connected", async () => {
  const { server } = await fixture();
  const markup = (await sse(server, authorized(LIST))).find("cli-sites").markup;

  assert.ok(markup.includes("prod"));
  assert.ok(markup.includes("https://prod.example.com"));
  assert.ok(markup.includes("Connected"));
  assert.ok(markup.includes("Reconnect required"));
  assert.ok(markup.includes("Unknown"));
  // `expiresAt` is carried as text — a time, never a credential.
  assert.ok(markup.includes("2026-09-01T00:00:00.000Z"));
  // The `unknown` row's title is the fixed hint its reason selects.
  assert.ok(markup.includes(unavailableHint("cli_timeout")));

  // Three rows, and one Reconnect fewer than that: a profile that already
  // answers is not one you re-authorize.
  assert.equal(markup.split("<article>").length - 1, 3);
  assert.equal(markup.split(">Reconnect<").length - 1, 2);
  assert.equal(markup.split(">Sign out<").length - 1, 3);
  assert.equal(markup.split(">Remove<").length - 1, 3);
  // Each button's title is the copyable command it stands for.
  assert.ok(markup.includes("novamira --site prod auth logout"));
  assert.ok(markup.includes("novamira sites remove prod"));
  assert.ok(markup.includes("novamira auth login https://staging.example.com"));

  // The listing is loaded, so the root no longer carries the self-load.
  assert.ok(!markup.includes("data-on-load"));

  // The URL box is a full-width text field in a `.form-grid`, above a
  // `.button-row`. It must never be in a `.check-row`: `app.css` is frozen and
  // that class is the Go program's *checkbox* row, carrying
  // `input { width: 16px; min-height: 16px }` — a URL field placed in one
  // renders as a 16-pixel square wedged between its label and the button.
  assert.ok(
    markup.includes(
      '<div class="form-grid"><label><span>Connect another site</span><input type="url"',
    ),
  );
  assert.ok(markup.includes('<div class="button-row">'));
  assert.ok(!markup.includes("check-row"));
});

test("5: an untrustworthy listing is the hint, no rows and no actions", async () => {
  // An absent site CLI: the install hint, and the connect box disabled — every
  // control on the panel spawns `novamira`, and there is no point offering one.
  const absent = await fixture({
    listing: {
      profiles: [],
      checkedAt: NOW,
      cliAvailable: false,
      reason: "cli_absent",
    },
  });
  const missing = (await sse(absent.server, authorized(LIST))).find(
    "cli-sites",
  ).markup;
  assert.ok(missing.includes(SITE_CLI_INSTALL_HINT));
  assert.ok(!missing.includes("<article>"));
  assert.ok(!missing.includes(">Remove<"));
  assert.match(missing, /<input[^>]*disabled/);
  assert.match(missing, /<button[^>]*disabled[^>]*>Connect</);

  // An out-of-date one: a different fixed sentence, the same refusal to guess.
  const old = await fixture({
    listing: {
      profiles: [],
      checkedAt: NOW,
      cliAvailable: true,
      reason: "cli_incompatible",
    },
  });
  const stale = (await sse(old.server, authorized(LIST))).find(
    "cli-sites",
  ).markup;
  assert.ok(stale.includes(unavailableHint("cli_incompatible")));
  assert.ok(!stale.includes("<article>"));

  // An empty list from a healthy CLI is a different sentence again, and it
  // leaves the connect box usable — that is how the first site gets added.
  const empty = await fixture({
    listing: { profiles: [], checkedAt: NOW, cliAvailable: true },
  });
  const none = (await sse(empty.server, authorized(LIST))).find(
    "cli-sites",
  ).markup;
  assert.ok(none.includes("no site profiles yet"));
  assert.ok(!none.includes("disabled"));
});

/* -------------------------------------------------------------------------- */
/* 6-8: connect                                                               */
/* -------------------------------------------------------------------------- */

test("6: connect takes ?url= first, then the posted cliSites.url signal", async () => {
  const fromQuery = await fixture();
  const viaQuery = await sse(
    fromQuery.server,
    authorized(`${CONNECT}?url=https://example.com`, { method: "POST" }),
  );
  // The URL reaches `connect` normalized, the panel is re-listed, and the toast
  // names the site.
  assert.deepEqual(fromQuery.calls, ["connect https://example.com", "list"]);
  assert.deepEqual(viaQuery.order, ["cli-sites/outer", "toast/outer"]);
  assert.ok(viaQuery.find("toast").markup.includes("Connected."));

  const fromBody = await fixture();
  await sse(
    fromBody.server,
    authorized(CONNECT, {
      method: "POST",
      body: JSON.stringify({
        token: TOKEN,
        cliSites: { url: "  https://typed.example.com  " },
      }),
    }),
  );
  // Trimmed on the way in, normalized on the way out, and no `--name`: profile
  // naming belongs to the site CLI.
  assert.deepEqual(fromBody.calls, [
    "connect https://typed.example.com",
    "list",
  ]);
});

test("7: a URL the site CLI would refuse spawns nothing", async () => {
  const { server, calls } = await fixture();
  for (const bad of [
    "",
    "not a url",
    "http://example.com",
    "https://user:pw@example.com",
    "https://example.com?a=b",
    "https://example.com#f",
  ]) {
    const recorder = await sse(
      server,
      authorized(`${CONNECT}?url=${encodeURIComponent(bad)}`, {
        method: "POST",
      }),
    );
    const toast = recorder.find("toast").markup;
    assert.ok(toast.includes("danger"), bad);
    // The rejected value is never echoed back into the page.
    if (bad.includes("user:pw")) assert.ok(!toast.includes("pw"), bad);
  }
  // Not one `connect`. The panel is still repainted, so the operator is not
  // left looking at a stale list beside a failure.
  assert.deepEqual(new Set(calls), new Set(["list"]));
});

test("8: a failed login is the fixed hint and never child output", async () => {
  const { server, calls } = await fixture({
    connect: { kind: "failed", reason: "cli_timeout" },
  });
  const recorder = await sse(
    server,
    authorized(`${CONNECT}?url=https://example.com`, { method: "POST" }),
  );
  const toast = recorder.find("toast").markup;
  assert.ok(toast.includes(unavailableHint("cli_timeout")));
  assert.ok(toast.includes("danger"));
  assert.deepEqual(calls, ["connect https://example.com", "list"]);
  // The panel still repaints, so the row's state reflects the failed attempt.
  assert.ok(recorder.find("cli-sites").markup.includes("<article>"));
});

/* -------------------------------------------------------------------------- */
/* 9-12: logout and remove                                                    */
/* -------------------------------------------------------------------------- */

test("9: logout and remove pass the name and re-list before patching", async () => {
  const out = await fixture();
  const signedOut = await sse(
    out.server,
    authorized(`${LOGOUT}?name=prod`, { method: "POST" }),
  );
  assert.deepEqual(out.calls, ["logout prod", "list"]);
  assert.deepEqual(signedOut.order, ["cli-sites/outer", "toast/outer"]);
  assert.ok(signedOut.find("toast").markup.includes("Signed out of prod."));

  const gone = await fixture();
  const removed = await sse(
    gone.server,
    authorized(`${REMOVE}?name=staging`, { method: "POST" }),
  );
  assert.deepEqual(gone.calls, ["remove staging", "list"]);
  assert.ok(removed.find("toast").markup.includes("Removed staging."));
  // Neither touches the provider listing above.
  for (const id of ["main", "sites-result", "sites-status"])
    assert.equal(removed.find(id), undefined, id);
});

test("10: a profile that is already gone is a warning, not a failure", async () => {
  const { server, calls } = await fixture({ remove: { kind: "missing" } });
  const recorder = await sse(
    server,
    authorized(`${REMOVE}?name=old`, { method: "POST" }),
  );
  const toast = recorder.find("toast").markup;
  assert.ok(toast.includes("no longer holds old"));
  assert.ok(toast.includes("warn"));
  assert.ok(!toast.includes("danger"));
  assert.deepEqual(calls, ["remove old", "list"]);
});

test("11: an action failure is the fixed hint, with no child text anywhere", async () => {
  const { server } = await fixture({
    logout: { kind: "failed", reason: "site_unreachable" },
  });
  const recorder = await sse(
    server,
    authorized(`${LOGOUT}?name=prod`, { method: "POST" }),
  );
  assert.ok(
    recorder.find("toast").markup.includes(unavailableHint("site_unreachable")),
  );
  // The whole response carries only sentences from the closed reason set.
  for (const noise of ["stderr", "Traceback", "Bearer "])
    assert.ok(!recorder.body.includes(noise), noise);
});

test("12: a name the CLI's grammar refuses spawns nothing", async () => {
  const { server, calls } = await fixture();
  // The leading `-` is the case that matters: commander would read it as an
  // option, so `sites remove --json` would run a different command than the one
  // HQ meant.
  for (const bad of ["", "--json", "-x", "a b", ".dot", "a".repeat(65)]) {
    for (const path of [LOGOUT, REMOVE]) {
      const recorder = await sse(
        server,
        authorized(`${path}?name=${encodeURIComponent(bad)}`, {
          method: "POST",
        }),
      );
      assert.ok(recorder.find("toast").markup.includes("danger"), bad);
    }
  }
  assert.deepEqual(new Set(calls), new Set(["list"]));

  // And the names the site CLI does allow go straight through.
  const ok = await fixture();
  for (const name of ["prod", "a.b", "a_b", "a-b", "0"])
    await sse(
      ok.server,
      authorized(`${REMOVE}?name=${name}`, { method: "POST" }),
    );
  assert.deepEqual(
    ok.calls.filter((call) => call.startsWith("remove ")),
    ["remove prod", "remove a.b", "remove a_b", "remove a-b", "remove 0"],
  );
});

test("13: an integration that throws becomes a toast, never an envelope", async () => {
  const { server } = await fixture({
    remove: new Error("boom: Bearer sk-must-never-appear"),
  });
  const recorder = await sse(
    server,
    authorized(`${REMOVE}?name=prod`, { method: "POST" }),
  );
  // The browser is waiting for a patch stream; a JSON failure envelope would
  // leave it with nothing on screen.
  assert.deepEqual(recorder.order, ["cli-sites/outer", "toast/outer"]);
  assert.ok(recorder.find("toast").markup.includes("danger"));
  assert.ok(!recorder.body.includes("sk-must-never-appear"));
});

test("14: a row links back to the hosting environment it was matched to", async () => {
  const { renderSiteProfiles } =
    await import("../dist/web/views/site-profiles.js");

  // The map is `services/sites.ts`'s inversion of `ConnectionResult.profiles` —
  // the same origin match the Hosting Sites page reads forwards. Nothing under
  // `src/web/` compares a domain to produce it.
  const links = new Map([
    [
      "prod",
      [
        {
          profile: "kinsta-prod",
          siteId: "s1",
          siteLabel: "Multi Site",
          envId: "env-a",
          envLabel: "Live",
        },
      ],
    ],
  ]);
  const withLinks = renderSiteProfiles({ listing: LISTING, links }).markup;
  assert.ok(withLinks.includes('<a href="/sites?profile=kinsta-prod"'));
  assert.ok(withLinks.includes(">Multi Site / Live</a>"));
  assert.ok(withLinks.includes("on the hosting profile kinsta-prod."));

  // A profile nobody matched carries no link, and neither does any row when the
  // map is absent: the map is warm-only, and before anyone has opened Hosting
  // Sites in this process it is empty. That is the page refusing to open with a
  // round trip to every hosting API in order to draw a cross-reference.
  assert.ok(!withLinks.includes('href="/sites?profile=kinsta-staging"'));
  assert.equal(withLinks.split('href="/sites').length - 1, 1);
  const cold = renderSiteProfiles({ listing: LISTING }).markup;
  assert.ok(!cold.includes('href="/sites'));
});

test("15: the list route reads the link map warm and never triggers a listing", async () => {
  // The fixture's hosting registry is empty, so nothing is ever warm — which is
  // exactly the cold case: the rows render, with no back-link and no attempt to
  // go and find one.
  const { server, calls } = await fixture();
  const markup = (await sse(server, authorized(LIST))).find("cli-sites").markup;
  assert.ok(markup.includes("<article>"));
  assert.ok(!markup.includes('href="/sites'));
  assert.deepEqual(calls, ["list"]);
});
