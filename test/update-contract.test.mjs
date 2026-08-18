// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `src/update/` and `novamira-hq update`: the dist-tag read, the install
 * command form, the cached record, the background notice, and the CLI.
 *
 * Fully offline, twice over. Every registry read goes through an injected
 * `fetch` that this file owns, and every install goes through an injected
 * `InstallRunner` that records its argv and never starts a process — so nothing
 * here reaches the npm registry and nothing here spawns a package manager. The
 * one case that proves it is the `--check` test, whose runner throws.
 *
 * Every suite isolates itself under a `NOVAMIRA_HQ_HOME` in a `mkdtemp`
 * directory, and one case additionally sets a bogus `NOVAMIRA_HOME` to assert
 * that HQ never reads it.
 */

import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import { defaultFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { main, VERSION } from "../dist/main.js";
import {
  distTagsUrl,
  fetchLatestVersion,
  installCommandFor,
  isNewer,
  normalizeRegistry,
  updateCheckEnabled,
  updateNotice,
  UpdateChecker,
  UPDATE_CHECK_FILE,
  UPDATE_CHECK_LOCK,
  createSpawnResolver,
} from "../dist/update/index.js";

const roots = [];

test.after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function home() {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-update-"));
  roots.push(root);
  return root;
}

/** A `fetch` that answers one dist-tags document and counts its calls. */
function registryFetch(latest, options = {}) {
  const calls = [];
  const fetchImplementation = async (url, init) => {
    calls.push({ url: String(url), init });
    if (options.throws === true) throw new Error("the registry is unreachable");
    const body = options.body ?? JSON.stringify({ latest });
    return new Response(body, {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch: fetchImplementation };
}

async function checkerFor(root, options = {}) {
  const paths = platformPaths(
    { NOVAMIRA_HQ_HOME: root },
    process.platform,
    root,
  );
  const security = defaultFileSecurity();
  const locks = new ProfileLockManager(paths.stateDir, security);
  const checker = new UpdateChecker(paths.stateDir, locks, security, {
    currentVersion: "1.0.0",
    ...options,
  });
  return { checker, paths, security, locks };
}

/* -------------------------------------------------------------------------- */
/* 1-2: the dist-tag URL                                                      */
/* -------------------------------------------------------------------------- */

test("1: distTagsUrl encodes the scope and demands HTTPS", () => {
  // `encodeURIComponent` encodes the `@` as well as the `/`. Both spellings
  // address the same registry route; what matters is that the `/` never reaches
  // the path unencoded, because `@novamira/hq` would be a different route.
  assert.equal(
    distTagsUrl().href,
    "https://registry.npmjs.org/-/package/%40novamira%2Fhq/dist-tags",
  );
  assert.equal(
    distTagsUrl("https://mirror.example.com/npm").href,
    "https://mirror.example.com/npm/-/package/%40novamira%2Fhq/dist-tags",
  );
  assert.ok(!distTagsUrl().href.includes("@novamira/hq"));
  assert.ok(distTagsUrl().href.includes("%2Fhq"));

  // Plain HTTP is refused outright...
  assert.throws(() => distTagsUrl("http://registry.example.com"), {
    code: "usage_error",
  });
  // ...and refused even with the opt-in, because the host is not loopback.
  assert.throws(() => distTagsUrl("http://registry.example.com", true), {
    code: "usage_error",
  });
  // A loopback host with the explicit opt-in is the one exception.
  assert.equal(
    distTagsUrl("http://127.0.0.1:4873", true).href,
    "http://127.0.0.1:4873/-/package/%40novamira%2Fhq/dist-tags",
  );
  assert.throws(() => distTagsUrl("http://127.0.0.1:4873"), {
    code: "usage_error",
  });
});

test("2: a registry URL carrying credentials is refused", () => {
  assert.throws(() => distTagsUrl("https://user:secret@registry.example.com"), {
    code: "usage_error",
  });
  assert.throws(() => distTagsUrl("https://token@registry.example.com"), {
    code: "usage_error",
  });
});

/* -------------------------------------------------------------------------- */
/* 3-5: fetchLatestVersion                                                    */
/* -------------------------------------------------------------------------- */

test("3: the request is anonymous and never follows a redirect", async () => {
  const registry = registryFetch("2.0.0");
  assert.equal(await fetchLatestVersion({ fetch: registry.fetch }), "2.0.0");
  assert.equal(registry.calls.length, 1);
  const [{ init }] = registry.calls;
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error");
  assert.deepEqual(init.headers, { accept: "application/json" });
  assert.ok(init.signal instanceof AbortSignal);
  // No cookie, no authorization, no credential, no telemetry: the whole request
  // is the URL and one `Accept`.
  const names = Object.keys(init.headers).map((name) => name.toLowerCase());
  assert.deepEqual(names, ["accept"]);
  assert.equal(init.credentials, undefined);
});

test("4: a 500 is retryable, a 404 is not, and garbage is a network_error", async () => {
  await assert.rejects(
    fetchLatestVersion({
      fetch: registryFetch("2.0.0", { status: 500 }).fetch,
    }),
    (error) => {
      assert.equal(error.code, "network_error");
      assert.equal(error.retryable, true);
      return true;
    },
  );
  await assert.rejects(
    fetchLatestVersion({
      fetch: registryFetch("2.0.0", { status: 404 }).fetch,
    }),
    (error) => {
      assert.equal(error.code, "network_error");
      assert.equal(error.retryable, false);
      return true;
    },
  );
  await assert.rejects(
    fetchLatestVersion({ fetch: registryFetch(null, { body: "{" }).fetch }),
    { code: "network_error" },
  );
  // A `latest` that is not a SemVer never becomes an install specifier.
  await assert.rejects(
    fetchLatestVersion({
      fetch: registryFetch(null, {
        body: JSON.stringify({ latest: "; rm -rf /" }),
      }).fetch,
    }),
    { code: "network_error" },
  );
  await assert.rejects(
    fetchLatestVersion({
      fetch: registryFetch("2.0.0", { throws: true }).fetch,
    }),
    (error) => {
      assert.equal(error.code, "network_error");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("5: an oversized body is abandoned mid-stream", async () => {
  // Declared over the limit: refused before a byte is read.
  const declared = async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-length": String(128 * 1024) },
    });
  await assert.rejects(fetchLatestVersion({ fetch: declared }), {
    code: "network_error",
  });

  // Undeclared and unbounded: refused by the incremental reader. The stream
  // records how many chunks it produced, so "abandoned" is asserted rather than
  // assumed.
  let chunks = 0;
  const chunked = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          chunks += 1;
          controller.enqueue(new Uint8Array(16 * 1024));
        },
      }),
      { status: 200 },
    );
  await assert.rejects(fetchLatestVersion({ fetch: chunked }), {
    code: "network_error",
  });
  assert.ok(chunks < 16, `the reader kept going: ${String(chunks)} chunks`);
});

/* -------------------------------------------------------------------------- */
/* 6: installCommandFor                                                       */
/* -------------------------------------------------------------------------- */

test("6: the install command is npm by default and bun under a bun global", () => {
  const npm = installCommandFor(
    "2.0.0",
    "/usr/lib/node_modules/@novamira/hq/dist/update/install.js",
    "https://registry.npmjs.org",
    "linux",
  );
  assert.equal(npm.command, "npm");
  assert.deepEqual(npm.args, [
    "install",
    "--global",
    "--ignore-scripts",
    "--registry",
    "https://registry.npmjs.org",
    "@novamira/hq@2.0.0",
  ]);

  // Windows resolves npm through a shim and `spawn` without a shell needs it.
  assert.equal(
    installCommandFor("2.0.0", "/usr/lib/node_modules/x.js", undefined, "win32")
      .command,
    "npm.cmd",
  );

  const bun = installCommandFor(
    "2.0.0",
    join("/home/x", ".bun", "install", "global", "node_modules", "hq.js"),
    "https://mirror.example.com",
    "linux",
  );
  assert.equal(bun.command, "bun");
  assert.deepEqual(bun.args, [
    "add",
    "--global",
    "--registry",
    "https://mirror.example.com",
    "@novamira/hq@2.0.0",
  ]);

  // The registry that answered the version is the registry installed from, in
  // both forms; the specifier is always the scoped package at the exact version.
  for (const command of [npm, bun]) {
    assert.ok(command.args.includes("--registry"));
    assert.ok(command.args.includes("@novamira/hq@2.0.0"));
  }
});

test("6b: the Windows runner resolves npm.cmd to its entry script, never a shell", async () => {
  const npmCmd = installCommandFor(
    "2.0.0",
    "/usr/lib/node_modules/x.js",
    undefined,
    "win32",
  );
  assert.equal(npmCmd.command, "npm.cmd");

  // The layout `npm i -g` actually writes on Windows: an `npm.cmd` shim beside
  // `node_modules/npm/bin/npm-cli.js`. The resolver returns Node with the entry
  // script as the one prefix argument, so `spawn` never sees a `.cmd` shim.
  const shimDirectory = "C:\\Users\\op\\AppData\\Roaming\\npm";
  const entry = `${shimDirectory}\\node_modules\\npm\\bin\\npm-cli.js`;
  const resolve = createSpawnResolver({
    environment: { Path: shimDirectory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    platform: "win32",
    isFile: async (candidate) =>
      candidate === `${shimDirectory}\\npm.cmd` || candidate === entry,
    execPath: "C:\\Program Files\\nodejs\\node.exe",
  });
  assert.deepEqual(await resolve(npmCmd), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    prefixArgs: [entry],
  });

  // The second layout: `bin` beside `lib`, which nvm-windows and npm's default
  // prefix use.
  const libEntry = `C:\\Users\\op\\AppData\\Roaming\\lib\\node_modules\\npm\\bin\\npm-cli.js`;
  const resolveLib = createSpawnResolver({
    environment: { Path: shimDirectory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    platform: "win32",
    isFile: async (candidate) =>
      candidate === `${shimDirectory}\\npm.cmd` || candidate === libEntry,
    execPath: "C:\\Program Files\\nodejs\\node.exe",
  });
  assert.deepEqual(await resolveLib(npmCmd), {
    command: "C:\\Program Files\\nodejs\\node.exe",
    prefixArgs: [libEntry],
  });

  // A missing shim or a missing entry script falls back to the bare name, so a
  // non-Windows npm or a bun command is never rewritten and argument safety is
  // unchanged on every other platform.
  const missing = createSpawnResolver({
    environment: { Path: "C:\\empty" },
    platform: "win32",
    isFile: async () => false,
    execPath: "C:\\node\\node.exe",
  });
  assert.deepEqual(await missing(npmCmd), {
    command: "npm.cmd",
    prefixArgs: [],
  });

  const posixNpm = installCommandFor(
    "2.0.0",
    "/usr/lib/node_modules/x.js",
    undefined,
    "linux",
  );
  const posix = createSpawnResolver({
    environment: { PATH: "/usr/bin" },
    platform: "linux",
    isFile: async () => false,
    execPath: "/usr/bin/node",
  });
  assert.deepEqual(await posix(posixNpm), { command: "npm", prefixArgs: [] });
});

/* -------------------------------------------------------------------------- */
/* 7-11: the cached record and the notice                                     */
/* -------------------------------------------------------------------------- */

test("7: check writes the frozen record, owner-only, under HQ's state dir", async () => {
  const root = await home();
  const registry = registryFetch("2.0.0");
  const { checker, paths, security } = await checkerFor(root, {
    fetch: registry.fetch,
    now: () => 1_700_000_000_000,
  });
  const status = await checker.check();
  assert.deepEqual(status, {
    current: "1.0.0",
    latest: "2.0.0",
    updateAvailable: true,
    checkedAt: "2023-11-14T22:13:20.000Z",
  });

  const recordPath = join(paths.stateDir, UPDATE_CHECK_FILE);
  assert.equal(checker.recordPath, recordPath);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.deepEqual(record, {
    version: 1,
    registry: "https://registry.npmjs.org",
    latest: "2.0.0",
    checkedAt: "2023-11-14T22:13:20.000Z",
  });
  assert.equal(await security.verifyFile(recordPath), true);
  if (process.platform !== "win32") {
    const info = await stat(recordPath);
    assert.equal(info.mode & 0o777, 0o600);
  }
  // The lock key is HQ's, and it is not a legal profile name.
  assert.equal(UPDATE_CHECK_LOCK, "__update_check__");
});

test("8: refresh inside the interval makes no request; a stale record does", async () => {
  const root = await home();
  const registry = registryFetch("2.0.0");
  let clock = 1_700_000_000_000;
  const { checker } = await checkerFor(root, {
    fetch: registry.fetch,
    now: () => clock,
  });

  assert.equal((await checker.refresh()).latest, "2.0.0");
  assert.equal(registry.calls.length, 1);
  // Inside the 24-hour interval: the record answers, and nothing is requested.
  assert.equal((await checker.refresh()).latest, "2.0.0");
  assert.equal((await checker.refresh()).latest, "2.0.0");
  assert.equal(registry.calls.length, 1);

  clock += 25 * 60 * 60 * 1000;
  assert.equal((await checker.refresh()).latest, "2.0.0");
  assert.equal(registry.calls.length, 2);
});

test("9: two concurrent refreshes make one request", async () => {
  const root = await home();
  const registry = registryFetch("2.0.0");
  const { checker } = await checkerFor(root, { fetch: registry.fetch });
  // One checker holds one lock manager, which is one process. The lock spans
  // the request as well as the write, so the second caller waits, re-reads the
  // record the first wrote, and finds it fresh.
  const [left, right] = await Promise.all([
    checker.refresh(),
    checker.refresh(),
  ]);
  assert.equal(left.latest, "2.0.0");
  assert.equal(right.latest, "2.0.0");
  assert.equal(registry.calls.length, 1);
});

test("10: a record from another registry, or with bad permissions, is not reused", async () => {
  const root = await home();
  const registry = registryFetch("2.0.0");
  const { checker, paths } = await checkerFor(root, {
    fetch: registry.fetch,
    registry: "https://mirror.example.com/npm/",
  });
  await checker.check();
  assert.equal(registry.calls.length, 1);
  assert.ok(
    registry.calls[0].url.startsWith("https://mirror.example.com/npm/"),
  );

  // The record is keyed by origin + path, trailing slash normalized away.
  const recordPath = join(paths.stateDir, UPDATE_CHECK_FILE);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.equal(record.registry, "https://mirror.example.com/npm");
  assert.equal(
    normalizeRegistry("https://mirror.example.com/npm/"),
    "https://mirror.example.com/npm",
  );

  // A different registry ignores it entirely and asks again.
  const other = registryFetch("3.0.0");
  const { checker: another } = await checkerFor(root, { fetch: other.fetch });
  assert.equal((await another.refresh()).latest, "3.0.0");
  assert.equal(other.calls.length, 1);

  // A world-readable record is deleted and treated as absent.
  if (process.platform !== "win32") {
    await writeFile(
      recordPath,
      JSON.stringify({
        version: 1,
        registry: "https://registry.npmjs.org",
        latest: "9.9.9",
        checkedAt: new Date().toISOString(),
      }),
    );
    // `writeFile`'s `mode` applies on creation only, and the file already
    // exists, so the relaxation has to be explicit.
    await chmod(recordPath, 0o644);
    const third = registryFetch("4.0.0");
    const { checker: fresh } = await checkerFor(root, { fetch: third.fetch });
    assert.equal((await fresh.refresh()).latest, "4.0.0");
    assert.equal(third.calls.length, 1);
    assert.notEqual(
      JSON.parse(await readFile(recordPath, "utf8")).latest,
      "9.9.9",
    );
  }
});

test("11: a failed check records latest:null, stays silent, and is not retried", async () => {
  const root = await home();
  const registry = registryFetch(null, { throws: true });
  const { checker, paths } = await checkerFor(root, { fetch: registry.fetch });
  assert.equal(await checker.refresh(), undefined);
  assert.equal(await checker.notice(), undefined);
  const record = JSON.parse(
    await readFile(join(paths.stateDir, UPDATE_CHECK_FILE), "utf8"),
  );
  assert.equal(record.latest, null);
  // Recorded, so an unreachable registry is not asked again on every command.
  assert.equal(registry.calls.length, 1);
  assert.equal(await checker.refresh(), undefined);
  assert.equal(registry.calls.length, 1);
  // An explicit `check()` still propagates, because there the operator asked.
  await assert.rejects(checker.check(), { code: "network_error" });
});

test("12: the notice names novamira-hq, and only when something is newer", async () => {
  const root = await home();
  const newer = registryFetch("2.0.0");
  const { checker } = await checkerFor(root, { fetch: newer.fetch });
  const message = await checker.notice();
  assert.equal(
    message,
    'A new novamira-hq release is available: 1.0.0 -> 2.0.0. Run "novamira-hq update" to install it.',
  );
  assert.ok(!message.includes("novamira update"));

  const same = await home();
  const current = registryFetch("1.0.0");
  const { checker: uptodate } = await checkerFor(same, {
    fetch: current.fetch,
  });
  assert.equal(await uptodate.notice(), undefined);

  assert.equal(isNewer("2.0.0", "1.0.0"), true);
  assert.equal(isNewer("1.0.0", "1.0.0"), false);
  // A prerelease sorts below the matching final release.
  assert.equal(isNewer("2.0.0-rc.1", "2.0.0"), false);
  assert.equal(isNewer("not-a-version", "1.0.0"), false);
  assert.equal(
    updateNotice({
      current: "1.0.0",
      latest: "2.0.0",
      updateAvailable: true,
      checkedAt: "",
    }),
    message,
  );
});

test("13: the opt-out is HQ's variable; the site CLI's have no effect", () => {
  assert.equal(updateCheckEnabled({}), true);
  assert.equal(updateCheckEnabled({ NOVAMIRA_HQ_UPDATE_CHECK: "0" }), false);
  assert.equal(
    updateCheckEnabled({ NOVAMIRA_HQ_UPDATE_CHECK: "false" }),
    false,
  );
  assert.equal(updateCheckEnabled({ NOVAMIRA_HQ_UPDATE_CHECK: "1" }), true);
  // The site CLI owns these two, and HQ never reads either.
  assert.equal(updateCheckEnabled({ NOVAMIRA_UPDATE_CHECK: "0" }), true);
  assert.equal(updateCheckEnabled({ NOVAMIRA_REGISTRY: "https://x" }), true);
});

/* -------------------------------------------------------------------------- */
/* 14-17: the CLI                                                             */
/* -------------------------------------------------------------------------- */

async function run(argv, environment, overrides = {}) {
  const out = [];
  const err = [];
  const code = await main(
    argv,
    {
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => err.push(chunk) },
    },
    environment,
    overrides,
  );
  return { code, stdout: out.join(""), stderr: err.join("") };
}

test("14: update --check reports and never spawns an installer", async () => {
  const root = await home();
  const registry = registryFetch("99.0.0");
  const result = await run(
    ["update", "--check", "--json"],
    { NOVAMIRA_HQ_HOME: root },
    {
      updateFetch: registry.fetch,
      installRunner: {
        run: () => {
          throw new Error("--check must never spawn a package manager");
        },
      },
    },
  );
  assert.equal(result.code, 0);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data, {
    current: VERSION,
    latest: "99.0.0",
    updateAvailable: true,
  });
  // `--check` reports; it does not claim to have done nothing, because it was
  // never asked to do anything.
  assert.equal("updated" in envelope.data, false);
  assert.equal(registry.calls.length, 1);
});

