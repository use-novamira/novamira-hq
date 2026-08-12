// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Hosting Providers page and its three routes.
 *
 * This is the port of the provider half of Go's `server_test.go` — the
 * onboarding page, the form's fields, the table's columns, the details row, the
 * three handlers and their patch sets — plus the assertions Go had no way to
 * make, because Go stored the provider credential in plaintext in its config
 * file: that the secret reaches the credential store, that `config.json` holds
 * only a `stored:` reference, and that the value appears in **no** rendered
 * page, SSE frame, URL or envelope.
 *
 * Fully offline and socket-free. Pages come from `server.dispatch`, which
 * returns a plain response; SSE handlers are driven through a recording stream
 * that never touches a socket. The one route that reaches a provider —
 * `providers/validate` — is given an injected registry whose client is a fake,
 * so no provider endpoint is contacted, ever.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import { credentialId } from "../dist/credentials/store.js";
import { createHostingClientFactory } from "../dist/hosting/factory.js";
import { createDashboardServer } from "../dist/web/index.js";
import { connCellId } from "../dist/web/patches.js";

const TOKEN = "d".repeat(64);
const TOKEN_HEADER = "x-novamira-dashboard-token";

/**
 * The value under test in every credential case. Obvious, and long enough that
 * a substring search cannot match it by accident.
 */
const SECRET = "sk-live-dashboard-provider-secret-not-a-real-key";

const NOW = 1_700_000_000_000;

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

const roots = [];
const servers = [];

