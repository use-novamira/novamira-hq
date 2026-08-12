// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// The site CLI integration's contract, run entirely offline against `dist/`.
//
// Every case injects `spawn` and `resolve`: no real `novamira` child ever
// starts, no `PATH` is walked, and no network call is made. The fixtures are
// copied from `@novamira/cli@1.0.3`'s observed public output and are the
// executable statement of what HQ requires (and of what it tolerates).

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  createSiteCliIntegration,
  createSiteCliResolver,
  authStatusArgs,
  nodeSpawnChild,
  originOf,
  parseAuthStatus,
  parseEnvelope,
  parseSitesList,
  siteCliChildEnv,
  sitesListArgs,
  SITE_CLI_INSTALL_HINT,
} from "../dist/integration/index.js";

import { createDashboardIntegration } from "../dist/cli/dashboard.js";

const CLI = { command: "/usr/local/bin/novamira", prefixArgs: [] };
const NOW = 1_700_000_000_000;

const success = (data) =>
  JSON.stringify({ ok: true, data, meta: { requestId: "r" } });
const failure = (code) =>
  JSON.stringify({ ok: false, error: { code, message: "m" } });

const exited = (stdout, code = 0) => ({
  kind: "exited",
  code,
  stdout,
  stderr: "",
});
const stopped = (kind, code = null) => ({ kind, code, stdout: "", stderr: "" });

const PROFILE = {
  name: "prod",
  siteUrl: "https://example.com",
  origin: "https://example.com",
};

const AUTH_OK = {
  site: "prod",
  siteUrl: "https://example.com",
  credentialState: "fresh",
  restReachable: true,
};

const QUERY = { key: "site-1/env-1", origins: ["example.com"] };

/** An integration whose children are answered by `script(invocation, index)`. */
function harness(script, options = {}) {
  const calls = [];
  const integration = createSiteCliIntegration({
    spawn: async (invocation) => {
      calls.push(invocation);
      return await script(invocation, calls.length);
    },
    resolve: options.resolve ?? (async () => CLI),
    environment: options.environment ?? {
      PATH: "/usr/local/bin",
      NOVAMIRA_HOME: "/home/operator/.novamira",
    },
    now: () => NOW,
    ...(options.tuning ?? {}),
  });
  return { integration, calls };
}

/** The common shape: one `sites list`, then one `auth status` per profile. */
function scripted({ list, status }) {
  return (invocation) =>
    invocation.args.includes("list") ? list : status(invocation);
}

const isAuthStatus = (invocation) => invocation.args.includes("status");
const siteOf = (invocation) =>
  invocation.args[invocation.args.indexOf("--site") + 1];

async function stateFor(script, options = {}, queries = [QUERY]) {
  const { integration, calls } = harness(script, options);
  const snapshot = await integration.connectionStates(queries);
  return { snapshot, calls, result: snapshot.byKey.get(queries[0].key) };
}

/* -------------------------------------------------------------------------- */
/* 1-6: the CLI cannot answer                                                 */
/* -------------------------------------------------------------------------- */

test("an absent CLI is unavailable/cli_absent and spawns nothing", async () => {
  const { snapshot, calls, result } = await stateFor(
    () => exited(success([PROFILE])),
    { resolve: async () => undefined },
  );
  assert.deepEqual(result, {
    state: "unavailable",
    profiles: [],
    reason: "cli_absent",
  });
  assert.equal(snapshot.cliAvailable, false);
  assert.equal(calls.length, 0);
  assert.equal(snapshot.checkedAt, NOW);
});

test("ENOENT from the spawn seam is unavailable/cli_absent", async () => {
  const { snapshot, result } = await stateFor(() => stopped("not_found"));
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "cli_absent");
  assert.equal(snapshot.cliAvailable, false);
});

test("a failed spawn is unavailable/cli_failed", async () => {
  const { result } = await stateFor(() => stopped("spawn_failed"));
  assert.equal(result.reason, "cli_failed");
});

test("a per-child timeout is cli_timeout, and the exit code is not consulted", async () => {
  // A `timed_out` outcome carrying `code: 1` must never be read as a normal
  // non-zero exit; the kind outranks the status.
  const { result } = await stateFor(() => stopped("timed_out", 1));
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "cli_timeout");
});

test("the overall deadline stops stage two and starts no further children", async () => {
  const { snapshot, calls, result } = await stateFor(
    async (invocation) => {
      if (isAuthStatus(invocation)) return exited(success(AUTH_OK));
      await new Promise((resolve) => setTimeout(resolve, 15));
      return exited(success([PROFILE]));
    },
    { tuning: { overallDeadlineMs: 1 } },
  );
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "deadline_exceeded");
  assert.equal(calls.length, 1, "no auth status child was started");
  assert.equal(snapshot.cliAvailable, true);
});

test("oversized child output is unavailable/output_truncated", async () => {
  const { result } = await stateFor(() => stopped("truncated"));
  assert.equal(result.reason, "output_truncated");
});

/* -------------------------------------------------------------------------- */
/* 7-12: malformed and tolerated payloads                                     */
/* -------------------------------------------------------------------------- */

test("stdout that is not JSON is malformed_output", async () => {
  const { result } = await stateFor(() => exited("not json"));
  assert.equal(result.reason, "malformed_output");
});

