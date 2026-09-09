// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Novamira-setup page, the job registry and the two `/_dashboard/setup/*`
 * routes.
 *
 * The port of Go's setup cases in `internal/dashboard/server_test.go`, plus the
 * boundary-rule assertions Go could not make: the page never says "application
 * password" or "site profile", the result block renders the `novamira auth
 * login` handoff instead of a saved credential, and the failure block renders
 * `code: message` without `CliError.details`.
 *
 * Fully offline and socket-free. The provider is a recording fake keyed by
 * WP-CLI command line; the three outbound non-provider requests
 * (`novamira-latest` release metadata, the source HEAD, and the one
 * unauthenticated compatibility read) go to an injected `fetch` double. Nothing
 * in this file contacts a provider, a registry or a site.
 *
 * The progress stream doubles as the suite's synchronisation primitive: the job
 * runs detached from the request that started it, and
 * `GET …/jobs/<id>/stream` is exactly "return when this job stops running".
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
import { PROTECTED_RESOURCE_PATH } from "../dist/provisioning/compatibility.js";
import { PHP_VERSION_COMMAND } from "../dist/provisioning/phpcompat.js";
import { EXISTING_NOVAMIRA_COMMAND } from "../dist/provisioning/existing.js";
import { NOVAMIRA_LATEST_RELEASE_API } from "../dist/provisioning/plugin.js";
import {
  createDashboardServer,
  createSetupJobService,
} from "../dist/web/index.js";

const TOKEN = "d".repeat(64);
const TOKEN_HEADER = "x-novamira-dashboard-token";
const START = 1_700_000_000_000;
const SITE_URL = "https://example.com";
const ZIP_URL = "https://downloads.invalid/novamira.zip";

const roots = [];
const servers = [];

test.after(async () => {
  for (const server of servers) await server.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* The provider double                                                        */
/* -------------------------------------------------------------------------- */

/** WP-CLI stdout for one command line; anything unscripted answers empty. */
function wpAnswer(command, phpVersion) {
  if (command === EXISTING_NOVAMIRA_COMMAND) return "[]";
  if (command === PHP_VERSION_COMMAND) return phpVersion;
  if (command === "wp option get siteurl") return SITE_URL;
  if (command === "wp option get home") return SITE_URL;
  if (command.startsWith("wp plugin status")) return "Status: Inactive";
  return "";
}

/**
 * A recording `ProviderClient`.
 *
 * `gate`, when present, is awaited before the **first** command answers, which
 * is what holds a job in `running` for as long as a test needs it to be.
 */
function fakeClient({ phpVersion = "8.2.12", gate } = {}) {
  const commands = [];
  return {
    provider: "kinsta",
    commands,
    wpCliResultsObservable: () => true,
    validate: async () => ({
      provider: "kinsta",
      status: "ok",
      companyId: null,
      credential: "env:KINSTA_API_KEY",
    }),
    listSites: async () => [],
    getSite: async () => ({}),
    listEnvironments: async () => [],
    read: async () => [],
    operationStatus: async () => ({
      provider: "kinsta",
      operationId: "op",
      status: 200,
      done: true,
      failed: false,
      raw: null,
    }),
    action: async (request) => {
      const command = request.body?.wp_command ?? "";
      if (gate !== undefined && commands.length === 0) await gate.promise;
      commands.push(command);
      return {
        provider: "kinsta",
        action: "wp-cli.run",
        status: 200,
        raw: { data: { result: wpAnswer(command, phpVersion) } },
      };
    },
  };
}

function deferred() {
  let release = () => undefined;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

function untilAborted(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The fetch double                                                           */
/* -------------------------------------------------------------------------- */

function httpResponse({ status = 200, body = "" } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
  };
}

const METADATA = {
  resource: `${SITE_URL}/wp-json/mcp/novamira-oauth`,
  authorization_servers: [SITE_URL],
  bearer_methods_supported: ["header"],
  scopes_supported: ["mcp"],
  novamira: {
    plugin_version: "1.11.1",
    rest_api_version: 1,
    wordpress_version: "6.9",
    minimum_wordpress_version: "6.9",
    features: {
      abilities_bearer_auth: true,
      agent_context: true,
      rest_skills: true,
      generalized_execution_shim: true,
    },
  },
};

/** Routes the three requests `provisionNovamira` makes and refuses the rest. */
function fakeFetch() {
  const calls = [];
  const impl = async (target, init = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${target}`);
    if (target === NOVAMIRA_LATEST_RELEASE_API) {
      return httpResponse({
        body: {
          tag_name: "v1.11.1",
          assets: [{ name: "novamira.zip", browser_download_url: ZIP_URL }],
        },
      });
    }
    if (target === ZIP_URL) return httpResponse();
    if (target === `${SITE_URL}${PROTECTED_RESOURCE_PATH}`)
      return httpResponse({ body: METADATA });
    throw new Error(`unexpected fetch ${method} ${target}`);
  };
  impl.calls = calls;
  return impl;
}

