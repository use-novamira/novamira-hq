// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The doctor: the engine's isolation rules, the eight checks in their frozen
 * order, and the exit-code invariant the installers depend on.
 *
 * Three things this suite exists to pin, none of which Go's `doctor` could have
 * had:
 *
 * 1. **A produced report is a successful invocation.** `novamira-hq doctor`
 *    exits 0 and emits `ok: true` whether the overall status is `pass`, `warn`
 *    or `fail`. `install.sh` and `install.ps1` run `doctor --offline` as their
 *    smoke test on a machine with no profiles and no site CLI, where two checks
 *    warn and the install is perfectly fine.
 * 2. **Two checks can never fail.** `profile.credentials` warns when a
 *    credential reference does not resolve, and `integration.site_cli` warns for
 *    every one of its four unhappy paths, because `@novamira/cli` is an optional
 *    integration.
 * 3. **Nothing secret reaches the report.** A profile's `env:` reference is
 *    rendered as `env:NAME`; the exported value appears nowhere in the
 *    serialized report.
 *
 * Fully offline and process-free: the site CLI is a scripted `SpawnChild` and a
 * scripted `ResolveSiteCli`, so no real `novamira` is ever started, and every
 * suite isolates itself under a temporary `NOVAMIRA_HQ_HOME`.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import {
  DOCTOR_CHECK_IDS,
  OFFLINE_DOCTOR_CHECK_IDS,
  runDoctor,
  runDoctorChecks,
} from "../dist/doctor/index.js";
import {
  createSiteCliProbe,
  MINIMUM_SITE_CLI_VERSION,
} from "../dist/integration/index.js";
import { main } from "../dist/main.js";
import { SkillStore } from "../dist/skills/index.js";

const SECRET = "kinsta-fake-not-a-real-secret";

const roots = [];

test.after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A probe whose child never runs: the resolver finds nothing. */
function absentProbe() {
  return createSiteCliProbe({
    resolve: async () => undefined,
    spawn: async () => {
      throw new Error("nothing may be spawned when the CLI is absent");
    },
    environment: {},
  });
}

/** A probe over a scripted child outcome. */
function scriptedProbe(outcome) {
  const calls = [];
  const probe = createSiteCliProbe({
    resolve: async () => ({ command: "/opt/novamira", prefixArgs: [] }),
    spawn: async (invocation) => {
      calls.push(invocation);
      return { code: null, stdout: "", stderr: "", ...outcome };
    },
    environment: {},
  });
  probe.calls = calls;
  return probe;
}

function envelope(data) {
  return { kind: "exited", code: 0, stdout: JSON.stringify(data) };
}

async function fixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-doctor-"));
  roots.push(home);
  const environment = {
    NOVAMIRA_HQ_HOME: home,
    ...(options.environment ?? {}),
  };
  const paths = platformPaths(environment, process.platform, home);
  if (options.config !== undefined) {
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.configFile, options.config, { mode: 0o600 });
  }
  const security = defaultFileSecurity();
  const store = new ConfigStore(
    paths.configFile,
    new ProfileLockManager(paths.stateDir, security),
    security,
  );
  return {
    home,
    paths,
    environment,
    dependencies: {
      paths,
      security,
      store,
      credentials: async () => ({
        diagnostic: () =>
          options.backend ?? {
            backend: "file",
            osBackedEncryption: false,
            warning: "the owner-only file fallback is not OS-backed",
          },
        read: async () => undefined,
      }),
      skills: new SkillStore(),
      probeSiteCli: options.probeSiteCli ?? absentProbe(),
      environment,
      ...(options.nodeVersion === undefined
        ? {}
        : { nodeVersion: options.nodeVersion }),
    },
  };
}

function checkOf(report, id) {
  const check = report.checks.find((entry) => entry.id === id);
  assert.ok(check !== undefined, `${id} is missing from the report`);
  return check;
}

/** Run `main` against captured streams and an isolated HQ root. */
async function run(argv, environment) {
  const out = [];
  const err = [];
  const code = await main(
    argv,
    {
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => err.push(chunk) },
    },
    // No `PATH`: `createSiteCliResolver` finds nothing and spawns nothing, so
    // even the composition-root path never starts a real `novamira`.
    environment,
  );
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/* -------------------------------------------------------------------------- */
/* 1-3: the engine                                                            */
/* -------------------------------------------------------------------------- */