test("two JSON objects on stdout is malformed_output", async () => {
  const { result } = await stateFor(() =>
    exited(`${success([])}${success([])}`),
  );
  assert.equal(result.reason, "malformed_output");
});

test("a sites list element missing a required field is malformed_output", async () => {
  for (const element of [
    { name: "prod", siteUrl: "https://example.com" },
    { siteUrl: "https://example.com", origin: "https://example.com" },
    { name: "prod", siteUrl: "https://example.com", origin: "" },
    { name: 7, siteUrl: "https://example.com", origin: "https://example.com" },
  ]) {
    const { result } = await stateFor(() => exited(success([element])));
    assert.equal(result.reason, "malformed_output", JSON.stringify(element));
  }
});

test("one malformed element rejects the whole sites list", async () => {
  const { result } = await stateFor(() =>
    exited(success([PROFILE, { name: "staging" }])),
  );
  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "malformed_output");
});

test("additional members are ignored everywhere", async () => {
  const { result } = await stateFor(
    scripted({
      list: exited(
        JSON.stringify({
          ok: true,
          data: [
            {
              ...PROFILE,
              clientId: "abc",
              compatibility: { restApiVersion: 1 },
              futureField: { nested: true },
            },
          ],
          meta: { requestId: "r", somethingNew: 1 },
          alsoNew: true,
        }),
      ),
      status: () =>
        exited(
          success({
            ...AUTH_OK,
            futureField: [1, 2],
            expiresAt: "2026-01-01T00:00:00Z",
          }),
        ),
    }),
  );
  assert.deepEqual(result, { state: "connected", profiles: ["prod"] });
});

test("an auth status payload missing or misspelling a required field is malformed_output", async () => {
  for (const payload of [
    { restReachable: true },
    { credentialState: "fresh" },
    { credentialState: "brand_new", restReachable: true },
    { credentialState: "fresh", restReachable: "yes" },
  ]) {
    const { result } = await stateFor(
      scripted({
        list: exited(success([PROFILE])),
        status: () => exited(success(payload)),
      }),
    );
    assert.equal(result.state, "unavailable", JSON.stringify(payload));
    assert.equal(result.reason, "malformed_output");
  }
});

/* -------------------------------------------------------------------------- */
/* 13-19: the four states                                                     */
/* -------------------------------------------------------------------------- */

test("a fresh credential over a reachable REST surface is connected", async () => {
  const { result } = await stateFor(
    scripted({
      list: exited(success([PROFILE])),
      status: () => exited(success(AUTH_OK)),
    }),
  );
  assert.deepEqual(result, { state: "connected", profiles: ["prod"] });
});

test("near_expiry is connected too", async () => {
  const { result } = await stateFor(
    scripted({
      list: exited(success([PROFILE])),
      status: () =>
        exited(success({ ...AUTH_OK, credentialState: "near_expiry" })),
    }),
  );
  assert.equal(result.state, "connected");
});

test("absent, invalid and expired credentials are reconnect_required", async () => {
  for (const payload of [
    { credentialState: "absent", restReachable: null },
    { credentialState: "invalid", restReachable: null },
    {
      credentialState: "expired",
      restReachable: false,
      restError: "auth_expired",
    },
  ]) {
    const { result } = await stateFor(
      scripted({
        list: exited(success([PROFILE])),
        status: () => exited(success(payload)),
      }),
    );
    assert.deepEqual(
      result,
      { state: "reconnect_required", profiles: ["prod"] },
      payload.credentialState,
    );
  }
});

test("an authentication restError is reconnect_required", async () => {
  for (const restError of [
    "auth_required",
    "auth_denied",
    "auth_expired",
    "insufficient_scope",
  ]) {
    const { result } = await stateFor(
      scripted({
        list: exited(success([PROFILE])),
        status: () =>
          exited(success({ ...AUTH_OK, restReachable: false, restError })),
      }),
    );
    assert.equal(result.state, "reconnect_required", restError);
  }
});

test("any other restError is unavailable/site_unreachable", async () => {
  for (const restError of [
    "network_error",
    "rest_error",
    "server_unsupported",
    "internal_error",
    "a_code_hq_has_never_seen",
    undefined,
  ]) {
    const status = { ...AUTH_OK, restReachable: false };
    if (restError !== undefined) status.restError = restError;
    const { result } = await stateFor(
      scripted({
        list: exited(success([PROFILE])),
        status: () => exited(success(status)),
      }),
    );
    assert.equal(result.state, "unavailable", String(restError));
    assert.equal(result.reason, "site_unreachable");
  }
});

test("restReachable null beside a usable credential is malformed_output", async () => {
  const { result } = await stateFor(
    scripted({
      list: exited(success([PROFILE])),
      status: () => exited(success({ ...AUTH_OK, restReachable: null })),
    }),
  );
  assert.equal(result.reason, "malformed_output");
});

test("across several matching profiles, any-connected wins and reconnect outranks unavailable", async () => {
  const profiles = ["one", "two", "three"].map((name) => ({
    ...PROFILE,
    name,
  }));
  const answers = {
    one: exited(success(AUTH_OK)),
    two: exited(success({ credentialState: "absent", restReachable: null })),
    three: stopped("timed_out"),
  };
  const run = async (names) => {
    const { result } = await stateFor(
      scripted({
        list: exited(success(profiles.filter((p) => names.includes(p.name)))),
        status: (invocation) => answers[siteOf(invocation)],
      }),
    );
    return result;
  };
  assert.equal((await run(["one", "two", "three"])).state, "connected");
  assert.equal((await run(["two", "three"])).state, "reconnect_required");
  const only = await run(["three"]);
  assert.equal(only.state, "unavailable");
  assert.equal(only.reason, "cli_timeout");
});