/* -------------------------------------------------------------------------- */
/* The server                                                                 */
/* -------------------------------------------------------------------------- */

const PROFILES = {
  dev: {
    provider: "kinsta",
    credential: { type: "env", name: "KINSTA_API_KEY" },
  },
};

async function fixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-setup-"));
  roots.push(home);
  const environment = {
    NOVAMIRA_HQ_HOME: home,
    KINSTA_API_KEY: "kinsta-fake-not-a-real-secret",
  };
  const paths = platformPaths(environment, process.platform, home);
  const security = defaultFileSecurity();
  await atomicWriteFile(
    paths.configFile,
    JSON.stringify({
      version: 1,
      hostingProfiles: options.hostingProfiles ?? PROFILES,
      deployPaths: {},
    }),
    security,
  );
  const store = new ConfigStore(
    paths.configFile,
    new ProfileLockManager(paths.stateDir, security),
    security,
  );

  const gate = options.gated === true ? deferred() : undefined;
  const client = fakeClient({
    ...(options.phpVersion === undefined
      ? {}
      : { phpVersion: options.phpVersion }),
    ...(gate === undefined ? {} : { gate }),
  });
  const hosting = createHostingClientFactory({
    store,
    registry: { kinsta: () => client },
    env: environment,
  });

  // A monotonic clock: two jobs started in the same millisecond would make
  // `latestForTarget` a coin flip.
  let tick = 0;
  const fetchDouble = fakeFetch();
  const server = createDashboardServer({
    version: "0.1.0-test",
    paths,
    store,
    hosting,
    credentials: async () => {
      throw new Error("this suite must not build a credential store");
    },
    environment,
    fetch: fetchDouble,
    now: () => START + tick++ * 1000,
    randomToken: () => TOKEN,
    ...(options.setupPollMs === undefined
      ? {}
      : { setupPollMs: options.setupPollMs }),
    integration: {
      connectionStates: async () => ({
        byKey: new Map(),
        checkedAt: START,
        cliAvailable: true,
      }),
      connect: async () => ({ kind: "connected" }),
    },
    doctor: async () => {
      throw new Error("the setup suite runs no doctor report");
    },
    updates: {
      check: async () => {
        throw new Error("the setup suite must not reach a package registry");
      },
      install: async () => {
        throw new Error("the setup suite must not run a package manager");
      },
    },
  });
  servers.push(server);
  return { server, client, gate, fetch: fetchDouble };
}

/* -------------------------------------------------------------------------- */
/* Request helpers                                                            */
/* -------------------------------------------------------------------------- */

