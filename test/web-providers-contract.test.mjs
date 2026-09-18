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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultFileSecurity } from "../dist/config/file-security.js";
import { atomicWriteFile } from "../dist/config/atomic-write.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import { credentialId } from "../dist/credentials/store.js";
import { createHostingClientFactory } from "../dist/hosting/factory.js";
import { createDashboardServer } from "../dist/web/index.js";
import { shuffledProviderKinds } from "../dist/web/views/providers.js";

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
    read: async (request) => {
      if (behaviour.read) return behaviour.read(request);
      return [];
    },
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
  const security = defaultFileSecurity();
  await atomicWriteFile(
    paths.configFile,
    JSON.stringify(
      options.config ?? { version: 1, hostingProfiles: {}, pushes: {} },
    ),
    security,
  );
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
      kinsta: () => {
        options.onClient?.();
        return fakeProviderClient(options.client ?? {});
      },
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
      // `/` asks the site CLI's listing once before showing first-run
      // onboarding; this suite runs no site CLI and configures no site.
      listProfiles: async () => ({ profiles: [] }),
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
  pushes: {},
};

/* -------------------------------------------------------------------------- */
/* 1-5: the page                                                              */
/* -------------------------------------------------------------------------- */

test("1: only an empty root shows onboarding; Providers remains a section", async () => {
  const { server } = await fixture();
  const markup = await page(server, "/");
  assert.ok(markup.includes('class="page onboarding"'));
  assert.equal((markup.match(/class="onboard-card[ "]/g) ?? []).length, 2);
  assert.ok(markup.includes("<h1>Add site</h1>"));
  assert.ok(markup.includes("Then configure your AI client"));
  assert.ok(markup.includes("Connect a hosting account"));
  assert.ok(markup.includes("<h2>Manually</h2>"));
  assert.ok(
    markup.indexOf("<h2>Manually</h2>") <
      markup.indexOf("<h2>From a hosting account</h2>"),
  );
  assert.ok(markup.includes('href="/sites?new=cli"'));
  assert.ok(markup.includes('id="provider-flash"'));
  assert.ok(!markup.includes("nav-link active"));
  // The old credential-holding site form remains deleted.
  for (const gone of ["Connect a single site", "site-name", "siteForm"])
    assert.ok(!markup.includes(gone), gone);
  assert.ok(!/application[-_ ]?password/i.test(markup));

  const providers = await page(server, "/hosting-accounts");
  assert.ok(providers.includes("<h1>Hosting accounts</h1>"));
  assert.ok(providers.includes("nav-link active"));
  assert.ok(!providers.includes('class="page onboarding"'));

  const listing = {
    profiles: [
      {
        name: "direct",
        siteUrl: "https://direct.example.test",
        origin: "https://direct.example.test",
        state: "connected",
      },
    ],
    checkedAt: NOW,
    cliAvailable: true,
  };
  const snapshot = {
    byKey: new Map(),
    checkedAt: NOW,
    cliAvailable: true,
  };
  const { server: withDirectSite } = await fixture({
    overrides: {
      integration: {
        connectionStates: async () => snapshot,
        siteInventory: async () => ({
          connections: snapshot,
          profiles: listing,
        }),
        listProfiles: async () => listing,
        connect: async () => ({ kind: "connected" }),
        logoutProfile: async () => ({ kind: "done" }),
        removeProfile: async () => ({ kind: "done" }),
      },
    },
  });
  const populatedRoot = await page(withDirectSite, "/");
  assert.ok(populatedRoot.includes("<h1>Sites</h1>"));
  assert.ok(!populatedRoot.includes('class="page onboarding"'));
});

test("2: the form chooses a provider before requesting account details", async () => {
  const { server } = await fixture({ config: PROFILE_CONFIG });
  const markup = await page(server, "/hosting-accounts");
  for (const want of [
    ">Connect hosting account</button>",
    'data-class="{open: $providerForm.open}"',
    "Step 1 of 2",
    "Choose your hosting provider",
    ">Kinsta</strong>",
    ">Cloudways</strong>",
    "Step 2 of 2",
    "Change provider",
    'data-class="{hidden: $providerForm.detailsOpen}"',
    'data-class="{hidden: !$providerForm.detailsOpen}"',
    "$providerForm.detailsOpen = true",
    "$providerForm.provider = &quot;kinsta&quot;",
    "Account name",
    "e.g. my-kinsta",
    "e.g. my-wpengine",
    ">Credential</span>",
    "Company or account ID",
    "Kinsta company ID",
    "Paste the Rocket.net password.",
    ">Cancel</button>",
    'data-bind="providerForm.companyId"',
    'autocomplete="new-password"',
    "Your hosting credentials are stored only on this computer.",
  ])
    assert.ok(markup.includes(want), want);
  // Fields Go never had. `force` is set by Edit alone.
  for (const gone of [
    "local-storage-note",
    "operating system's credential store",
    "not encrypted by Novamira HQ",
    "Credential env",
    "API base URL",
    "Overwrite if it exists",
    "providerForm.companyID",
    "providerForm.apiBaseURL",
  ])
    assert.ok(!markup.includes(gone), gone);
});