test("15: a bare update with nothing newer reports updated:false", async () => {
  const root = await home();
  const registry = registryFetch("0.0.1");
  const result = await run(
    ["update", "--json"],
    { NOVAMIRA_HQ_HOME: root },
    {
      updateFetch: registry.fetch,
      installRunner: {
        run: () => {
          throw new Error("nothing newer must not spawn a package manager");
        },
      },
    },
  );
  assert.equal(result.code, 0);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.data.updateAvailable, false);
  assert.equal(envelope.data.updated, false);
});

test("16: a bare update with a newer version runs the installer once", async () => {
  const root = await home();
  const registry = registryFetch("99.0.0");
  const invocations = [];
  const result = await run(
    ["update", "--json"],
    { NOVAMIRA_HQ_HOME: root },
    {
      updateFetch: registry.fetch,
      installRunner: {
        run: async (command, onOutput) => {
          invocations.push(command);
          onOutput("added 1 package <script>alert(1)</script>\n");
          return 0;
        },
      },
    },
  );
  assert.equal(result.code, 0);
  assert.equal(invocations.length, 1);
  assert.ok(invocations[0].args.includes("@novamira/hq@99.0.0"));
  assert.ok(invocations[0].args.includes("--ignore-scripts"));

  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.data.updated, true);
  assert.equal(envelope.data.from, VERSION);
  assert.equal(envelope.data.to, "99.0.0");
  assert.match(envelope.data.command, /@novamira\/hq@99\.0\.0$/);

  // Exactly one JSON value on stdout, and the installer's output nowhere near it.
  assert.equal(result.stdout.trimEnd().includes("\n"), false);
  assert.ok(!result.stdout.includes("added 1 package"));
  assert.ok(result.stderr.includes("added 1 package"));
});