function request(path, options = {}) {
  const target = new URL(path, "http://127.0.0.1:8787");
  return {
    method: options.method ?? "GET",
    path: decodeURIComponent(target.pathname),
    query: target.searchParams,
    headers: { host: "127.0.0.1:8787", ...options.headers },
    signal: options.signal ?? new AbortController().signal,
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

function startRequest(query = "profile=dev&env=env-1", signals = {}) {
  return authorized(`/_dashboard/setup/start?${query}`, {
    method: "POST",
    body: JSON.stringify({ token: TOKEN, ...signals }),
  });
}

/** The job id, read out of the running page's stream URL. */
function jobIdFrom(recorder) {
  const markup = recorder.find("main").markup;
  const match = /\/_dashboard\/setup\/jobs\/([0-9a-f]+)\/stream/.exec(markup);
  assert.ok(match, "the running page carries a stream URL");
  return match[1];
}

/** Drive the progress stream, which returns when the job stops running. */
async function drain(server, id) {
  const { recorder } = await sse(
    server,
    authorized(`/_dashboard/setup/jobs/${id}/stream`),
  );
  return recorder;
}

/* -------------------------------------------------------------------------- */
/* 1-2: the page                                                              */
/* -------------------------------------------------------------------------- */

test("1: the page is an empty state without a target and a work panel with one", async () => {
  const { server } = await fixture();

  const bare = await page(server, "/novamira-setup");
  assert.ok(
    bare.includes("Select an environment from Hosting Sites to start setup."),
  );
  assert.ok(!bare.includes('id="setup-work"'));

  const targeted = await page(
    server,
    "/novamira-setup?profile=dev&env=env-1&site=Example&envname=Live",
  );
  for (const want of [
    'id="setup-work"',
    'data-bind="setup.enableAiAbilities"',
    "Also enable AI Abilities on an existing installation",
    "Security note:",
    "When enabled, AI agents can execute PHP code",
    ">Start Setup</button>",
    // `&` inside a JavaScript string literal in an attribute is hardened to
    // `&` by `jsString`, so the query separator is not an entity here.
    "/_dashboard/setup/start?profile=dev\\u0026env=env-1",
    "<dt>Site</dt><dd>Example</dd>",
    "<dt>Environment</dt><dd>Live</dd>",
    "<dt>Hosting profile</dt><dd>dev</dd>",
    ">ready</span>",
  ])
    assert.ok(targeted.includes(want), want);
  // No job yet, so nothing streams and there is no Progress panel.
  assert.ok(!targeted.includes("/stream"));
  assert.ok(!targeted.includes("<h2>Progress</h2>"));
});

test("2: the page carries none of the deleted site-profile surface", async () => {
  const { server } = await fixture();
  const markup = await page(
    server,
    "/novamira-setup?profile=dev&env=env-1&site=Example",
  );
  for (const forbidden of [
    /application[-_ ]?password/i,
    /site profile/i,
    /Fix set up/i,
    /siteprofile/i,
    /replace=/i,
    /Replace saved direct site connection/i,
  ])
    assert.ok(!forbidden.test(markup), String(forbidden));
  // The action panel says what the run actually does, and says the connect
  // step is a separate one run with the site CLI.
  assert.ok(markup.includes("Connecting your agent is a separate step"));
  assert.ok(markup.includes("novamira auth login"));
});

/* -------------------------------------------------------------------------- */
/* 3-4: starting a job                                                        */
/* -------------------------------------------------------------------------- */

test("3: start runs provisionNovamira, records the job and repaints the page", async () => {
  const {
    server,
    client,
    fetch: outbound,
  } = await fixture({
    setupPollMs: 1,
  });
  const { recorder } = await sse(server, startRequest());
  assert.deepEqual(recorder.order, ["main/outer", "nav/outer", "toast/outer"]);
  assert.ok(recorder.find("toast").markup.includes("Novamira setup started."));
  const main = recorder.find("main").markup;
  assert.ok(main.includes('class="main main-novamira-setup"'));
  assert.ok(main.includes("<h2>Progress</h2>"));
  assert.ok(main.includes("Setup job started."));

  await drain(server, jobIdFrom(recorder));

  // The whole provisioning sequence ran, over the injected seams and nothing
  // else. `wp user application-password create` is not in this list and never
  // will be.
  assert.deepEqual(client.commands, [
    PHP_VERSION_COMMAND,
    EXISTING_NOVAMIRA_COMMAND,
    "wp option get siteurl",
    `wp plugin install ${ZIP_URL}`,
    "wp plugin status novamira",
    "wp plugin activate novamira",
    "wp option get home",
    "wp option update novamira_ai_abilities_enabled 1",
    "wp option update novamira_ai_abilities_domain example.com",
  ]);
  assert.deepEqual(outbound.calls, [
    `GET ${NOVAMIRA_LATEST_RELEASE_API}`,
    `HEAD ${ZIP_URL}`,
    `GET ${SITE_URL}${PROTECTED_RESOURCE_PATH}`,
  ]);
});

test("3b: a second start for a running target reuses the job and runs nothing", async () => {
  const { server, client, gate } = await fixture({
    gated: true,
    setupPollMs: 1,
  });
  const first = await sse(server, startRequest());
  const id = jobIdFrom(first.recorder);
  const second = await sse(server, startRequest());
  assert.equal(jobIdFrom(second.recorder), id);
  assert.equal(client.commands.length, 0, "the first run is still gated");

  gate.release();
  await drain(server, id);
  // One run's worth of commands, not two.
  assert.equal(client.commands[0], PHP_VERSION_COMMAND);
  assert.equal(
    client.commands.filter((command) => command === PHP_VERSION_COMMAND).length,
    1,
  );
});

test("3c: target reservation is atomic before hosting client resolution", async () => {
  const clientGate = deferred();
  const client = fakeClient();
  let resolutions = 0;
  let provisions = 0;
  const service = createSetupJobService({
    hosting: {
      clientFromProfile: async () => {
        resolutions += 1;
        await clientGate.promise;
        return client;
      },
    },
    environment: {},
    fetch: fakeFetch(),
    now: () => START,
    randomId: () => "a".repeat(32),
    provision: async ({ signal }) => {
      provisions += 1;
      return untilAborted(signal);
    },
  });

  const first = service.start({
    profile: "dev",
    envId: "env-1",
    aiAbilities: true,
  });
  const second = service.start({
    profile: "dev",
    envId: "env-1",
    aiAbilities: false,
  });
  assert.strictEqual(second, first);
  assert.equal(resolutions, 1);

  clientGate.release();
  assert.equal(await first, "a".repeat(32));
  assert.equal(await second, "a".repeat(32));
  assert.equal(provisions, 1);
  await service.shutdown();
});

test("3d: all-running setup capacity rejects new targets", async () => {
  let sequence = 0;
  const service = createSetupJobService({
    hosting: { clientFromProfile: async () => fakeClient() },
    environment: {},
    fetch: fakeFetch(),
    now: () => START + sequence,
    randomId: () => `${++sequence}`.padStart(32, "0"),
    maxJobs: 2,
    provision: ({ signal }) => untilAborted(signal),
  });

  await service.start({ profile: "dev", envId: "env-1", aiAbilities: true });
  await service.start({ profile: "dev", envId: "env-2", aiAbilities: true });
  await assert.rejects(
    service.start({ profile: "dev", envId: "env-3", aiAbilities: true }),
    (error) => error?.code === "conflict" && /capacity/.test(error.message),
  );
  await service.shutdown();
});

test("3e: shutdown owns a reservation still resolving its client", async () => {
  const clientGate = deferred();
  let provisions = 0;
  const service = createSetupJobService({
    hosting: {
      clientFromProfile: async () => {
        await clientGate.promise;
        return fakeClient();
      },
    },
    environment: {},
    fetch: fakeFetch(),
    now: () => START,
    provision: async () => {
      provisions += 1;
    },
  });

  const start = service
    .start({ profile: "dev", envId: "env-1", aiAbilities: true })
    .then(
      () => undefined,
      (error) => error,
    );
  let stopped = false;
  const shutdown = service.shutdown();
  void shutdown.then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "shutdown awaits the client reservation");

  clientGate.release();
  await shutdown;
  const error = await start;
  assert.equal(error?.code, "conflict");
  assert.equal(provisions, 0, "shutdown prevents a late launch");
  assert.equal(service.latestForTarget("dev", "env-1"), undefined);
});

test("3f: a failed reservation preserves completed job history", async () => {
  let sequence = 0;
  const service = createSetupJobService({
    hosting: {
      clientFromProfile: async (profile) => {
        if (profile === "bad") throw new Error("unreadable profile");
        return fakeClient();
      },
    },
    environment: {},
    fetch: fakeFetch(),
    now: () => START + sequence,
    randomId: () => `${++sequence}`.padStart(32, "0"),
    maxJobs: 1,
    provision: async () => ({}),
  });

  const id = await service.start({
    profile: "dev",
    envId: "env-1",
    aiAbilities: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.snapshot(id)?.status, "done");

  await assert.rejects(
    service.start({ profile: "bad", envId: "env-2", aiAbilities: true }),
    /unreadable profile/,
  );
  assert.equal(service.snapshot(id)?.status, "done");
  await service.shutdown();
});

test("3g: dashboard close cancels and awaits setup jobs", async () => {
  const { server, client, gate } = await fixture({
    gated: true,
    setupPollMs: 1,
  });
  await sse(server, startRequest());

  let closed = false;
  const firstClose = server.close();
  const secondClose = server.close();
  assert.strictEqual(secondClose, firstClose, "close is idempotent");
  void firstClose.then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, "close awaits the in-flight provider call");

  gate.release();
  await firstClose;
  assert.deepEqual(client.commands, [PHP_VERSION_COMMAND]);
  await assert.rejects(
    server.listen({ hostname: "127.0.0.1", port: 0 }),
    (error) => error?.code === "conflict",
  );

  const refused = await sse(server, startRequest("profile=dev&env=env-2"));
  assert.ok(refused.recorder.find("toast").markup.includes("danger"));
  assert.deepEqual(client.commands, [PHP_VERSION_COMMAND]);
});

test("4: new installs enable abilities even without an existing-site activation request", async () => {
  const off = await fixture({ setupPollMs: 1 });
  const started = await sse(
    off.server,
    startRequest("profile=dev&env=env-1", {
      setup: { enableAiAbilities: false },
    }),
  );
  await drain(off.server, jobIdFrom(started.recorder));
  assert.ok(
    off.client.commands.includes(
      "wp option update novamira_ai_abilities_enabled 1",
    ),
  );

  const on = await fixture({ setupPollMs: 1 });
  const kept = await sse(on.server, startRequest());
  await drain(on.server, jobIdFrom(kept.recorder));
  assert.ok(
    on.client.commands.includes(
      "wp option update novamira_ai_abilities_enabled 1",
    ),
  );
});

test("4b: an unknown profile is a danger notice and mints no job", async () => {
  const { server, client } = await fixture();
  const { recorder } = await sse(server, startRequest("profile=nope&env=e"));
  assert.ok(recorder.find("toast").markup.includes("danger"));
  assert.equal(client.commands.length, 0);
  // No job record: the page still offers Start Setup rather than a Progress
  // panel for a job that could never have run.
  assert.ok(!recorder.find("main").markup.includes("<h2>Progress</h2>"));
});

/* -------------------------------------------------------------------------- */
/* 5: failure                                                                 */
/* -------------------------------------------------------------------------- */

test("5: a PHP-too-old run is an error job with a humanized sentence", async () => {
  const { server } = await fixture({ phpVersion: "7.4.33", setupPollMs: 1 });
  const started = await sse(server, startRequest());
  const id = jobIdFrom(started.recorder);
  await drain(server, id);

  const markup = await page(server, `/novamira-setup?job=${id}`);
  assert.ok(markup.includes("<h2>Setup failed</h2>"));
  assert.ok(markup.includes('<div class="setup-failure-body">'));
  assert.ok(
    markup.includes(
      "The site isn&#39;t ready for Novamira yet. Update WordPress and the Novamira plugin, then try again.",
    ),
  );
  assert.ok(markup.includes("<summary>Technical details</summary>"));
  assert.ok(markup.includes("server_unsupported: Novamira setup requires PHP"));
  // `CliError.details` never reaches the page: `redact()` runs on the JSON
  // path only, and this is markup.
  assert.ok(!markup.includes("php.version"));
  assert.ok(markup.includes(">error</span>"));
});

/* -------------------------------------------------------------------------- */
/* 6-8: the job routes                                                        */
/* -------------------------------------------------------------------------- */

test("6: the job route patches setup-work outer, the stream patches it inner", async () => {
  const { server, gate } = await fixture({ gated: true, setupPollMs: 1 });
  const started = await sse(server, startRequest());
  const id = jobIdFrom(started.recorder);

  // The stream, driven across the whole run: one patch per *change*, never one
  // per tick, which is what stops a one-second repaint storm.
  const streaming = drain(server, id);
  gate.release();
  const recorder = await streaming;
  assert.ok(recorder.elements.length >= 1);
  for (const patch of recorder.elements) {
    assert.equal(patch.selectorId, "setup-work");
    assert.equal(patch.mode, "inner");
    // The inner fragment must not re-emit the wrapper: it carries the
    // `data-init` that opened this very stream.
    assert.ok(!patch.markup.includes('id="setup-work"'));
  }
  const markups = recorder.elements.map((patch) => patch.markup);
  assert.equal(new Set(markups).size, markups.length, "no repeated markup");

  // The one-shot route: outer, wrapper included, and no stream on a done job.
  const { recorder: once } = await sse(
    server,
    authorized(`/_dashboard/setup/jobs/${id}`),
  );
  assert.deepEqual(once.order, ["setup-work/outer"]);
  assert.ok(once.find("setup-work").markup.startsWith('<div id="setup-work"'));
  assert.ok(!once.find("setup-work").markup.includes("/stream"));
});

test("7: the stream returns when the client goes away", async () => {
  // A one-minute poll interval: a stream that ignored the abort would hang
  // this test rather than merely being slow.
  const { server, gate } = await fixture({ gated: true, setupPollMs: 60_000 });
  const started = await sse(server, startRequest());
  const id = jobIdFrom(started.recorder);

  const controller = new AbortController();
  const response = await server.dispatch(
    authorized(`/_dashboard/setup/jobs/${id}/stream`, {
      signal: controller.signal,
    }),
  );
  assert.equal(response.kind, "sse");
  const recorder = fakeSseStream();
  const running = response.run(recorder.stream);
  controller.abort();
  await running;
  assert.equal(recorder.elements.length, 1, "the first render still happened");

  gate.release();
});

test("8: an unknown or malformed job path is a JSON 404, not a stream", async () => {
  const { server } = await fixture();
  for (const path of [
    "/_dashboard/setup/jobs/deadbeef",
    "/_dashboard/setup/jobs/deadbeef/stream",
    "/_dashboard/setup/jobs/",
    "/_dashboard/setup/jobs/a/b",
  ]) {
    const response = await server.dispatch(authorized(path));
    assert.equal(response.kind, "json", path);
    assert.equal(response.status, 404, path);
    assert.equal(response.envelope.error.code, "not_found", path);
  }
});

/* -------------------------------------------------------------------------- */
/* 9-10: the result block and the guards                                      */
/* -------------------------------------------------------------------------- */

test("9: a finished job renders the handoff and no site credential", async () => {
  const { server } = await fixture({ setupPollMs: 1 });
  const started = await sse(server, startRequest());
  await drain(server, jobIdFrom(started.recorder));

  const markup = await page(server, "/novamira-setup?profile=dev&env=env-1");
  for (const want of [
    "<h2>Novamira installed</h2>",
    "https://example.com",
    "<dt>Plugin</dt>",
    "novamira 1.11.1 · Activated: yes",
    "<dt>AI Abilities</dt>",
    "enabled · locked to example.com",
    "supported · WordPress 6.9 · Novamira 1.11.1 · REST v1",
    "<dt>Ready</dt><dd>yes</dd>",
    "Connect your agent with the Novamira site CLI:",
    "novamira auth login https://example.com",
    ">done</span>",
  ])
    assert.ok(markup.includes(want), want);
  for (const forbidden of [
    "REST URL",
    "<dt>Username</dt>",
    "<dt>Credential</dt>",
    "<dt>Config</dt>",
    "Saved Site Profile",
  ])
    assert.ok(!markup.includes(forbidden), forbidden);
});

test("9b: an unknown ?job= is a danger notice, not a fabricated job", async () => {
  const { server } = await fixture();
  const markup = await page(server, "/novamira-setup?job=nosuchjob");
  assert.ok(markup.includes("Setup job not found."));
  assert.ok(markup.includes("<dt>Job</dt><dd>nosuchjob</dd>"));
  assert.ok(markup.includes("Waiting for progress."));
});

test("10: both routes refuse a missing or wrong token", async () => {
  const { server } = await fixture();
  for (const [method, path] of [
    ["POST", "/_dashboard/setup/start?profile=dev&env=env-1"],
    ["GET", "/_dashboard/setup/jobs/whatever"],
    ["GET", "/_dashboard/setup/jobs/whatever/stream"],
  ]) {
    for (const headers of [{}, { [TOKEN_HEADER]: "9".repeat(64) }]) {
      const response = await server.dispatch(
        request(path, { method, headers, body: JSON.stringify({}) }),
      );
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.envelope.error.code, "usage_error");
    }
  }
});