test("1: definitions run in order, sequentially, and a thrower is isolated", async () => {
  const order = [];
  const running = [];
  const definition = (id, run) => ({
    id,
    run: async () => {
      running.push(id);
      assert.equal(running.length, 1, `${id} overlapped another check`);
      order.push(id);
      try {
        return await run();
      } finally {
        running.pop();
      }
    },
  });

  const report = await runDoctorChecks(
    [
      definition("first", async () => ({
        status: "pass",
        summary: "ok",
        evidence: {},
      })),
      definition("thrower", async () => {
        throw new Error("a path from someone else's machine: /home/other/.ssh");
      }),
      definition("third", async () => ({
        status: "warn",
        summary: "hmm",
        evidence: {},
      })),
    ],
    { offline: true, fix: false },
  );

  assert.deepEqual(order, ["first", "thrower", "third"]);
  assert.deepEqual(checkOf(report, "thrower"), {
    id: "thrower",
    status: "fail",
    summary: "The check could not be completed.",
    evidence: { error: "check_threw" },
  });
  // The thrown message never reaches the report: it can carry a path, a
  // provider body, or a credential reference.
  assert.ok(!JSON.stringify(report).includes("/home/other/.ssh"));
  assert.equal(report.status, "fail");
  assert.equal(report.version, 1);
});

test("2: the overall status is the worst member", async () => {
  const of = async (...statuses) =>
    (
      await runDoctorChecks(
        statuses.map((status, index) => ({
          id: `check.${String(index)}`,
          run: async () => ({ status, summary: status, evidence: {} }),
        })),
        { offline: false, fix: false },
      )
    ).status;
  assert.equal(await of("pass", "pass"), "pass");
  assert.equal(await of("pass", "warn"), "warn");
  assert.equal(await of("warn", "fail", "pass"), "fail");
  assert.equal(await of(), "pass");
});

test("3: the nine ids are frozen, and --offline runs the first eight", async () => {
  assert.deepEqual(
    [...DOCTOR_CHECK_IDS],
    [
      "runtime.node",
      "storage.permissions",
      "storage.atomic",
      "credential.backend",
      "config.schema",
      "profile.credentials",
      "skills.bundled",
      "integration.site_cli",
      "update.available",
    ],
  );
  assert.deepEqual(
    [...OFFLINE_DOCTOR_CHECK_IDS],
    DOCTOR_CHECK_IDS.filter((id) => id !== "update.available"),
  );

  // Offline: the ninth is absent from `checks` entirely rather than present and
  // reported "skipped". A record of a check that did not happen is noise, and
  // `--offline` promises no network operation of any kind.
  const { dependencies } = await fixture();
  const offline = await runDoctor(dependencies, { offline: true, fix: false });
  assert.deepEqual(
    offline.checks.map((check) => check.id),
    [...OFFLINE_DOCTOR_CHECK_IDS],
  );

  // Online, with a scripted checker: all nine, in order, with the ninth last.
  const online = await runDoctor(
    {
      ...dependencies,
      createUpdateChecker: () => ({
        registryIdentity: "https://registry.example.test",
        refresh: async () => ({
          current: "0.1.0",
          latest: "0.2.0",
          updateAvailable: true,
          checkedAt: "2026-08-05T00:00:00.000Z",
        }),
      }),
    },
    { offline: false, fix: false },
  );
  assert.deepEqual(
    online.checks.map((check) => check.id),
    [...DOCTOR_CHECK_IDS],
  );
  const update = online.checks.at(-1);
  assert.equal(update.status, "warn");
  assert.equal(update.evidence.latest, "0.2.0");
  assert.equal(update.evidence.registry, "https://registry.example.test");
  // A newer release is a warning and never a failure: an out-of-date install
  // still works.
  assert.notEqual(update.status, "fail");
});

test("3b: update.available warns, never fails, when the registry is unreachable", async () => {
  const { dependencies } = await fixture();
  const report = await runDoctor(
    {
      ...dependencies,
      createUpdateChecker: () => ({
        registryIdentity: "https://registry.example.test",
        refresh: async () => {
          throw new Error("the registry is unreachable");
        },
      }),
    },
    { offline: false, fix: false },
  );
  const update = report.checks.at(-1);
  assert.equal(update.id, "update.available");
  assert.equal(update.status, "warn");
  assert.equal(update.evidence.registry, "https://registry.example.test");
  // The thrown message never reaches the evidence.
  assert.ok(!JSON.stringify(report).includes("unreachable"));
  assert.notEqual(report.status, "fail");
});

