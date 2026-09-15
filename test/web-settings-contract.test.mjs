// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Settings page's update card and the two `/_dashboard/updates/*` routes.
 *
 * The port of Go's `renderUpdateCard`, `handleDashboardUpdateCheck` and
 * `handleDashboardUpdateInstall`, plus the assertions Go's version would have
 * failed:
 *
 * - Go's install handler accepted the mutation token **out of the posted JSON
 *   body** when the header was absent (`authorizedDashboardAction`,
 *   server.go:598-600). That is exactly the form a cross-origin form post can
 *   produce. HQ's dispatcher is header-only, and case 5 pins it: a body carrying
 *   the correct token and no header is still a `403`.
 * - Go rendered the update card's `Err` field from `err.Error()`, verbatim, and
 *   rendered a `Release notes` anchor to an external origin. HQ renders a
 *   bounded `CliError` message and no external link at all.
 * - Go interpolated the installer's model into the page; HQ discards the
 *   installer's output entirely, which case 7 proves with a child that prints
 *   `<script>`.
 *
 * Fully offline and socket-free: `dispatch` takes a plain request and returns a
 * plain response, and both update operations are scripted functions — the
 * dashboard declares them structurally and never imports `src/update/`.
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
import { CliError } from "../dist/errors.js";
import {
  createDashboardServer,
  renderUpdateCard,
  DEFERRED_ROUTES,
  SSE_PATCH_FRAGMENTS,
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

async function fixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-settings-"));
  roots.push(home);
  const environment = { NOVAMIRA_HQ_HOME: home };
  const paths = platformPaths(environment, process.platform, home);
  const security = defaultFileSecurity();
  await atomicWriteFile(
    paths.configFile,
    JSON.stringify({ version: 1, hostingProfiles: {}, pushes: {} }),
    security,
  );
  const store = new ConfigStore(
    paths.configFile,
    new ProfileLockManager(paths.stateDir, security),
    security,
  );

  const calls = [];
  const server = createDashboardServer({
    version: "0.1.0-test",
    paths,
    store,
    hosting: {
      clientFromProfile: () => {
        throw new Error("the settings suite must not reach a provider");
      },
    },
    credentials: async () => {
      throw new Error("the settings suite must not build a credential store");
    },
    environment,
    fetch: async () => {
      throw new Error("the settings suite makes no outbound request");
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
      throw new Error("the settings suite runs no doctor report");
    },
    updates: {
      check: async () => {
        calls.push("check");
        if (options.checkThrows !== undefined) throw options.checkThrows;
        return (
          options.status ?? {
            current: "0.1.0-test",
            latest: "0.1.0-test",
            updateAvailable: false,
            checkedAt: "2023-11-14T22:13:20.000Z",
            registry: "https://registry.npmjs.org",
          }
        );
      },
      install: async () => {
        calls.push("install");
        if (options.installThrows !== undefined) throw options.installThrows;
        return (
          options.installResult ?? {
            updated: true,
            from: "0.1.0-test",
            to: "9.9.9",
            command:
              "npm install --global --ignore-scripts --registry https://registry.npmjs.org @novamira/hq@9.9.9",
          }
        );
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
    body: async () => options.body ?? "",
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
      patchSignals() {},
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

async function page(server, path) {
  const response = await server.dispatch(request(path));
  assert.equal(response.kind, "html", path);
  assert.equal(response.status, 200, path);
  return response.body.markup;
}

/* -------------------------------------------------------------------------- */
/* 1-3: the page and its wiring                                               */
/* -------------------------------------------------------------------------- */

test("Settings tabs isolate updates and uninstall instructions", async () => {
  const { server } = await fixture();
  for (const path of [
    "/settings",
    "/settings?tab=general",
    "/settings?tab=invalid",
  ]) {
    const markup = await page(server, path);
    assert.ok(markup.includes("Configuration file"));
    assert.ok(!markup.includes('id="updates-card"'));
    assert.ok(!markup.includes("npm uninstall"));
    assert.ok(markup.includes('aria-current="page"'));
  }
  const uninstall = await page(server, "/settings?tab=uninstall");
  assert.ok(uninstall.includes("npm uninstall -g @novamira/cli"));
  assert.ok(!uninstall.includes('id="updates-card"'));
  assert.ok(!uninstall.includes("Configuration file"));
});

test("1: the page renders the catalogued card and its self-check", async () => {
  const { server } = await fixture();
  const markup = await page(server, "/settings?tab=updates");

  assert.ok(
    SSE_PATCH_FRAGMENTS.some(
      (fragment) =>
        fragment.selectorId === "updates-card" && fragment.mode === "outer",
    ),
  );
  assert.ok(markup.includes('id="updates-card"'));
  assert.ok(markup.includes("Software updates"));
  // Before the first check the pill says so, and the only detail row is the
  // version this process knows about — nothing is invented.
  assert.ok(markup.includes(">Checking…<"));
  assert.ok(markup.includes("Current version"));
  assert.ok(!markup.includes("Latest version"));
  // No install button until something is available to install.
  assert.ok(!markup.includes("Install update"));

  // The self-check on first render is silent.
  assert.ok(markup.includes("/_dashboard/updates/check?silent=true"));

  // Go's copy named GitHub Releases and an in-place replacement; neither is true.
  assert.ok(!markup.includes("GitHub"));
  assert.ok(!markup.includes("in place"));
  assert.ok(markup.includes("npm registry"));
  // Go's panel copy said "hosting and site profiles"; HQ has no site profiles.
  assert.ok(!markup.includes("and site profiles"));
});

test("2: every data- attribute comes from a helper, and no link leaves the origin", async () => {
  const { server } = await fixture();
  const markup = await page(server, "/settings?tab=updates");
  const card = markup.slice(markup.indexOf('id="updates-card"'), markup.length);

  const names = [...card.matchAll(/\s(data-[a-z:_-]+)="/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    new Set(names),
    new Set([
      "data-init",
      "data-indicator",
      "data-attr",
      "data-on:click",
      "data-class",
    ]),
  );

  // The self-check's scope matches nothing: a `@get`'s signals land in the URL,
  // and this card needs none of them.
  assert.ok(card.includes("filterSignals: {include: /(?!)/}"));
  assert.ok(!card.includes("providerForm"));
  // The token travels in the header on a `@get`, never in the query string.
  assert.ok(card.includes("{&quot;X-Novamira-Dashboard-Token&quot;: $token}"));

  // The disabled predicate is built by `or`, not hand-written.
  assert.ok(
    card.includes("disabled: ($updates.loading || $updates.installing)"),
  );

  // Go rendered a `Release notes` anchor to an external origin; the dashboard's
  // CSP is `default-src 'self'` and `hrefAttr` only takes a site-relative Url.
  assert.ok(!/href="[a-z]+:/i.test(markup));
  assert.ok(!markup.includes("Release notes"));
  assert.ok(!markup.includes("Update asset"));
});

test("3: both routes left DEFERRED_ROUTES; install is POST-only and token-guarded", async () => {
  assert.deepEqual([...DEFERRED_ROUTES], []);

  const { server, calls } = await fixture();
  for (const [method, path] of [
    ["GET", "/_dashboard/updates/check"],
    ["POST", "/_dashboard/updates/install"],
  ]) {
    const unauthorized = await server.dispatch(request(path, { method }));
    assert.equal(unauthorized.status, 403, path);
    assert.equal(unauthorized.envelope.ok, false);
    assert.equal(
      unauthorized.envelope.error.message,
      "The dashboard mutation token is missing or invalid.",
    );
    assert.equal(unauthorized.envelope.error.details, undefined);
  }

  // `install` is POST-only: a GET is a 405 with an `Allow`, not a 404.
  const wrongMethod = await server.dispatch(
    authorized("/_dashboard/updates/install"),
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.Allow, "POST");

  // Nothing above reached the update service.
  assert.deepEqual(calls, []);
});

/* -------------------------------------------------------------------------- */
/* 4-5: the check route                                                       */
/* -------------------------------------------------------------------------- */

test("4: check patches the card then the toast, and ?silent= only mutes the good news", async () => {
  const upToDate = await fixture();
  const plain = await sse(
    upToDate.server,
    authorized("/_dashboard/updates/check"),
  );
  assert.deepEqual(plain.recorder.order, ["updates-card/outer", "toast/outer"]);
  assert.ok(
    plain.recorder.find("toast").markup.includes("Novamira HQ is up to date."),
  );
  const card = plain.recorder.find("updates-card").markup;
  assert.ok(card.includes('id="updates-card"'));
  assert.ok(card.includes(">up to date<"));
  assert.ok(card.includes("registry.npmjs.org"));
  // Checked, so no `data-init`: the card must not re-check on every repaint.
  assert.ok(!card.includes("data-init"));
  assert.ok(!card.includes("Install update"));

  const silent = await sse(
    upToDate.server,
    authorized("/_dashboard/updates/check?silent=true"),
  );
  assert.deepEqual(silent.recorder.order, [
    "updates-card/outer",
    "toast/outer",
  ]);
  // The toast element is still patched — it is how a previous toast is cleared
  // — but it carries no message.
  assert.ok(!silent.recorder.find("toast").markup.includes("up to date"));

  // "Update available" is never silenced: opening Settings should not toast at
  // you, but it must still tell you there is an update.
  const available = await fixture({
    status: {
      current: "0.1.0-test",
      latest: "9.9.9",
      updateAvailable: true,
      checkedAt: "2023-11-14T22:13:20.000Z",
      registry: "https://registry.npmjs.org",
    },
  });
  const quiet = await sse(
    available.server,
    authorized("/_dashboard/updates/check?silent=true"),
  );
  assert.ok(
    quiet.recorder
      .find("toast")
      .markup.includes("Novamira HQ 9.9.9 is available."),
  );
  const offer = quiet.recorder.find("updates-card").markup;
  assert.ok(offer.includes(">update available<"));
  assert.ok(offer.includes("Install update"));
  // The confirm names the exact target version.
  assert.ok(
    offer.includes("Install Novamira HQ 9.9.9? Restart the dashboard"),
    offer,
  );
});

test("5: a failed check is a bounded danger notice carrying no details", async () => {
  const { server } = await fixture({
    checkThrows: new CliError("network_error", `${"x".repeat(400)} boom`, {
      details: { secret: "must-not-be-rendered" },
    }),
  });
  const { recorder } = await sse(
    server,
    authorized("/_dashboard/updates/check"),
  );
  assert.deepEqual(recorder.order, ["updates-card/outer", "toast/outer"]);
  assert.ok(recorder.find("toast").markup.includes("Update check failed."));
  const card = recorder.find("updates-card").markup;
  assert.ok(card.includes(">check failed<"));
  // The message is truncated, and `details` reach nothing: `redact()` runs on
  // the JSON path only, and a patched card bypasses it entirely.
  assert.ok(!card.includes("must-not-be-rendered"));
  assert.ok(card.includes("…"));
  assert.ok(card.length < 4000, "the card rendered an unbounded message");

  // Silent mode mutes the failure toast too.
  const silent = await sse(
    server,
    authorized("/_dashboard/updates/check?silent=true"),
  );
  assert.ok(!silent.recorder.find("toast").markup.includes("failed"));
});

/* -------------------------------------------------------------------------- */
/* 6-8: the install route                                                     */
/* -------------------------------------------------------------------------- */

test("6: a signal-only token is still a 403 — Go's body fallback is not ported", async () => {
  const { server, calls } = await fixture();
  const body = JSON.stringify({ token: TOKEN });
  const response = await server.dispatch(
    request("/_dashboard/updates/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(
    response.envelope.error.message,
    "The dashboard mutation token is missing or invalid.",
  );
  // The handler never ran, so nothing was installed by a cross-origin form post.
  assert.deepEqual(calls, []);
});

test("7: a successful install renders the command and never the installer's output", async () => {
  const { server, calls } = await fixture({
    installResult: {
      updated: true,
      from: "0.1.0-test",
      to: "9.9.9",
      command:
        "npm install --global --ignore-scripts --registry https://registry.npmjs.org @novamira/hq@9.9.9",
    },
  });
  const { recorder } = await sse(
    server,
    authorized("/_dashboard/updates/install", { method: "POST" }),
  );
  assert.deepEqual(calls, ["install"]);
  assert.deepEqual(recorder.order, ["updates-card/outer", "toast/outer"]);
  assert.ok(
    recorder
      .find("toast")
      .markup.includes(
        "Update installed. Restart the dashboard to use the new version.",
      ),
  );
  const card = recorder.find("updates-card").markup;
  assert.ok(card.includes("@novamira/hq@9.9.9"));
  assert.ok(card.includes("--ignore-scripts"));
  // The installer's own stdout never crosses the `DashboardUpdates` boundary,
  // so a package that echoed markup cannot reach the DOM.
  assert.ok(!card.includes("<script"));
  assert.ok(!card.includes("added 1 package"));
});

test("8: install reports already-up-to-date and a failure without leaking details", async () => {
  const uptodate = await fixture({
    installResult: {
      updated: false,
      from: "0.1.0-test",
      to: "0.1.0-test",
      command: "",
    },
  });
  const ok = await sse(
    uptodate.server,
    authorized("/_dashboard/updates/install", { method: "POST" }),
  );
  assert.ok(
    ok.recorder
      .find("toast")
      .markup.includes("Novamira HQ is already up to date."),
  );
  // No command row: nothing ran, so there is nothing to show.
  assert.ok(!ok.recorder.find("updates-card").markup.includes("Command"));

  const broken = await fixture({
    installThrows: new CliError("internal_error", "npm exited with status 7", {
      details: { argv: ["--registry", "https://token@example.com"] },
    }),
  });
  const failed = await sse(
    broken.server,
    authorized("/_dashboard/updates/install", { method: "POST" }),
  );
  assert.deepEqual(failed.recorder.order, [
    "updates-card/outer",
    "toast/outer",
  ]);
  assert.ok(
    failed.recorder.find("toast").markup.includes("Update install failed."),
  );
  const card = failed.recorder.find("updates-card").markup;
  assert.ok(card.includes("npm exited with status 7"));
  assert.ok(!card.includes("token@example.com"));
});

/* -------------------------------------------------------------------------- */
/* 9: the renderer in isolation                                               */
/* -------------------------------------------------------------------------- */

test("9: the card escapes what it renders and omits every absent row", async () => {
  const escaped = renderUpdateCard({
    checked: true,
    current: "1.0.0",
    updateAvailable: false,
    error: "<script>alert(1)</script>",
  }).markup;
  assert.ok(!escaped.includes("<script>"));
  assert.ok(escaped.includes("&lt;script&gt;"));
  // Absent fields render no row at all rather than an empty one.
  for (const label of ["Latest version", "Checked", "Registry", "Command"])
    assert.ok(!escaped.includes(label), label);
  assert.ok(escaped.includes("Current version"));

  const full = renderUpdateCard({
    checked: true,
    current: "1.0.0",
    latest: "2.0.0",
    updateAvailable: true,
    checkedAt: "2023-11-14T22:13:20.000Z",
    registry: "https://registry.npmjs.org",
    installed: true,
    command: "npm install --global @novamira/hq@2.0.0",
  }).markup;
  for (const label of [
    "Current version",
    "Latest version",
    "Checked",
    "Registry",
    "Command",
  ])
    assert.ok(full.includes(label), label);
  // The outer fragment's root carries its own id (conventions rule 30).
  assert.match(full, /^<section[^>]*\sid="updates-card"/);
});