test("17: a non-zero installer exit is an internal_error naming the command", async () => {
  const root = await home();
  const registry = registryFetch("99.0.0");
  const result = await run(
    ["update", "--json"],
    { NOVAMIRA_HQ_HOME: root },
    {
      updateFetch: registry.fetch,
      installRunner: { run: async () => 7 },
    },
  );
  assert.equal(result.code, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "internal_error");
  assert.match(envelope.error.message, /exited with status 7/);
  assert.match(envelope.error.message, /@novamira\/hq@99\.0\.0/);
});

/* -------------------------------------------------------------------------- */
/* 18-19: path isolation and the background notice                            */
/* -------------------------------------------------------------------------- */

test("18: the record lands under NOVAMIRA_HQ_HOME and nothing under NOVAMIRA_HOME", async () => {
  const hqRoot = await home();
  const siteRoot = await home();
  const registry = registryFetch("99.0.0");
  const result = await run(
    ["update", "--check", "--json"],
    {
      NOVAMIRA_HQ_HOME: hqRoot,
      // The site CLI's root, which HQ must never read or write.
      NOVAMIRA_HOME: siteRoot,
      NOVAMIRA_REGISTRY: "https://must-not-be-read.example.com",
      NOVAMIRA_UPDATE_CHECK: "0",
    },
    { updateFetch: registry.fetch },
  );
  assert.equal(result.code, 0);

  const paths = platformPaths(
    { NOVAMIRA_HQ_HOME: hqRoot },
    process.platform,
    hqRoot,
  );
  await stat(join(paths.stateDir, UPDATE_CHECK_FILE));
  await assert.rejects(stat(join(siteRoot, "state", UPDATE_CHECK_FILE)));
  await assert.rejects(stat(join(siteRoot, UPDATE_CHECK_FILE)));
  // The site CLI's registry variable was ignored.
  assert.ok(registry.calls[0].url.startsWith("https://registry.npmjs.org/"));
});