/* -------------------------------------------------------------------------- */
/* 4-8: the individual checks                                                 */
/* -------------------------------------------------------------------------- */

test("4: runtime.node fails below 22 and passes on 22", async () => {
  const old = await fixture({ nodeVersion: "20.11.0" });
  const oldReport = await runDoctor(old.dependencies, {
    offline: true,
    fix: false,
  });
  assert.equal(checkOf(oldReport, "runtime.node").status, "fail");
  assert.equal(oldReport.status, "fail");

  const current = await fixture({ nodeVersion: "22.0.0" });
  const currentReport = await runDoctor(current.dependencies, {
    offline: true,
    fix: false,
  });
  const check = checkOf(currentReport, "runtime.node");
  assert.equal(check.status, "pass");
  assert.equal(check.evidence.node, "22.0.0");
  assert.equal(check.evidence.minimumMajor, 22);
});

test("5: storage.permissions fails on a group-readable config file and --fix repairs it", async () => {
  if (process.platform === "win32") return;
  const { dependencies, paths } = await fixture({
    config: JSON.stringify({
      version: 1,
      hostingProfiles: {},
      deployPaths: {},
    }),
  });
  await chmod(paths.configFile, 0o644);

  const before = await runDoctor(dependencies, { offline: true, fix: false });
  const failing = checkOf(before, "storage.permissions");
  assert.equal(failing.status, "fail");
  assert.equal(checkOf(before, "config.schema").status, "fail");
  assert.deepEqual(checkOf(before, "profile.credentials"), {
    id: "profile.credentials",
    status: "pass",
    summary: "No hosting profiles are configured.",
    evidence: { profiles: [] },
  });
  assert.equal(failing.fixed, undefined);
  const configTarget = failing.evidence.targets.find(
    (target) => target.label === "config.file",
  );
  assert.deepEqual(configTarget, {
    label: "config.file",
    kind: "file",
    exists: true,
    safe: false,
  });
  // Labels, never contents: nothing in the evidence is a filesystem path.
  for (const target of failing.evidence.targets)
    assert.deepEqual(Object.keys(target).sort(), [
      "exists",
      "kind",
      "label",
      "safe",
    ]);

  const after = await runDoctor(dependencies, { offline: true, fix: true });
  const repaired = checkOf(after, "storage.permissions");
  assert.equal(repaired.status, "pass");
  assert.equal(checkOf(after, "config.schema").status, "pass");
  assert.equal(repaired.fixed, true);
  assert.equal((await stat(paths.configFile)).mode & 0o777, 0o600);
});

test("6: storage.atomic warns on an uninitialized state directory and passes after --fix", async () => {
  const { dependencies, paths } = await fixture();
  const warned = await runDoctor(dependencies, { offline: true, fix: false });
  const warning = checkOf(warned, "storage.atomic");
  assert.equal(warning.status, "warn");
  assert.equal(warning.evidence.stateDir, paths.stateDir);

  const fixed = await runDoctor(dependencies, { offline: true, fix: true });
  assert.equal(checkOf(fixed, "storage.atomic").status, "pass");
});

test("7: credential.backend warns for the file fallback and passes for a keychain", async () => {
  const fallback = await fixture();
  const warned = await runDoctor(fallback.dependencies, {
    offline: true,
    fix: false,
  });
  const warning = checkOf(warned, "credential.backend");
  assert.equal(warning.status, "warn");
  assert.equal(warning.evidence.backend, "file");
  assert.equal(warning.evidence.osBackedEncryption, false);

  const keychain = await fixture({
    backend: { backend: "macos-keychain", osBackedEncryption: true },
  });
  const passed = await runDoctor(keychain.dependencies, {
    offline: true,
    fix: false,
  });
  assert.equal(checkOf(passed, "credential.backend").status, "pass");
});