/* -------------------------------------------------------------------------- */
/* 20-24: matching, dropped profiles and failure codes                        */
/* -------------------------------------------------------------------------- */

test("no matching profile is not_configured, and stage two runs zero children", async () => {
  const { calls, result } = await stateFor(
    scripted({
      list: exited(
        success([
          {
            ...PROFILE,
            origin: "https://other.example",
            siteUrl: "https://other.example",
          },
        ]),
      ),
      status: () => exited(success(AUTH_OK)),
    }),
  );
  assert.deepEqual(result, { state: "not_configured", profiles: [] });
  assert.equal(calls.length, 1);
});

test("site_not_found in stage two drops the profile rather than failing", async () => {
  const { result } = await stateFor(
    scripted({
      list: exited(success([PROFILE])),
      status: () => exited(failure("site_not_found"), 2),
    }),
  );
  assert.deepEqual(result, { state: "not_configured", profiles: [] });
});

test("usage_error in stage one is cli_incompatible for every query", async () => {
  const queries = [
    QUERY,
    { key: "site-2/env-2", origins: ["https://other.example"] },
  ];
  const { snapshot } = await stateFor(
    () => exited(failure("usage_error"), 2),
    {},
    queries,
  );
  for (const query of queries) {
    assert.equal(snapshot.byKey.get(query.key).reason, "cli_incompatible");
  }
});

test("site_required is surfaced as cli_failed", async () => {
  const { result } = await stateFor(() => exited(failure("site_required"), 2));
  assert.equal(result.reason, "cli_failed");
});

test("a non-zero exit with no parseable envelope is malformed_output", async () => {
  const { result } = await stateFor(() => exited("Error: boom\n", 1));
  assert.equal(result.reason, "malformed_output");
});

/* -------------------------------------------------------------------------- */
/* 25-29: argv, environment, concurrency, deduplication                       */
/* -------------------------------------------------------------------------- */

test("the argv of each command is exact, and is always an array", async () => {
  const { calls } = await stateFor(
    scripted({
      list: exited(success([PROFILE])),
      status: () => exited(success(AUTH_OK)),
    }),
    { tuning: { perChildTimeoutMs: 10_000 } },
  );
  assert.deepEqual(calls[0].args, [
    "--json",
    "--quiet",
    "--timeout",
    "10000",
    "sites",
    "list",
  ]);
  assert.deepEqual(calls[1].args, [
    "--json",
    "--quiet",
    "--timeout",
    "10000",
    "--site",
    "prod",
    "auth",
    "status",
  ]);
  for (const call of calls) {
    assert.ok(
      Array.isArray(call.args),
      "argv is an array, never a command line",
    );
    assert.equal(typeof call.command, "string");
    assert.ok(!call.args.includes("--name"));
    assert.ok(!call.args.includes("--no-open"));
  }
  assert.ok(!calls[0].args.includes("--site"));
  assert.deepEqual(sitesListArgs(500), [
    "--json",
    "--quiet",
    "--timeout",
    "500",
    "sites",
    "list",
  ]);
  assert.deepEqual(authStatusArgs(500, "x"), [
    "--json",
    "--quiet",
    "--timeout",
    "500",
    "--site",
    "x",
    "auth",
    "status",
  ]);
});

test("prefixArgs precede the CLI's own argv", async () => {
  const { calls } = await stateFor(() => exited(success([])), {
    resolve: async () => ({
      command: "/usr/bin/node",
      prefixArgs: ["C:\\cli\\dist\\index.js"],
    }),
  });
  assert.equal(calls[0].command, "/usr/bin/node");
  assert.equal(calls[0].args[0], "C:\\cli\\dist\\index.js");
  assert.equal(calls[0].args[1], "--json");
});

test("the child environment sets the update-check and colour variables and passes NOVAMIRA_HOME through", async () => {
  const { calls } = await stateFor(() => exited(success([])), {
    environment: {
      PATH: "/bin",
      NOVAMIRA_HOME: "/home/operator/.novamira",
      NOVAMIRA_SITE: "operator-choice",
    },
  });
  const env = calls[0].env;
  assert.equal(env.NOVAMIRA_UPDATE_CHECK, "0");
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.NOVAMIRA_HOME, "/home/operator/.novamira");
  // Not injected by HQ; `--site` is what makes it unable to redirect the probe.
  assert.equal(env.NOVAMIRA_SITE, "operator-choice");
  assert.ok(!calls[0].args.includes("operator-choice"));
});

test("stage two respects the concurrency bound", async () => {
  const profiles = Array.from({ length: 8 }, (_, index) => ({
    ...PROFILE,
    name: `p${index}`,
  }));
  let inFlight = 0;
  let peak = 0;
  const { calls } = await stateFor(
    async (invocation) => {
      if (!isAuthStatus(invocation)) return exited(success(profiles));
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return exited(success(AUTH_OK));
    },
    { tuning: { concurrency: 2 } },
  );
  assert.equal(calls.length, 9);
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});