test("2b: provider choices can be shuffled without favoring the catalog order", () => {
  const shuffled = shuffledProviderKinds(() => 0);
  assert.deepEqual([...shuffled].sort(), [
    "cloudways",
    "hostinger",
    "instawp",
    "kinsta",
    "pantheon",
    "pressable",
    "rocketnet",
    "wpengine",
  ]);
  assert.notEqual(shuffled[0], "kinsta");
});

test("3: the table has Go's four columns and no invented ones", async () => {
  const { server } = await fixture({ config: PROFILE_CONFIG });
  const markup = await page(server, "/hosting-accounts");
  assert.ok(!markup.includes("<th>Last check</th>"));
  assert.ok(markup.includes('<details class="profile-menu">'));
  assert.ok(markup.includes('aria-label="More actions for prod"'));
  assert.ok(
    markup.includes('href="/hosting-activity?profile=prod">Activity</a>'),
  );
  assert.ok(!markup.includes("<th>Connection</th>"));
  assert.ok(markup.includes("<th>Name</th>"));
  assert.ok(markup.includes("<th>Provider</th>"));
  for (const gone of [
    "<th>Credential</th>",
    "<th>Account</th>",
    "<th>Status</th>",
    "<th>Default</th>",
  ])
    assert.ok(!markup.includes(gone), gone);
  assert.ok(markup.includes(">Verify access</button>"));
  assert.ok(!markup.includes(">Validate</button>"));
  assert.ok(markup.includes("1 hosting account"));
  assert.ok(
    markup.includes(
      'href="/hosting-accounts?actions=prod">Available actions</a>',
    ),
  );
});

test("account actions page reads capabilities only for the selected account", async () => {
  const calls = [];
  const { server } = await fixture({
    config: PROFILE_CONFIG,
    client: {
      read: async (request) => {
        calls.push(request);
        return [{ name: "sites.list", supported: true }];
      },
      validateError: new Error("must not validate"),
    },
  });
  await page(server, "/hosting-accounts");
  assert.equal(calls.length, 0);
  const markup = await page(server, "/hosting-accounts?actions=prod");
  assert.deepEqual(calls, [{ kind: "capabilities" }]);
  assert.ok(markup.includes("List sites"));
  assert.ok(markup.includes("prod · Kinsta"));
  assert.ok(!markup.includes("env:KINSTA_API_KEY"));
  const missing = await server.dispatch(
    request("/hosting-accounts?actions=missing"),
  );
  assert.equal(missing.status, 404);
  assert.equal(calls.length, 1);
});

test("account actions loading failure does not leak adapter errors", async () => {
  const { server } = await fixture({
    config: PROFILE_CONFIG,
    client: {
      read: async () => {
        throw new Error("private-error-detail");
      },
    },
  });
  const markup = await page(server, "/hosting-accounts?actions=prod");
  assert.ok(markup.includes("Available actions could not be loaded"));
  assert.ok(!markup.includes("private-error-detail"));
});

test("4: the table hides itself while the form is open, on both paints", async () => {
  const { server } = await fixture({ config: PROFILE_CONFIG });
  const closed = await page(server, "/hosting-accounts");
  assert.ok(closed.includes('data-class="{hidden: $providerForm.open}"'));
  assert.ok(closed.includes('class="panel table-panel"'));
  assert.ok(closed.includes('class="panel form-panel ds-toggle"'));

  // `?new=host` opens the form server-side, so there is no first-paint flash.
  const open = await page(server, "/hosting-accounts?new=host");
  assert.ok(open.includes('class="panel table-panel hidden"'));
  assert.ok(open.includes('class="panel form-panel ds-toggle open"'));
  assert.ok(open.includes('class="toolbar inline-toolbar hidden"'));
  assert.ok(open.includes('data-class="{hidden: $providerForm.open}"'));
});

test("5: the details row renders the credential reference, never a value", async () => {
  const { server } = await fixture({ config: PROFILE_CONFIG });
  const markup = await page(server, "/hosting-accounts");
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
  assert.equal(recorder.signals[0].providerForm.detailsOpen, false);
  assert.equal(recorder.signals[0].providerForm.detailsOpen, false);
  assert.ok(
    recorder.find("main").markup.includes("account saved and access verified."),
  );
  assert.ok(
    !recorder
      .find("toast")
      .markup.includes("account saved and access verified."),
  );
  assert.ok(recorder.closed);

  // And neither does the re-rendered page.
  assert.ok(!(await page(server, "/hosting-accounts")).includes(SECRET));
});