test("8: config.schema warns when absent, fails when malformed, passes when valid", async () => {
  const absent = await fixture();
  assert.equal(
    checkOf(
      await runDoctor(absent.dependencies, { offline: true, fix: false }),
      "config.schema",
    ).status,
    "warn",
  );

  const broken = await fixture({ config: '{"version": 9, "wat": true}' });
  const brokenCheck = checkOf(
    await runDoctor(broken.dependencies, { offline: true, fix: false }),
    "config.schema",
  );
  assert.equal(brokenCheck.status, "fail");
  assert.deepEqual(brokenCheck.evidence, { exists: true, valid: false });

  const valid = await fixture({
    config: JSON.stringify({
      version: 1,
      hostingProfiles: {
        dev: { provider: "kinsta", credential: { type: "env", name: "K" } },
      },
      deployPaths: {},
    }),
  });
  const validCheck = checkOf(
    await runDoctor(valid.dependencies, { offline: true, fix: false }),
    "config.schema",
  );
  assert.equal(validCheck.status, "pass");
  assert.equal(validCheck.evidence.profileCount, 1);
  assert.equal(validCheck.evidence.deployPathCount, 0);
});

/* -------------------------------------------------------------------------- */
/* 9-11: the two checks that may never fail                                   */
/* -------------------------------------------------------------------------- */

const TWO_PROFILES = JSON.stringify({
  version: 1,
  hostingProfiles: {
    broken: {
      provider: "kinsta",
      credential: { type: "env", name: "MISSING_VAR" },
    },
    good: {
      provider: "instawp",
      credential: { type: "env", name: "INSTAWP_API_KEY" },
      companyId: "acme",
    },
  },
  deployPaths: {},
});

test("9: profile.credentials warns, never fails, and never carries the secret", async () => {
  const { dependencies } = await fixture({
    config: TWO_PROFILES,
    environment: { INSTAWP_API_KEY: SECRET },
  });
  const report = await runDoctor(dependencies, { offline: true, fix: false });
  const check = checkOf(report, "profile.credentials");
  assert.equal(check.status, "warn");
  assert.deepEqual(check.evidence.profiles, [
    {
      name: "broken",
      provider: "kinsta",
      credential: "env:MISSING_VAR",
      available: false,
      companyIdConfigured: false,
      apiBaseUrlConfigured: false,
    },
    {
      name: "good",
      provider: "instawp",
      credential: "env:INSTAWP_API_KEY",
      available: true,
      companyIdConfigured: true,
      apiBaseUrlConfigured: false,
    },
  ]);
  // The resolved value is discarded on the line that produced it.
  assert.ok(!JSON.stringify(report).includes(SECRET));
  // One broken reference must not condemn the installation.
  assert.notEqual(report.status, "fail");

  // `--profile` narrows the check without changing its severity.
  const narrowed = await runDoctor(dependencies, {
    offline: true,
    fix: false,
    profile: "good",
  });
  const only = checkOf(narrowed, "profile.credentials");
  assert.equal(only.status, "pass");
  assert.deepEqual(
    only.evidence.profiles.map((profile) => profile.name),
    ["good"],
  );
});

test("10: integration.site_cli warns for every unhappy path and never spawns a real CLI", async () => {
  const cases = [
    { label: "absent", probe: absentProbe(), reason: "cli_absent", hint: true },
    {
      label: "incompatible envelope",
      probe: scriptedProbe(
        envelope({ ok: false, error: { code: "usage_error" } }),
      ),
      reason: "cli_incompatible",
    },
    {
      label: "old version",
      probe: scriptedProbe(envelope({ ok: true, data: { version: "0.9.0" } })),
      reason: "cli_incompatible",
      version: "0.9.0",
    },
    {
      label: "timeout",
      probe: scriptedProbe({ kind: "timed_out" }),
      reason: "cli_timeout",
    },
    {
      label: "garbage",
      probe: scriptedProbe({ kind: "exited", code: 0, stdout: "not json" }),
      reason: "malformed_output",
    },
  ];
  for (const entry of cases) {
    const { dependencies } = await fixture({ probeSiteCli: entry.probe });
    const report = await runDoctor(dependencies, {
      offline: true,
      fix: false,
    });
    const check = checkOf(report, "integration.site_cli");
    assert.equal(check.status, "warn", entry.label);
    assert.equal(check.evidence.reason, entry.reason, entry.label);
    assert.equal(check.evidence.minimum, MINIMUM_SITE_CLI_VERSION, entry.label);
    if (entry.hint === true)
      assert.match(String(check.evidence.hint), /@novamira\/cli/, entry.label);
    if (entry.version !== undefined)
      assert.equal(check.evidence.version, entry.version, entry.label);
    // Never `fail`, and never enough to fail the report on its own.
    assert.notEqual(report.status, "fail", entry.label);
  }

  // The happy path, and the exact argv the probe uses.
  const ok = scriptedProbe(envelope({ ok: true, data: { version: "1.2.3" } }));
  const { dependencies } = await fixture({ probeSiteCli: ok });
  const report = await runDoctor(dependencies, { offline: true, fix: false });
  const check = checkOf(report, "integration.site_cli");
  assert.equal(check.status, "pass");
  assert.equal(check.evidence.version, "1.2.3");
  assert.deepEqual(ok.calls[0].args, ["--json", "--quiet", "--version"]);
  // The child environment carries the site CLI's update-check opt-out, and no
  // `NOVAMIRA_SITE` is injected.
  assert.equal(ok.calls[0].env.NOVAMIRA_UPDATE_CHECK, "0");
  assert.equal(ok.calls[0].env.NOVAMIRA_SITE, undefined);
});