test("a profile matched by several queries is probed exactly once", async () => {
  const queries = [
    { key: "a", origins: ["example.com"] },
    { key: "b", origins: ["https://example.com"] },
    { key: "c", origins: ["EXAMPLE.com."] },
  ];
  const { snapshot, calls } = await stateFor(
    scripted({
      list: exited(success([PROFILE])),
      status: () => exited(success(AUTH_OK)),
    }),
    {},
    queries,
  );
  assert.equal(calls.filter(isAuthStatus).length, 1);
  for (const query of queries) {
    assert.equal(snapshot.byKey.get(query.key).state, "connected");
  }
});

/* -------------------------------------------------------------------------- */
/* 30-32: origin normalization and matching                                   */
/* -------------------------------------------------------------------------- */

test("originOf is total and normalizes through URL", () => {
  assert.equal(originOf("example.com"), "https://example.com");
  assert.equal(
    originOf("https://example.com/blog?x=1#f"),
    "https://example.com",
  );
  assert.equal(originOf("https://EXAMPLE.com."), "https://example.com");
  assert.equal(
    originOf("https://xn--pbt-hoa.example"),
    "https://xn--pbt-hoa.example",
  );
  assert.equal(
    originOf("https://bücher.example"),
    "https://xn--bcher-kva.example",
  );
  assert.equal(
    originOf("https://example.com:8443"),
    "https://example.com:8443",
  );
  assert.equal(originOf("https://example.com:443"), "https://example.com");
  assert.equal(originOf("http://example.com:80"), "http://example.com");
  assert.equal(originOf("http://example.com"), "http://example.com");
  assert.equal(originOf("https://user:pw@example.com"), undefined);
  assert.equal(originOf("user@example.com"), undefined);
  assert.equal(originOf("ftp://example.com"), undefined);
  assert.equal(originOf("javascript:alert(1)"), undefined);
  assert.equal(originOf("https://"), undefined);
  assert.equal(originOf("   "), undefined);
  assert.equal(originOf(""), undefined);
  assert.equal(originOf(undefined), undefined);
});

test("matching is exact origin equality: no www fuzz, no scheme fuzz, no port fuzz", async () => {
  const match = async (profileOrigin, queryOrigin) => {
    const { result } = await stateFor(
      scripted({
        list: exited(
          success([
            { name: "prod", siteUrl: profileOrigin, origin: profileOrigin },
          ]),
        ),
        status: () => exited(success(AUTH_OK)),
      }),
      {},
      [{ key: "k", origins: [queryOrigin] }],
    );
    return result.state === "connected";
  };
  assert.equal(
    await match("https://example.com", "https://www.example.com"),
    false,
  );
  assert.equal(await match("https://example.com", "http://example.com"), false);
  assert.equal(
    await match("https://example.com", "https://example.com:8443"),
    false,
  );
  assert.equal(
    await match("https://example.com", "https://EXAMPLE.com."),
    true,
  );
});

test("a bare hostname and a full URL both match the same profile origin", async () => {
  for (const primaryDomain of [
    "example.com",
    "https://example.com/",
    "example.com.",
  ]) {
    const { result } = await stateFor(
      scripted({
        list: exited(success([PROFILE])),
        status: () => exited(success(AUTH_OK)),
      }),
      {},
      [{ key: "k", origins: [primaryDomain] }],
    );
    assert.equal(result.state, "connected", primaryDomain);
  }
});

/* -------------------------------------------------------------------------- */
/* 33-35: nothing persisted, the resolver, and nothing thrown                 */
/* -------------------------------------------------------------------------- */

const temporaryRoots = [];
after(async () => {
  for (const root of temporaryRoots)
    await rm(root, { recursive: true, force: true });
});

test("a refresh writes nothing and carries no child output", async () => {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-integration-"));
  temporaryRoots.push(root);
  const { snapshot } = await stateFor(
    scripted({
      list: exited(success([PROFILE])),
      status: () => ({
        kind: "exited",
        code: 0,
        stdout: success(AUTH_OK),
        stderr: "a secret-looking diagnostic",
      }),
    }),
    { environment: { PATH: "/bin", NOVAMIRA_HQ_HOME: root } },
  );
  assert.deepEqual(await readdir(root), []);
  for (const result of snapshot.byKey.values()) {
    assert.deepEqual(Object.keys(result).sort(), ["profiles", "state"]);
    assert.ok(!JSON.stringify(result).includes("secret-looking"));
  }
});

