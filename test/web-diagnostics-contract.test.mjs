// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Diagnostics page and the two `/_dashboard/diagnostics/*` routes.
 *
 * The port of Go's `handleDashboardDoctor` / `handleDashboardCapabilities` cases,
 * plus the assertions Go's version would have failed:
 *
 * - Go's Health check button emitted **no `filterSignals` scope at all**, so the
 *   Datastar client serialized the whole signal store into `?datastar=` —
 *   including `providerForm.credentialValue`, the one signal that can hold a
 *   provider secret. HQ's `get()` always emits a scope, and the doctor button's
 *   is `/(?!)/`, "match nothing".
 * - Go left both routes unauthenticated. Both are token-guarded here, and
 *   `createRouteTable` refuses to build a table where they are not.
 * - Go rendered failures with `Level: "error"`, which was not one of the levels
 *   `statusClass` knew, so every diagnostics failure was styled `neutral`.
 *
 * Fully offline and socket-free. The doctor runner is a scripted function — the
 * dashboard declares it structurally and never imports `src/doctor/` — and the
 * provider is a recording fake, so nothing here reaches a provider API.
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
import {
  createDashboardServer,
  DEFERRED_ROUTES,
  SSE_PATCH_FRAGMENTS,
} from "../dist/web/index.js";

const TOKEN = "e".repeat(64);
const TOKEN_HEADER = "x-novamira-dashboard-token";
const NOW = 1_700_000_000_000;

const PROFILES = {
  dev: {
    provider: "kinsta",
    credential: { type: "env", name: "KINSTA_API_KEY" },
  },
  other: {
    provider: "instawp",
    credential: { type: "env", name: "INSTAWP_API_KEY" },
  },
};

const CAPABILITIES = [
  { name: "sites.list", supported: true },
  {
    name: "provider.internal-operation",
    supported: true,
    notes: "provider-native only",
  },
  { name: "wp-cli.run", supported: false, notes: "<not> supported" },
];

const roots = [];
const servers = [];

test.after(async () => {
  for (const server of servers) await server.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* The fixture                                                                */
/* -------------------------------------------------------------------------- */

async function fixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-diagnostics-"));
  roots.push(home);
  const environment = {
    NOVAMIRA_HQ_HOME: home,
    KINSTA_API_KEY: "kinsta-fake-not-a-real-secret",
  };
  const paths = platformPaths(environment, process.platform, home);
  const security = defaultFileSecurity();
  await atomicWriteFile(
    paths.configFile,
    JSON.stringify({ version: 1, hostingProfiles: PROFILES, pushes: {} }),
    security,
  );
  const store = new ConfigStore(
    paths.configFile,
    new ProfileLockManager(paths.stateDir, security),
    security,
  );

  const reads = [];
  const registry = {
    kinsta: () => ({
      provider: "kinsta",
      validate: async () => ({ provider: "kinsta", status: "ok" }),
      read: async (request) => {
        reads.push(request.kind);
        if (options.providerThrows === true)
          throw new Error("the provider must not be reached here");
        return options.capabilities ?? CAPABILITIES;
      },
      action: async () => ({ provider: "kinsta", status: 200 }),
      operationStatus: async () => ({ provider: "kinsta", done: true }),
    }),
  };
  const hosting = createHostingClientFactory({
    store,
    registry,
    env: environment,
  });

  const doctorCalls = [];
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
      doctorCalls.push(NOW);
      if (options.doctorThrows === true)
        throw new Error("the scripted doctor refused");
      return (
        options.report ?? {
          version: 1,
          offline: true,
          fix: false,
          status: "warn",
          checks: [
            {
              id: "integration.site_cli",
              status: "warn",
              summary: "The Novamira site CLI is not installed.",
              evidence: { resolved: false, minimum: "1.0.0" },
            },
          ],
        }
      );
    },
    updates: {
      check: async () => {
        throw new Error("the diagnostics suite must not reach a registry");
      },
      install: async () => {
        throw new Error("the diagnostics suite must not run a package manager");
      },
    },
  });
  servers.push(server);
  return { server, reads, doctorCalls };
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