test.after(async () => {
  for (const server of servers) await server.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A provider client that answers locally. Nothing here makes a request. */
function fakeProviderClient(behaviour = {}) {
  return {
    provider: "kinsta",
    validate: async () => {
      if (behaviour.validateError !== undefined) throw behaviour.validateError;
      return {
        provider: "kinsta",
        status: "ok",
        companyId: "company-1",
        credential: "stored:fake",
      };
    },
    listSites: async () => [],
    getSite: async () => ({}),
    listEnvironments: async () => [],
    read: async () => [],
    action: async () => ({}),
    operationStatus: async () => ({}),
  };
}

async function fixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-providers-"));
  roots.push(home);
  const environment = {
    NOVAMIRA_HQ_HOME: home,
    ...(options.environment ?? DEFAULT_ENVIRONMENT),
  };
  const paths = platformPaths(environment, process.platform, home);
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(
    paths.configFile,
    JSON.stringify(
      options.config ?? { version: 1, hostingProfiles: {}, deployPaths: {} },
    ),
  );
  const security = defaultFileSecurity();
  const store = new ConfigStore(
    paths.configFile,
    new ProfileLockManager(paths.stateDir, security),
    security,
  );
  // The credential store is forced onto the owner-only file backend rather than
  // the OS keychain: a contract test must not write to a developer's keyring.
  const { createCredentialStore } =
    await import("../dist/credentials/store.js");
  const { createCredentialResolver } =
    await import("../dist/credentials/resolve.js");
  const credentialsDir = join(paths.stateDir, "credentials");
  const credentials = async () =>
    createCredentialStore(credentialsDir, security, { preference: "file" });
  const hosting = createHostingClientFactory({
    store,
    // An injected registry: the only provider constructor in this suite is a
    // fake, so a real endpoint cannot be reached even by mistake.
    registry: {
      kinsta: () => fakeProviderClient(options.client ?? {}),
    },
    env: environment,
    // The same wiring `src/main.ts` gives the real factory, so a `stored:`
    // reference written by the save handler is readable by the validate one.
    resolver: {
      resolve: async (ref) =>
        createCredentialResolver({
          env: environment,
          store: await credentials(),
          security,
        }).resolve(ref),
    },
  });
  const server = createDashboardServer({
    version: "0.1.0-test",
    paths,
    store,
    hosting,
    credentials,
    environment,
    fetch: async () => {
      throw new Error("the providers suite must not make an outbound request");
    },
    now: () => NOW,
    randomToken: () => TOKEN,
    integration: {
      connectionStates: async () => {
        throw new Error("the providers page renders no connection state");
      },
      connect: async () => {
        throw new Error("the providers page runs no site CLI");
      },
    },
    doctor: async () => {
      throw new Error("the providers page runs no doctor report");
    },
    updates: {
      check: async () => {
        throw new Error(
          "the providers suite must not reach a package registry",
        );
      },
      install: async () => {
        throw new Error("the providers suite must not run a package manager");
      },
    },
    ...options.overrides,
  });
  servers.push(server);
  return { server, store, paths, credentialsDir, security };
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
 * A recording {@link SseStream}. Handlers are driven through it, so no socket is
 * bound and every patch is inspectable as a value.
 */
function fakeSseStream() {
  const elements = [];
  const signals = [];
  let closed = false;
  return {
    elements,
    signals,
    get closed() {
      return closed;
    },
    /** Everything the handler wrote, as one string, for a "contains" scan. */
    get body() {
      return [
        ...signals.map((value) => JSON.stringify(value)),
        ...elements.map((patch) => patch.markup),
      ].join("\n");
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
      close() {
        closed = true;
      },
    },
  };
}

/** Dispatch an SSE route and run it against a recording stream. */
async function sse(server, incoming) {
  const response = await server.dispatch(incoming);
  if (response.kind !== "sse") return { response, recorder: undefined };
  const recorder = fakeSseStream();
  await response.run(recorder.stream);
  return { response, recorder };
}

/**
 * The environment the fixture injects unless a case overrides it. `prod` uses an
 * `env` credential, so `credentialAvailable` is true and the connection cell
 * starts at "Not checked" rather than "No credential".
 */
const DEFAULT_ENVIRONMENT = { KINSTA_API_KEY: "kinsta-fake-key" };

const PROFILE_CONFIG = {
  version: 1,
  hostingProfiles: {
    prod: {
      provider: "kinsta",
      credential: { type: "env", name: "KINSTA_API_KEY" },
      companyId: "company-1",
      apiBaseUrl: "https://api.example.test/v2",
    },
  },
  deployPaths: {},
};

/* -------------------------------------------------------------------------- */
/* 1-5: the page                                                              */
/* -------------------------------------------------------------------------- */

test("1: with no profiles the page is the onboarding state, with one card", async () => {
  const { server } = await fixture();
  const markup = await page(server, "/providers");
  assert.ok(markup.includes('class="page onboarding"'));
  assert.equal(markup.split('class="onboard-card feat"').length - 1, 1);
  assert.ok(markup.includes("Let's connect your first hosting account"));
  assert.ok(markup.includes("Connect a host"));
  assert.ok(markup.includes('id="provider-flash"'));
  // The deleted card, and everything it implied.
  for (const gone of [
    "Connect a single site",
    "Single site",
    "site-name",
    "siteForm",
  ])
    assert.ok(!markup.includes(gone), gone);
  assert.ok(!/application[-_ ]?password/i.test(markup));
});

test("2: with profiles the form renders Go's four fields and no others", async () => {
  const { server } = await fixture({ config: PROFILE_CONFIG });
  const markup = await page(server, "/providers");
  for (const want of [
    ">Add Profile</button>",
    'data-class="{open: $providerForm.open}"',
    "Profile name",
    ">Credential</span>",
    "Company or account ID",
    "Kinsta company ID",
    "Paste the Rocket.net password.",
    ">Cancel</button>",
    'data-bind="providerForm.companyId"',
    'autocomplete="new-password"',
  ])
    assert.ok(markup.includes(want), want);
  // Fields Go never had. `force` is set by Edit alone.
  for (const gone of [
    "Credential env",
    "API base URL",
    "Overwrite if it exists",
    "providerForm.companyID",
    "providerForm.apiBaseURL",
  ])
    assert.ok(!markup.includes(gone), gone);
});

test("3: the table has Go's four columns and no invented ones", async () => {
  const { server } = await fixture({ config: PROFILE_CONFIG });
  const markup = await page(server, "/providers");
  assert.ok(markup.includes("<th>Connection</th>"));
  assert.ok(markup.includes("<th>Name</th>"));
  assert.ok(markup.includes("<th>Provider</th>"));
  for (const gone of [
    "<th>Credential</th>",
    "<th>Account</th>",
    "<th>Status</th>",
    "<th>Default</th>",
  ])
    assert.ok(!markup.includes(gone), gone);
  assert.ok(markup.includes(">Check connection</button>"));
  assert.ok(!markup.includes(">Validate</button>"));
  assert.ok(markup.includes("1 provider profiles"));
});

test("4: the table hides itself while the form is open, on both paints", async () => {
  const { server } = await fixture({ config: PROFILE_CONFIG });
  const closed = await page(server, "/providers");
  assert.ok(closed.includes('data-class="{hidden: $providerForm.open}"'));
  assert.ok(closed.includes('class="panel table-panel"'));
  assert.ok(closed.includes('class="panel form-panel ds-toggle"'));

  // `?new=host` opens the form server-side, so there is no first-paint flash.
  const open = await page(server, "/providers?new=host");
  assert.ok(open.includes('class="panel table-panel hidden"'));
  assert.ok(open.includes('class="panel form-panel ds-toggle open"'));
});

test("5: the details row renders the credential reference, never a value", async () => {
  const { server } = await fixture({ config: PROFILE_CONFIG });
  const markup = await page(server, "/providers");
  assert.ok(markup.includes(">Details</button>"));
  assert.ok(markup.includes("<dt>Credential storage</dt>"));
  assert.ok(markup.includes("env:KINSTA_API_KEY"));
  assert.ok(markup.includes("<dt>Account</dt>"));
  assert.ok(markup.includes("<dt>Base URL</dt>"));
  assert.ok(markup.includes("https://api.example.test/v2"));
  assert.ok(!markup.includes(SECRET));
  // The per-row signals are hex, so `a-b` and `ab` cannot share one.
  assert.match(markup, /\$details_[0-9a-f]+ = !\$details_[0-9a-f]+/);
  assert.match(markup, /data-indicator="checking_[0-9a-f]+"/);
});

/* -------------------------------------------------------------------------- */
/* 6-9: save                                                                  */
/* -------------------------------------------------------------------------- */

async function save(server, form, options = {}) {
  return sse(
    server,
    authorized("/_dashboard/providers/save", {
      body: JSON.stringify({ token: TOKEN, providerForm: form, ...options }),
    }),
  );
}

test("6: a posted credential reaches the store and nothing else, ever", async () => {
  const { server, store, paths, credentialsDir, security } = await fixture();
  const { recorder } = await save(server, {
    profile: "prod",
    provider: "kinsta",
    credentialValue: SECRET,
    companyId: "company-1",
    credentialEnv: "",
    apiBaseUrl: "",
    force: false,
  });

  // The configuration records a reference, never the value.
  const document = await store.load();
  assert.deepEqual(document.hostingProfiles.prod.credential, {
    type: "stored",
    id: credentialId({ provider: "kinsta", profile: "prod" }),
  });
  const raw = await readFile(paths.configFile, "utf8");
  assert.ok(!raw.includes(SECRET), "config.json must not hold the secret");

  // The credential store holds it.
  const { createCredentialStore } =
    await import("../dist/credentials/store.js");
  const credentials = await createCredentialStore(credentialsDir, security, {
    preference: "file",
  });
  const stored = await credentials.require(
    credentialId({ provider: "kinsta", profile: "prod" }),
  );
  assert.equal(stored.reveal(), SECRET);

  // The SSE response does not.
  assert.ok(!recorder.body.includes(SECRET), "no patch may carry the secret");
  assert.deepEqual(
    recorder.elements.map((patch) => `${patch.selectorId}/${patch.mode}`),
    ["main/outer", "nav/outer", "toast/outer"],
  );
  assert.equal(recorder.signals.length, 1);
  assert.equal(recorder.signals[0].providerForm.credentialValue, "");
  assert.equal(recorder.signals[0].providerForm.profile, "");
  assert.equal(recorder.signals[0].providerForm.provider, "kinsta");
  assert.ok(recorder.find("toast").markup.includes("Provider profile saved."));
  assert.ok(recorder.closed);

  // And neither does the re-rendered page.
  assert.ok(!(await page(server, "/providers")).includes(SECRET));
});

test("7: saving onto an existing name without force is Go's Edit notice", async () => {
  const { server } = await fixture({ config: PROFILE_CONFIG });
  const { recorder } = await save(server, {
    profile: "prod",
    provider: "kinsta",
    credentialValue: SECRET,
    credentialEnv: "",
    companyId: "",
    apiBaseUrl: "",
    force: false,
  });
  const toast = recorder.find("toast").markup;
  assert.ok(toast.includes("Open it in Edit"));
  assert.ok(toast.includes("danger"));
  // No signal patch on the failure path: the operator's values stay in the form.
  assert.equal(recorder.signals.length, 0);
  assert.ok(!recorder.body.includes(SECRET));
});

test("8: an omitted apiBaseUrl preserves the stored one and updates companyId", async () => {
  const { server, store } = await fixture({ config: PROFILE_CONFIG });
  await save(server, {
    profile: "prod",
    provider: "kinsta",
    credentialValue: "",
    credentialEnv: "",
    companyId: "company-2",
    apiBaseUrl: "",
    force: true,
  });
  const profile = (await store.load()).hostingProfiles.prod;
  assert.equal(profile.apiBaseUrl, "https://api.example.test/v2");
  assert.equal(profile.companyId, "company-2");
  // The credential is untouched by a submission that left the field empty.
  assert.deepEqual(profile.credential, {
    type: "env",
    name: "KINSTA_API_KEY",
  });
});

test("9: a new profile with neither value nor env gets the provider default", async () => {
  const { server, store } = await fixture();
  await save(server, {
    profile: "staging",
    provider: "rocketnet",
    credentialValue: "",
    credentialEnv: "",
    companyId: "",
    apiBaseUrl: "",
    force: false,
  });
  assert.deepEqual((await store.load()).hostingProfiles.staging.credential, {
    type: "env",
    name: "ROCKETNET_PASSWORD",
  });
});

/* -------------------------------------------------------------------------- */
/* 10: remove                                                                 */
/* -------------------------------------------------------------------------- */

test("10: remove deletes the profile, its secret and its check stamp", async () => {
  const { server, store, credentialsDir, security } = await fixture();
  await save(server, {
    profile: "prod",
    provider: "kinsta",
    credentialValue: SECRET,
    credentialEnv: "",
    companyId: "",
    apiBaseUrl: "",
    force: false,
  });
  // Record a check, so the removal has a stamp to clear.
  await sse(
    server,
    authorized("/_dashboard/providers/validate?profile=prod", {
      body: JSON.stringify({ token: TOKEN }),
    }),
  );
  assert.ok((await page(server, "/providers")).includes("data-checked-at"));

  const { recorder } = await sse(
    server,
    authorized("/_dashboard/providers/remove?profile=prod", {
      body: JSON.stringify({ token: TOKEN }),
    }),
  );
  assert.equal(Object.keys((await store.load()).hostingProfiles).length, 0);
  assert.ok(recorder.find("toast").markup.includes("prod removed."));
  assert.deepEqual(
    recorder.elements.map((patch) => patch.selectorId),
    ["main", "nav", "toast"],
  );

  const { createCredentialStore } =
    await import("../dist/credentials/store.js");
  const credentials = await createCredentialStore(credentialsDir, security, {
    preference: "file",
  });
  assert.equal(
    await credentials.read(
      credentialId({ provider: "kinsta", profile: "prod" }),
    ),
    undefined,
    "the orphaned secret is deleted",
  );

  // Re-creating the name must not inherit the old "Connected" pill.
  await save(server, {
    profile: "prod",
    provider: "kinsta",
    credentialValue: "",
    credentialEnv: "KINSTA_API_KEY",
    companyId: "",
    apiBaseUrl: "",
    force: false,
  });
  const markup = await page(server, "/providers");
  assert.ok(!markup.includes("data-checked-at"));
});

/* -------------------------------------------------------------------------- */
/* 11-13: validate and the connection cell                                    */
/* -------------------------------------------------------------------------- */

test("11: a successful validate patches only the cell and the toast", async () => {
  const { server } = await fixture({ config: PROFILE_CONFIG });
  const { recorder } = await sse(
    server,
    authorized("/_dashboard/providers/validate?profile=prod", {
      body: JSON.stringify({ token: TOKEN }),
    }),
  );
  assert.deepEqual(
    recorder.elements.map((patch) => `${patch.selectorId}/${patch.mode}`),
    [`${connCellId("prod")}/outer`, "toast/outer"],
  );
  const cell = recorder.find(connCellId("prod")).markup;
  assert.ok(cell.startsWith(`<td id="${connCellId("prod")}"`));
  assert.ok(cell.includes('<span class="pill ok">Connected</span>'));
  assert.ok(cell.includes(`data-checked-at="${String(NOW)}"`));
  assert.ok(recorder.find("toast").markup.includes("prod is connected."));
  // A validate must never repaint the page out from under an open form.
  assert.equal(recorder.find("main"), undefined);
  assert.equal(recorder.find("nav"), undefined);
});

test("12: a failing validate shows Error, keeps no stamp, and never patches main", async () => {
  const { server } = await fixture({
    config: PROFILE_CONFIG,
    client: {
      validateError: Object.assign(new Error("The API key was rejected."), {
        code: "credential_invalid",
      }),
    },
  });
  const { recorder } = await sse(
    server,
    authorized("/_dashboard/providers/validate?profile=prod", {
      body: JSON.stringify({ token: TOKEN }),
    }),
  );
  const cell = recorder.find(connCellId("prod")).markup;
  assert.ok(cell.includes('<span class="pill danger">Error</span>'));
  assert.ok(cell.includes("data-checked-at"));
  assert.equal(recorder.find("main"), undefined);
  assert.ok(recorder.find("toast").markup.includes("danger"));

  // Go rendered the stamp on the failure path but did not record it, so the
  // page render still says "Not checked" rather than inferring a success.
  const markup = await page(server, "/providers");
  assert.ok(markup.includes(">Not checked</span>"));
  assert.ok(!markup.includes("data-checked-at"));
});

test("13: a malformed body patches #provider-flash, the only producer of it", async () => {
  const { server } = await fixture({ config: PROFILE_CONFIG });
  const { recorder } = await sse(
    server,
    authorized("/_dashboard/providers/validate?profile=prod", {
      body: "not json at all",
    }),
  );
  assert.deepEqual(
    recorder.elements.map((patch) => `${patch.selectorId}/${patch.mode}`),
    ["provider-flash/outer", "toast/outer"],
  );
  const flash = recorder.find("provider-flash").markup;
  assert.ok(flash.startsWith('<div id="provider-flash">'));
  assert.ok(flash.includes('class="notice danger"'));
});

test("14: the connection cell states are Go's four", async () => {
  // `nocred`: an `env` credential whose variable is not in the injected record.
  const { server } = await fixture({
    config: PROFILE_CONFIG,
    environment: {},
  });
  assert.ok(
    (await page(server, "/providers")).includes(
      '<span class="pill warn">No credential</span>',
    ),
  );

  // `unchecked`: the variable is present, nothing has been validated.
  const withEnv = await fixture({ config: PROFILE_CONFIG });
  const before = await page(withEnv.server, "/providers");
  assert.ok(before.includes('<span class="pill">Not checked</span>'));
  assert.ok(!before.includes("data-checked-at"));

  // `connected`: a recorded, successful check.
  await sse(
    withEnv.server,
    authorized("/_dashboard/providers/validate?profile=prod", {
      body: JSON.stringify({ token: TOKEN }),
    }),
  );
  const after = await page(withEnv.server, "/providers");
  assert.ok(after.includes('<span class="pill ok">Connected</span>'));
  assert.ok(after.includes(`data-checked-at="${String(NOW)}"`));
  assert.ok(!after.includes(">Not checked</span>"));
});

/* -------------------------------------------------------------------------- */
/* 15: the token guard                                                        */
/* -------------------------------------------------------------------------- */

test("15: all three routes refuse a missing or wrong token", async () => {
  const { server, store } = await fixture();
  for (const path of [
    "/_dashboard/providers/save",
    "/_dashboard/providers/remove?profile=prod",
    "/_dashboard/providers/validate?profile=prod",
  ]) {
    for (const headers of [{}, { [TOKEN_HEADER]: "e".repeat(64) }]) {
      const response = await server.dispatch(
        request(path, {
          method: "POST",
          headers,
          body: JSON.stringify({
            token: TOKEN,
            providerForm: { profile: "prod", provider: "kinsta" },
          }),
        }),
      );
      assert.equal(response.status, 403, `${path} ${JSON.stringify(headers)}`);
      assert.equal(response.envelope.error.code, "usage_error");
    }
  }
  // The body copy of the token is not a fallback: Go's was, HQ's is ignored.
  assert.equal(Object.keys((await store.load()).hostingProfiles).length, 0);
});