test("the resolver honours the override, PATH, the Windows shim and nothing found", async () => {
  const override = createSiteCliResolver({
    environment: {
      NOVAMIRA_HQ_SITE_CLI: "/opt/novamira/bin/novamira",
      PATH: "/usr/bin",
    },
    platform: "linux",
    isFile: async () => true,
  });
  assert.deepEqual(await override(), {
    command: "/opt/novamira/bin/novamira",
    prefixArgs: [],
  });

  const posix = createSiteCliResolver({
    environment: { PATH: "/empty:/usr/local/bin" },
    platform: "linux",
    isFile: async (candidate) => candidate === "/usr/local/bin/novamira",
  });
  assert.deepEqual(await posix(), {
    command: "/usr/local/bin/novamira",
    prefixArgs: [],
  });

  // The layout `npm i -g @novamira/cli` actually writes on Windows: three shims
  // side by side, the *extensionless* one first in the probe order. It is a
  // POSIX `sh` script, not an executable image, so returning it would send
  // `CreateProcess` a file it cannot run and the `.cmd` fallback below — the
  // reason this whole branch exists — would never be reached.
  const shimDirectory = "C:\\Users\\op\\AppData\\Roaming\\npm";
  const entry = `${shimDirectory}\\node_modules\\@novamira\\cli\\dist\\index.js`;
  const npmShims = new Set([
    `${shimDirectory}\\novamira`,
    `${shimDirectory}\\novamira.cmd`,
    `${shimDirectory}\\novamira.ps1`,
    entry,
  ]);
  const windowsShim = createSiteCliResolver({
    environment: { Path: shimDirectory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    isFile: async (candidate) => npmShims.has(candidate),
  });
  assert.deepEqual(await windowsShim(), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    prefixArgs: [entry],
  });

  // The same layout with the entry script missing resolves to nothing at all,
  // rather than to a shim nothing can spawn.
  const windowsNoEntry = createSiteCliResolver({
    environment: { Path: shimDirectory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    isFile: async (candidate) => npmShims.has(candidate) && candidate !== entry,
  });
  assert.equal(await windowsNoEntry(), undefined);

  // The second layout: `bin` beside `lib`, which nvm-windows and npm's default
  // prefix use.
  const libEntry = `C:\\Users\\op\\AppData\\Roaming\\lib\\node_modules\\@novamira\\cli\\dist\\index.js`;
  const windowsLib = createSiteCliResolver({
    environment: { Path: shimDirectory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    isFile: async (candidate) =>
      candidate === `${shimDirectory}\\novamira` || candidate === libEntry,
  });
  assert.deepEqual(await windowsLib(), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    prefixArgs: [libEntry],
  });

  const windowsExe = createSiteCliResolver({
    environment: { Path: shimDirectory },
    platform: "win32",
    isFile: async (candidate) => candidate === `${shimDirectory}\\novamira.exe`,
  });
  assert.deepEqual(await windowsExe(), {
    command: `${shimDirectory}\\novamira.exe`,
    prefixArgs: [],
  });

  const missing = createSiteCliResolver({
    environment: { PATH: "/usr/bin" },
    platform: "linux",
    isFile: async () => false,
  });
  assert.equal(await missing(), undefined);
});

test("connectionStates never rejects, whatever the child does", async () => {
  const scripts = [
    () => stopped("not_found"),
    () => stopped("spawn_failed"),
    () => stopped("timed_out"),
    () => stopped("aborted"),
    () => stopped("truncated"),
    () => exited(""),
    () => exited("<html>"),
    () => exited(failure("boom"), 4),
    () => exited(JSON.stringify({ ok: "maybe" })),
    () => exited(JSON.stringify({ ok: false })),
  ];
  for (const script of scripts) {
    const { integration } = harness(script);
    const snapshot = await integration.connectionStates([QUERY]);
    assert.equal(snapshot.byKey.get(QUERY.key).state, "unavailable");
  }
  const throwing = createSiteCliIntegration({
    spawn: async () => exited(success([])),
    resolve: async () => {
      throw new Error("probe exploded");
    },
    environment: {},
    now: () => NOW,
  });
  const snapshot = await throwing.connectionStates([QUERY]);
  assert.equal(snapshot.byKey.get(QUERY.key).reason, "cli_failed");
  assert.equal(snapshot.cliAvailable, false);
});

/* -------------------------------------------------------------------------- */
/* The parsers, directly                                                      */
/* -------------------------------------------------------------------------- */

test("parseEnvelope accepts exactly one v1 envelope object", () => {
  assert.deepEqual(parseEnvelope(`  ${success([1])}\n`), {
    ok: true,
    data: [1],
  });
  assert.deepEqual(parseEnvelope(failure("usage_error")), {
    ok: false,
    code: "usage_error",
  });
  for (const stdout of [
    "",
    "null",
    "[]",
    "7",
    '{"ok":"yes"}',
    '{"ok":false}',
    '{"ok":false,"error":{}}',
    '{"ok":false,"error":{"code":""}}',
    "{} {}",
  ]) {
    assert.deepEqual(parseEnvelope(stdout), { ok: "malformed" }, stdout);
  }
});

test("the payload validators require what HQ reads and tolerate the rest", () => {
  assert.deepEqual(parseSitesList([{ ...PROFILE, extra: 1 }]), [PROFILE]);
  assert.equal(parseSitesList({}), undefined);
  assert.equal(parseSitesList([null]), undefined);
  assert.deepEqual(parseSitesList([]), []);

  assert.deepEqual(
    parseAuthStatus({
      credentialState: "fresh",
      restReachable: null,
      extra: 1,
    }),
    {
      credentialState: "fresh",
      restReachable: null,
    },
  );
  assert.deepEqual(
    parseAuthStatus({
      ...AUTH_OK,
      expiresAt: "2026-01-01T00:00:00Z",
      restError: "network_error",
    }),
    {
      credentialState: "fresh",
      restReachable: true,
      site: "prod",
      siteUrl: "https://example.com",
      expiresAt: "2026-01-01T00:00:00Z",
      restError: "network_error",
    },
  );
  assert.equal(
    parseAuthStatus({ credentialState: "fresh", restReachable: true, site: 7 }),
    undefined,
  );
  assert.equal(parseAuthStatus(null), undefined);
});

/* -------------------------------------------------------------------------- */
/* The spawn seam itself                                                      */
/* -------------------------------------------------------------------------- */

// `nodeSpawnChild` is the one place a real process starts, so it is the one
// place these cases can be made. The child is always this Node binary running an
// inline script: no `novamira` is ever started, nothing is read from `PATH`, and
// no network call is made. The property under test is the lesson carried over
// from `SpawnCommandExecutor` — a killed child must not look like a normal exit
// status — plus the caps, the argv rule, and "it never throws".

const NEVER_ABORTED = new AbortController().signal;

/** Run this Node binary with an inline script and default caps. */
function runNode(script, overrides = {}) {
  return nodeSpawnChild({
    command: process.execPath,
    args: ["-e", script],
    env: { ...process.env, NO_COLOR: "1" },
    timeoutMs: 10_000,
    maxStdoutBytes: 262_144,
    maxStderrBytes: 32_768,
    signal: NEVER_ABORTED,
    ...overrides,
  });
}

test("a child that runs to completion reports exited with its status", async () => {
  const ok = await runNode(
    "process.stdout.write('out'); process.stderr.write('err');",
  );
  assert.deepEqual(ok, {
    kind: "exited",
    code: 0,
    stdout: "out",
    stderr: "err",
  });

  const failed = await runNode("process.stdout.write('x'); process.exit(3);");
  assert.equal(failed.kind, "exited");
  assert.equal(failed.code, 3);
  assert.equal(failed.stdout, "x");
});

test("a killed child never looks like a normal exit status", async () => {
  // Per-child timer.
  const timedOut = await runNode("setTimeout(() => {}, 30000);", {
    timeoutMs: 50,
  });
  assert.equal(timedOut.kind, "timed_out");
  assert.equal(timedOut.code, null, "a killed child carries no exit status");

  // The shared refresh deadline, firing while the child runs.
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort();
  }, 50).unref();
  const aborted = await runNode("setTimeout(() => {}, 30000);", {
    signal: controller.signal,
  });
  assert.equal(aborted.kind, "aborted");
  assert.equal(aborted.code, null);

  // A deadline that has already passed starts no process at all.
  const already = await runNode("process.stdout.write('never');", {
    signal: AbortSignal.abort(),
  });
  assert.deepEqual(already, {
    kind: "aborted",
    code: null,
    stdout: "",
    stderr: "",
  });
});