test("1: the page renders the patch target and two enabled buttons", async () => {
  const { server } = await fixture();
  const markup = await page(server, "/diagnostics");

  assert.ok(
    SSE_PATCH_FRAGMENTS.some(
      (fragment) =>
        fragment.selectorId === "diagnostics-output" &&
        fragment.mode === "outer",
    ),
  );
  assert.ok(markup.includes('id="diagnostics-output"'));
  assert.ok(markup.includes(">Select a diagnostic action.<"));

  // 6b rendered both buttons `disabled` with a fixed title; 7-1 turned them on.
  assert.ok(!markup.includes("Diagnostics arrive with the doctor service."));
  assert.ok(!/<button[^>]*disabled/.test(markup));

  // Both profiles are offered, and nothing is preselected.
  assert.ok(markup.includes(">dev (Kinsta)<"));
  assert.ok(markup.includes('<option value="" disabled selected>'));
});

test("2: every data- attribute comes from a helper, and the two scopes are right", async () => {
  const { server } = await fixture();
  const markup = await page(server, "/diagnostics");
  const section = markup.slice(markup.indexOf("<h1>Diagnostics</h1>"));

  const names = [...section.matchAll(/\s(data-[a-z:_-]+)="/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(new Set(names), new Set(["data-bind", "data-on:click"]));

  // The capabilities button carries Go's intended regex, built by `includeScope`
  // from the path `diagnostics` rather than typed out at the call site.
  assert.ok(
    section.includes("filterSignals: {include: /^(diagnostics)(\\.|$)/}"),
    "the capabilities scope is the diagnostics subtree",
  );
  // The doctor button's scope matches nothing. Go emitted none at all, which
  // sent the entire signal store — credential field included — in the URL.
  assert.ok(section.includes("filterSignals: {include: /(?!)/}"));
  assert.ok(!section.includes("providerForm"));
  // The token travels in the header on a `@get`, never in the query string.
  assert.ok(
    section.includes("{&quot;X-Novamira-Dashboard-Token&quot;: $token}"),
  );
  assert.ok(!/include: \/\^\(token/.test(section));
});

test("3: the two routes left DEFERRED_ROUTES, are GET-only and token-guarded", async () => {
  const paths = [
    "/_dashboard/diagnostics/doctor",
    "/_dashboard/diagnostics/capabilities",
  ];
  assert.deepEqual(
    DEFERRED_ROUTES.filter((entry) => paths.includes(entry.path)),
    [],
  );
  const { server } = await fixture();
  for (const path of paths) {
    const unauthorized = await server.dispatch(request(path));
    assert.equal(unauthorized.status, 403, path);
    assert.equal(unauthorized.envelope.ok, false);
    assert.equal(
      unauthorized.envelope.error.message,
      "The dashboard mutation token is missing or invalid.",
    );
    assert.equal(unauthorized.envelope.error.details, undefined);

    const wrongMethod = await server.dispatch(
      authorized(path, { method: "POST" }),
    );
    assert.equal(wrongMethod.status, 405, path);
    assert.equal(wrongMethod.headers.Allow, "GET", path);
  }
});

/* -------------------------------------------------------------------------- */
/* 4-5: GET /_dashboard/diagnostics/doctor                                    */
/* -------------------------------------------------------------------------- */

test("4: the doctor route patches the panel then the toast, with pretty JSON", async () => {
  const { server, doctorCalls } = await fixture();
  const { recorder } = await sse(
    server,
    authorized("/_dashboard/diagnostics/doctor"),
  );
  assert.equal(doctorCalls.length, 1);
  assert.deepEqual(recorder.order, ["diagnostics-output/outer", "toast/outer"]);

  const panel = recorder.find("diagnostics-output").markup;
  assert.ok(panel.startsWith('<div id="diagnostics-output"'));
  assert.ok(panel.includes('<pre class="code-output">'));
  // Two-space indentation, and the report verbatim.
  assert.ok(panel.includes("&quot;integration.site_cli&quot;"));
  assert.ok(panel.includes("\n  &quot;version&quot;: 1,"));
  assert.ok(panel.includes("notice ok"));
  assert.ok(recorder.find("toast").markup.includes("Doctor report generated."));

  // Escaped, not injected: the report is text inside a `<pre>`.
  assert.ok(!panel.includes("<script"));
});

test("5: a failing doctor is a danger notice with the message only", async () => {
  const { server } = await fixture({ doctorThrows: true });
  const { recorder } = await sse(
    server,
    authorized("/_dashboard/diagnostics/doctor"),
  );
  assert.deepEqual(recorder.order, ["diagnostics-output/outer", "toast/outer"]);
  const panel = recorder.find("diagnostics-output").markup;
  // Go used `Level: "error"`, which `statusClass` did not know, so the failure
  // rendered `neutral`. HQ uses one of the four members and it is styled.
  assert.ok(panel.includes("notice danger"));
  assert.ok(!panel.includes("<pre"));
  assert.ok(recorder.find("toast").markup.includes("toast show danger"));
});

/* -------------------------------------------------------------------------- */
/* 6-8: GET /_dashboard/diagnostics/capabilities                              */
/* -------------------------------------------------------------------------- */

test("6: no profile, and __all__, refuse without touching a provider", async () => {
  const { server, reads } = await fixture({ providerThrows: true });
  for (const query of [
    "",
    "?profile=",
    "?profile=__all__",
    `?datastar=${encodeURIComponent(JSON.stringify({ diagnostics: { profile: "__all__" } }))}`,
  ]) {
    const { recorder } = await sse(
      server,
      authorized(`/_dashboard/diagnostics/capabilities${query}`),
    );
    assert.deepEqual(
      recorder.order,
      ["diagnostics-output/outer", "toast/outer"],
      query,
    );
    const panel = recorder.find("diagnostics-output").markup;
    assert.ok(panel.includes("Select one provider profile first."), query);
    assert.ok(panel.includes("notice danger"), query);
    assert.ok(!panel.includes("<pre"), query);
  }
  assert.deepEqual(reads, []);
});

test("7: a selected profile omits operations outside HQ's surface", async () => {
  const { server, reads } = await fixture();

  // The posted signal wins over `?profile=`, which is Go's precedence.
  const signals = encodeURIComponent(
    JSON.stringify({ diagnostics: { profile: "dev" } }),
  );
  const { recorder } = await sse(
    server,
    authorized(
      `/_dashboard/diagnostics/capabilities?profile=other&datastar=${signals}`,
    ),
  );
  assert.deepEqual(reads, ["capabilities"]);
  const panel = recorder.find("diagnostics-output").markup;
  assert.ok(
    recorder.find("toast").markup.includes("Capabilities loaded for dev."),
  );

  // The dashboard applies the same visibility policy as CLI and MCP.
  const decoded = panel
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  const document = JSON.parse(
    decoded.slice(decoded.indexOf("["), decoded.lastIndexOf("]") + 1),
  );
  assert.equal(
    document.some((entry) => entry.name === "provider.internal-operation"),
    false,
  );

  // A provider note containing markup is text, not markup.
  assert.ok(!panel.includes("<not>"));
  assert.ok(panel.includes("&lt;not&gt; supported"));
});

test("8: an unknown profile is a danger notice carrying the message alone", async () => {
  const { server } = await fixture();
  const { recorder } = await sse(
    server,
    authorized("/_dashboard/diagnostics/capabilities?profile=nope"),
  );
  assert.deepEqual(recorder.order, ["diagnostics-output/outer", "toast/outer"]);
  const panel = recorder.find("diagnostics-output").markup;
  assert.ok(panel.includes("notice danger"));
  assert.ok(!panel.includes("<pre"));
  // `CliError.details` never reaches a notice: the JSON path's redaction does
  // not run here, so the message is all that may be rendered.
  assert.ok(!panel.includes("profiles"));
});