test("a verified new account shows app and AI actions using the same validated client", async () => {
  let clients = 0;
  const reads = [];
  const { server } = await fixture({
    onClient: () => clients++,
    client: {
      read: async (request) => {
        reads.push(request);
        return [
          { name: "sites.list", supported: true },
          { name: "sites.get", supported: true },
          { name: "sites.delete", supported: true },
        ];
      },
    },
  });
  const { recorder } = await save(server, {
    profile: "prod",
    provider: "kinsta",
    credentialValue: SECRET,
  });
  const markup = recorder.find("main").markup;
  assert.ok(markup.includes("Hosting account ready"));
  assert.ok(markup.includes("In the app"));
  assert.ok(markup.includes("With your AI"));
  assert.ok(markup.includes("List sites"));
  assert.ok(markup.includes('href="/sites">View sites'));
  assert.ok(markup.includes('href="/configure-ai">Configure your AI'));
  assert.ok(markup.includes("does not authorize access to WordPress"));
  assert.ok(!markup.includes("sites.delete"));
  assert.ok(!recorder.body.includes(SECRET));
  assert.equal(clients, 1);
  assert.deepEqual(reads, [{ kind: "capabilities" }]);
});

test("capability loading failure preserves successful account verification", async () => {
  const { server, store } = await fixture({
    client: {
      read: async () => {
        throw new Error(SECRET);
      },
    },
  });
  const { recorder } = await save(server, {
    profile: "prod",
    provider: "kinsta",
    credentialValue: SECRET,
  });
  assert.ok(await store.getHostingProfile("prod"));
  const markup = recorder.find("main").markup;
  assert.ok(markup.includes("Hosting account ready"));
  assert.ok(markup.includes("account saved and access verified"));
  assert.ok(markup.includes("Available actions could not be loaded"));
  assert.ok(!recorder.body.includes(SECRET));
});

test("editing an account keeps the existing confirmation instead of replaying onboarding", async () => {
  let reads = 0;
  const { server } = await fixture({
    config: PROFILE_CONFIG,
    client: {
      read: async () => {
        reads++;
        return [];
      },
    },
  });
  const { recorder } = await save(server, {
    profile: "prod",
    provider: "kinsta",
    credentialValue: SECRET,
    force: true,
  });
  assert.ok(!recorder.find("main").markup.includes("Hosting account ready"));
  assert.equal(reads, 0);
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
  const toast = recorder.find("main").markup;
  assert.ok(toast.includes("Open it in Edit"));
  assert.ok(toast.includes("danger"));
  // No signal patch on the failure path: the operator's values stay in the form.
  assert.equal(recorder.signals.length, 0);
  assert.ok(!recorder.body.includes(SECRET));
});

test("saving checks the connection immediately and reports an unverified saved account honestly", async () => {
  const { server, store } = await fixture({
    client: { validateError: new Error(SECRET) },
  });
  const { recorder } = await save(server, {
    profile: "unverified",
    provider: "kinsta",
    credentialValue: SECRET,
  });
  assert.ok(await store.getHostingProfile("unverified"));
  assert.match(
    recorder.find("main").markup,
    /saved, but access could not be verified/,
  );
  assert.doesNotMatch(recorder.body, /data-checked-at/);
  assert.ok(!recorder.find("main").markup.includes("Hosting account ready"));
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
  assert.ok(
    !(await page(server, "/hosting-accounts")).includes("data-checked-at"),
  );

  const { recorder } = await sse(
    server,
    authorized("/_dashboard/providers/remove?profile=prod", {
      body: JSON.stringify({ token: TOKEN }),
    }),
  );
  assert.equal(Object.keys((await store.load()).hostingProfiles).length, 0);
  assert.ok(recorder.find("main").markup.includes("prod removed."));
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
  const markup = await page(server, "/hosting-accounts");
  assert.ok(
    !markup.includes("data-checked-at"),
    "a checked account does not acquire a persistent status badge",
  );
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
    ["toast/outer"],
  );
  assert.ok(recorder.find("toast").markup.includes("prod: access verified."));
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
  assert.equal(recorder.elements.length, 1);
  assert.equal(recorder.find("main"), undefined);
  assert.ok(recorder.find("toast").markup.includes("danger"));

  // Go rendered the stamp on the failure path but did not record it, so the
  // page render still says "Not checked" rather than inferring a success.
  const markup = await page(server, "/hosting-accounts");
  assert.ok(!markup.includes(">Not checked</span>"));
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
    ["toast/outer"],
  );
  assert.ok(recorder.find("toast").markup.includes("danger"));
});

test("14: the connection cell states are Go's four", async () => {
  // `nocred`: an `env` credential whose variable is not in the injected record.
  const { server } = await fixture({
    config: PROFILE_CONFIG,
    environment: {},
  });
  assert.ok(
    !(await page(server, "/hosting-accounts")).includes(
      '<span class="pill warn">No credential</span>',
    ),
  );

  // `unchecked`: the variable is present, nothing has been validated.
  const withEnv = await fixture({ config: PROFILE_CONFIG });
  const before = await page(withEnv.server, "/hosting-accounts");
  assert.ok(!before.includes('<span class="pill">Not checked</span>'));
  assert.ok(!before.includes("data-checked-at"));

  // `connected`: a recorded, successful check.
  await sse(
    withEnv.server,
    authorized("/_dashboard/providers/validate?profile=prod", {
      body: JSON.stringify({ token: TOKEN }),
    }),
  );
  const after = await page(withEnv.server, "/hosting-accounts");
  assert.ok(!after.includes('<span class="pill ok">Verified</span>'));
  assert.ok(!after.includes("data-checked-at"));
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