test("output over the cap truncates, and the captured string stays under it", async () => {
  const overflowing = await runNode(
    "process.stdout.write('x'.repeat(400000));",
    { maxStdoutBytes: 1024 },
  );
  assert.equal(overflowing.kind, "truncated");
  assert.equal(overflowing.code, null);
  assert.ok(
    overflowing.stdout.length <= 1024,
    `captured ${String(overflowing.stdout.length)} bytes`,
  );

  const noisy = await runNode("process.stderr.write('e'.repeat(400000));", {
    maxStderrBytes: 512,
  });
  assert.equal(noisy.kind, "truncated");
  assert.ok(noisy.stderr.length <= 512);
});

test("a missing executable is not_found, and the seam never throws", async () => {
  const missing = await nodeSpawnChild({
    command: join(tmpdir(), "novamira-hq-no-such-executable"),
    args: ["--json"],
    env: {},
    timeoutMs: 1_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    signal: NEVER_ABORTED,
  });
  assert.equal(missing.kind, "not_found");
  assert.equal(missing.code, null);

  // A directory is not an executable: a different errno, and still an outcome.
  const directory = await nodeSpawnChild({
    command: tmpdir(),
    args: [],
    env: {},
    timeoutMs: 1_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    signal: NEVER_ABORTED,
  });
  assert.ok(["spawn_failed", "not_found"].includes(directory.kind));
  assert.equal(directory.code, null);
});

test("the child receives argv verbatim: no shell ever interprets it", async () => {
  const hostile = '; rm -rf / && echo $(whoami) `id` "quoted" | tee /tmp/x';
  const echoed = await nodeSpawnChild({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)));",
      hostile,
    ],
    env: { ...process.env },
    timeoutMs: 10_000,
    maxStdoutBytes: 262_144,
    maxStderrBytes: 32_768,
    signal: NEVER_ABORTED,
  });
  assert.equal(echoed.kind, "exited");
  assert.deepEqual(JSON.parse(echoed.stdout), [hostile]);
});

test("stdin is closed, so a child that reads it cannot hang the refresh", async () => {
  const outcome = await runNode(
    "let seen = false;" +
      "process.stdin.on('end', () => { seen = true; });" +
      "process.stdin.on('close', () => { process.stdout.write(String(seen)); });" +
      "process.stdin.resume();",
    { timeoutMs: 5_000 },
  );
  assert.equal(
    outcome.kind,
    "exited",
    "the child ended rather than being killed",
  );
});

test("siteCliChildEnv is what the seam is handed", () => {
  const environment = {
    PATH: "/bin",
    NOVAMIRA_HOME: "/home/operator/.novamira",
    NOVAMIRA_SITE: "operator-choice",
  };
  assert.deepEqual(siteCliChildEnv(environment), {
    ...environment,
    NOVAMIRA_UPDATE_CHECK: "0",
    NO_COLOR: "1",
  });
});

/* -------------------------------------------------------------------------- */
/* The production wiring                                                      */
/* -------------------------------------------------------------------------- */