test("19: a non-interactive invocation emits no background notice and makes no request", async () => {
  const root = await home();
  let called = 0;
  const result = await run(
    ["--version"],
    { NOVAMIRA_HQ_HOME: root },
    {
      updateFetch: async () => {
        called += 1;
        throw new Error("a piped invocation must not consult the registry");
      },
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  // The suppressors are evaluated before the call, not after it: the point is
  // not to hide a line, it is to make no request and write no state.
  assert.equal(called, 0);
  await assert.rejects(
    stat(
      join(
        platformPaths({ NOVAMIRA_HQ_HOME: root }, process.platform, root)
          .stateDir,
        UPDATE_CHECK_FILE,
      ),
    ),
  );
});

/* -------------------------------------------------------------------------- */
/* 20: the empty-string override rule                                         */
/* -------------------------------------------------------------------------- */

test("20: an empty NOVAMIRA_HQ_REGISTRY is unset, not a broken registry URL", async () => {
  const root = await home();
  const registry = registryFetch("99.0.0");
  const result = await run(
    ["update", "--check", "--json"],
    { NOVAMIRA_HQ_HOME: root, NOVAMIRA_HQ_REGISTRY: "" },
    { updateFetch: registry.fetch },
  );
  // Before the fix this reached `new URL("/")` and exited `internal_error`.
  assert.equal(result.code, 0);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.latest, "99.0.0");
  assert.ok(registry.calls[0].url.startsWith("https://registry.npmjs.org/"));
});