test("11: skills.bundled passes against the shipped tree", async () => {
  const { dependencies } = await fixture();
  const report = await runDoctor(dependencies, { offline: true, fix: false });
  const check = checkOf(report, "skills.bundled");
  assert.equal(check.status, "pass");
  assert.deepEqual(check.evidence, {
    core: true,
    hosting: true,
    agentStub: true,
    missing: [],
  });
});

/* -------------------------------------------------------------------------- */
/* 12-14: the command                                                         */
/* -------------------------------------------------------------------------- */

test("12: a completed report is exit 0 and ok:true, whatever its status", async () => {
  // A fresh root: no config, no profiles, no site CLI. Several checks warn.
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-doctor-cli-"));
  roots.push(home);
  const warn = await run(["doctor", "--json", "--offline"], {
    NOVAMIRA_HQ_HOME: home,
  });
  assert.equal(warn.code, 0);
  const warnEnvelope = JSON.parse(warn.stdout);
  assert.equal(warnEnvelope.ok, true);
  assert.equal(warnEnvelope.data.version, 1);
  assert.equal(warnEnvelope.data.offline, true);
  assert.equal(warnEnvelope.data.fix, false);
  assert.ok(["warn", "fail"].includes(warnEnvelope.data.status));

  // And with a report that genuinely fails: an unparseable config file.
  const broken = await mkdtemp(join(tmpdir(), "novamira-hq-doctor-cli-"));
  roots.push(broken);
  await writeFile(join(broken, "config.json"), "{ not json", { mode: 0o600 });
  const fail = await run(["doctor", "--json", "--offline"], {
    NOVAMIRA_HQ_HOME: broken,
  });
  assert.equal(fail.code, 0);
  const failEnvelope = JSON.parse(fail.stdout);
  assert.equal(failEnvelope.ok, true);
  assert.equal(failEnvelope.data.status, "fail");
  assert.equal(
    failEnvelope.data.checks.find((check) => check.id === "config.schema")
      .status,
    "fail",
  );
});

test("13: human mode is one aligned line per check plus the overall status", async () => {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-doctor-human-"));
  roots.push(home);
  const result = await run(["doctor", "--offline"], {
    NOVAMIRA_HQ_HOME: home,
  });
  assert.equal(result.code, 0);
  const lines = result.stdout.trimEnd().split("\n");
  // `--offline`, so eight checks and the trailing overall line.
  assert.equal(lines.length, OFFLINE_DOCTOR_CHECK_IDS.length + 1);
  for (const [index, id] of OFFLINE_DOCTOR_CHECK_IDS.entries())
    assert.match(lines[index], new RegExp(`^(pass|warn|fail)\\s+${id}\\s+\\S`));
  assert.match(lines.at(-1), /^status: (pass|warn|fail)$/);
  // Evidence never reaches human stdout.
  assert.ok(!result.stdout.includes("minimumMajor"));
});

test("14: --offline makes no network request", async () => {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-doctor-offline-"));
  roots.push(home);
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("doctor --offline must not reach the network");
  };
  try {
    const result = await run(["doctor", "--json", "--offline"], {
      NOVAMIRA_HQ_HOME: home,
    });
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).ok, true);
  } finally {
    globalThis.fetch = original;
  }
});