test("the dashboard command builds the service from the real seams", async () => {
  // The failure this guards against is not a wrong answer but a missing one:
  // for connected-state detection to degrade rather than be switched off,
  // something on the shipped path has to construct the service. That is
  // `createDashboardIntegration`, and `createDashboardServer` takes the result
  // as a required dependency, so the command cannot compile without it.
  const calls = [];
  const scripted = createDashboardIntegration(
    { PATH: "/usr/local/bin" },
    {
      resolveSiteCli: async () => CLI,
      spawn: async (invocation) => {
        calls.push(invocation);
        return invocation.args.includes("list")
          ? exited(success([PROFILE]))
          : exited(success(AUTH_OK));
      },
      now: () => NOW,
    },
  );
  const snapshot = await scripted.connectionStates([QUERY]);
  assert.deepEqual(snapshot.byKey.get(QUERY.key), {
    state: "connected",
    profiles: ["prod"],
  });
  assert.equal(snapshot.checkedAt, NOW);
  assert.deepEqual(
    calls.map((invocation) => invocation.command),
    [CLI.command, CLI.command],
  );

  // The default seams, driven with an empty `PATH` so the real resolver finds
  // nothing: no child starts, and the answer is the degraded state with its
  // install hint rather than an error or a switched-off feature.
  const real = createDashboardIntegration({ PATH: "" });
  const absent = await real.connectionStates([QUERY]);
  assert.deepEqual(absent.byKey.get(QUERY.key), {
    state: "unavailable",
    profiles: [],
    reason: "cli_absent",
  });
  assert.equal(absent.cliAvailable, false);
  assert.match(SITE_CLI_INSTALL_HINT, /NOVAMIRA_HQ_SITE_CLI/);

  // And an override replaces the whole service, which is what a page test wants.
  const replaced = createDashboardIntegration(
    {},
    {
      integration: {
        connectionStates: async () => ({
          byKey: new Map(),
          checkedAt: 1,
          cliAvailable: true,
        }),
      },
    },
  );
  assert.equal((await replaced.connectionStates([])).checkedAt, 1);
});

/* -------------------------------------------------------------------------- */
/* Site-profile management: list, sign out, forget                            */
/* -------------------------------------------------------------------------- */

/*
 * The panel's half of the integration. Everything below is still injected: no
 * `novamira` child ever starts, and the assertions are about the argv HQ would
 * build, the states it derives, and what it refuses to build at all.
 *
 * The boundary rule is asserted structurally rather than by inspection — a
 * `SiteProfileSummary` has no field a token could go in — so what these cases
 * pin instead is the other half of it: that HQ passes a profile name and a
 * non-secret URL and nothing else, and that a failure is a reason enum with no
 * child text attached to it.
 */

const OTHER_PROFILE = {
  name: "staging",
  siteUrl: "https://staging.example.com",
  origin: "https://staging.example.com",
};

test("listProfiles lists once, then asks auth status per profile", async () => {
  const { integration, calls } = harness(
    scripted({
      list: exited(success([PROFILE, OTHER_PROFILE])),
      status: (invocation) =>
        exited(
          success(
            siteOf(invocation) === "prod"
              ? AUTH_OK
              : { ...AUTH_OK, site: "staging", credentialState: "expired" },
          ),
        ),
    }),
  );
  const listing = await integration.listProfiles();

  assert.equal(listing.cliAvailable, true);
  assert.equal(listing.reason, undefined);
  assert.equal(listing.checkedAt, NOW);
  // The site CLI's own order is preserved: a panel whose rows reorder between
  // two refreshes is a panel whose buttons move under the cursor.
  assert.deepEqual(
    listing.profiles.map((profile) => [profile.name, profile.state]),
    [
      ["prod", "connected"],
      ["staging", "reconnect_required"],
    ],
  );
  assert.equal(listing.profiles[0].siteUrl, "https://example.com");
  assert.equal(listing.profiles[0].origin, "https://example.com");

  // One `sites list`, then one `auth status` per profile — and `--site` is
  // always explicit, which is what stops an operator's NOVAMIRA_SITE redirecting
  // the probe.
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, sitesListArgs(10_000));
  assert.deepEqual(calls.slice(1).map(siteOf).sort(), ["prod", "staging"]);
  for (const invocation of calls)
    assert.equal(invocation.env.NOVAMIRA_UPDATE_CHECK, "0");
});

test("a listing that cannot be trusted is a reason, never an empty list", async () => {
  // An absent CLI: `cliAvailable: false` plus the reason the panel renders as
  // the install hint. Reporting zero profiles here would be a *wrong* answer.
  const { integration, calls } = harness(() => exited(success([])), {
    resolve: async () => undefined,
  });
  const absent = await integration.listProfiles();
  assert.deepEqual(absent, {
    profiles: [],
    checkedAt: NOW,
    cliAvailable: false,
    reason: "cli_absent",
  });
  assert.equal(calls.length, 0);

  // An old CLI that does not know the command answers `usage_error`, which
  // classifies as "update the site CLI" rather than as a transport failure.
  const old = harness(() => exited(failure("usage_error"), 2));
  const incompatible = await old.integration.listProfiles();
  assert.deepEqual(incompatible.profiles, []);
  assert.equal(incompatible.cliAvailable, true);
  assert.equal(incompatible.reason, "cli_incompatible");

  // A payload HQ does not know is `malformed_output`, not a partial list.
  const malformed = harness(() => exited(success([{ name: "prod" }])));
  const unreadable = await malformed.integration.listProfiles();
  assert.deepEqual(unreadable.profiles, []);
  assert.equal(unreadable.reason, "malformed_output");
});

test("one profile's own failure degrades that row and no other", async () => {
  const { integration } = harness(
    scripted({
      list: exited(success([PROFILE, OTHER_PROFILE])),
      status: (invocation) =>
        siteOf(invocation) === "prod"
          ? exited(
              success({
                ...AUTH_OK,
                restReachable: false,
                restError: "http_error",
              }),
            )
          : stopped("timed_out"),
    }),
  );
  const listing = await integration.listProfiles();

  // A usable credential the site would not confirm is `unreachable`, split out
  // from `unknown` because it is the failure an operator can act on without
  // touching the profile at all.
  assert.equal(listing.profiles[0].state, "unreachable");
  assert.equal(listing.profiles[0].reason, undefined);
  // A timed-out child is `unknown` plus the reason that selects its hint.
  assert.equal(listing.profiles[1].state, "unknown");
  assert.equal(listing.profiles[1].reason, "cli_timeout");
  // The whole list still rendered: one bad profile is not an outage.
  assert.equal(listing.cliAvailable, true);
  assert.equal(listing.reason, undefined);
});

test("expiresAt rides along as a time, and nothing else does", async () => {
  const { integration } = harness(
    scripted({
      list: exited(success([PROFILE])),
      status: () =>
        exited(
          success({
            ...AUTH_OK,
            credentialState: "near_expiry",
            expiresAt: "2026-09-01T00:00:00.000Z",
            // Members HQ does not read are ignored, never rejected — and never
            // carried onto the summary either.
            accessToken: "must-never-appear",
            refreshToken: "must-never-appear",
          }),
        ),
    }),
  );
  const [profile] = (await integration.listProfiles()).profiles;
  assert.equal(profile.state, "connected");
  assert.equal(profile.expiresAt, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(Object.keys(profile).sort(), [
    "expiresAt",
    "name",
    "origin",
    "siteUrl",
    "state",
  ]);
  assert.ok(!JSON.stringify(profile).includes("must-never-appear"));
});

test("logout and remove build the documented argv and read only ok", async () => {
  const { integration, calls } = harness(() => exited(success({})));

  assert.deepEqual(await integration.logoutProfile("prod"), { kind: "done" });
  assert.deepEqual(calls[0].args, [
    "--json",
    "--quiet",
    "--timeout",
    "30000",
    "--site",
    "prod",
    "auth",
    "logout",
  ]);

  assert.deepEqual(await integration.removeProfile("prod"), { kind: "done" });
  // No `--site` on remove: the name is the positional argument, and passing it
  // twice would let the two disagree. No `--yes`: the command is not
  // interactive, so there is no prompt for HQ to answer on the operator's behalf.
  assert.deepEqual(calls[1].args, [
    "--json",
    "--quiet",
    "--timeout",
    "30000",
    "sites",
    "remove",
    "prod",
  ]);
  assert.ok(!calls[1].args.includes("--yes"));
  // One child per action, and never a retry: a silent second attempt at "revoke
  // this credential" is a remote effect nobody asked for.
  assert.equal(calls.length, 2);
});

test("site_not_found is `missing`, and every other failure is a reason", async () => {
  const gone = harness(() => exited(failure("site_not_found"), 5));
  assert.deepEqual(await gone.integration.removeProfile("prod"), {
    kind: "missing",
  });

  const broken = harness(() => stopped("spawn_failed"));
  assert.deepEqual(await broken.integration.logoutProfile("prod"), {
    kind: "failed",
    reason: "cli_failed",
  });

  // The failure arm carries a reason enum and has nowhere to put child text.
  const noisy = harness(() => ({
    kind: "exited",
    code: 1,
    stdout: JSON.stringify({
      ok: false,
      error: { code: "http_error", message: "Bearer sk-must-never-appear" },
    }),
    stderr: "stderr must never appear",
  }));
  const outcome = await noisy.integration.logoutProfile("prod");
  assert.deepEqual(outcome, { kind: "failed", reason: "cli_failed" });
  assert.ok(!JSON.stringify(outcome).includes("must-never-appear"));

  const absent = harness(() => exited(success({})), {
    resolve: async () => undefined,
  });
  assert.deepEqual(await absent.integration.removeProfile("prod"), {
    kind: "failed",
    reason: "cli_absent",
  });
  assert.equal(absent.calls.length, 0);
});

test("a name the CLI's grammar refuses never reaches an argv array", async () => {
  const { integration, calls } = harness(() => exited(success({})));
  // A leading `-` is the case that matters: commander would read it as an
  // option, so `sites remove --json` would run a different command than the one
  // HQ meant. It is refused before anything is spawned, and the message names
  // the grammar rather than echoing the value.
  for (const name of ["--json", "-x", "", "a".repeat(65), "a b", ".dot"]) {
    await assert.rejects(
      () => integration.removeProfile(name),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.ok(!error.message.includes(name) || name === "");
        return true;
      },
      name,
    );
    await assert.rejects(() => integration.logoutProfile(name), {
      code: "usage_error",
    });
  }
  assert.equal(calls.length, 0);

  // The names the CLI does allow are passed straight through.
  for (const name of ["prod", "a.b", "a_b", "a-b", "0"]) {
    assert.deepEqual(await integration.logoutProfile(name), { kind: "done" });
  }
});
