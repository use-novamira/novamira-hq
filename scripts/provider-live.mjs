#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The live provider gate: proof that an adapter still matches the API it
 * models.
 *
 * Every provider test in `test/` drives a loopback server that replies with
 * bodies we wrote. That proves the adapter is internally consistent; it cannot
 * prove that a provider still answers the way the adapter assumes, because
 * nothing in the suite has ever spoken to a provider. This script closes that
 * gap, and it is the only thing in the repository that does.
 *
 * It deliberately is not a workflow. The governing rule in `AGENTS.md` is that
 * live provider calls are gated behind an environment variable unset in CI and
 * that no workflow may carry provider credentials — a leaked CI secret would
 * hand an attacker the operator's whole hosting estate, which is a worse
 * outcome than a release without this evidence. So the gate runs on an
 * operator's machine, against their own profiles, and refuses to run under CI
 * at all. Its output is a redacted report to attach to the release issue.
 *
 * It is read-only by construction. The command table below is the entire set of
 * invocations it can make, every one of them a read, and `assertReadOnly`
 * fails the run if a command outside that table is ever reached. It creates
 * nothing, mutates nothing and deletes nothing.
 *
 *   NOVAMIRA_HQ_LIVE_PROVIDERS=1 node scripts/provider-live.mjs
 *   NOVAMIRA_HQ_LIVE_PROVIDERS=1 node scripts/provider-live.mjs --profile prod \
 *     --report live-report.md
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist/index.js");

/** The environment variable that must be set for any live call to happen. */
const GATE = "NOVAMIRA_HQ_LIVE_PROVIDERS";

/**
 * Every invocation this script may make, in order. `needs` names what an earlier
 * step must have discovered before the step can run; a step whose input was
 * never found is reported as skipped rather than guessed at.
 *
 * Adding a mutating command here is a bug, not a feature. `assertReadOnly`
 * rejects any verb outside this allowlist before the process is spawned.
 */
const READS = [
  {
    id: "providers.validate",
    args: ["hosting", "providers", "validate"],
    describes: "the credential is accepted by the provider",
  },
  {
    id: "providers.capabilities",
    args: ["hosting", "providers", "capabilities"],
    describes: "the capability set the adapter advertises",
  },
  {
    id: "sites.list",
    args: ["hosting", "sites", "list"],
    describes: "site inventory",
    discovers: (data) => ({ site: firstId(data?.sites ?? data) }),
  },
  {
    id: "sites.get",
    args: (found) => ["hosting", "sites", "get", found.site],
    needs: "site",
    describes: "one site, fetched by id",
  },
  {
    id: "envs.list",
    args: (found) => ["hosting", "envs", "list", "--site", found.site],
    needs: "site",
    describes: "the site's environments",
    discovers: (data) => ({ env: firstId(data?.environments ?? data) }),
  },
  {
    id: "backups.list",
    args: (found) => ["hosting", "backups", "list", "--env", found.env],
    needs: "env",
    describes: "the environment's backups",
  },
];

/** The only verbs a live invocation may use. */
const READ_ONLY_VERBS = new Set([
  "validate",
  "capabilities",
  "list",
  "get",
  "show",
]);

const options = parseArguments(process.argv.slice(2));

if (process.env[GATE] !== "1") {
  fail(
    `${GATE} is not set to 1.\n` +
      "This script makes real calls to real hosting providers with real\n" +
      "credentials. Set the gate deliberately, on a machine you control.",
  );
}

// The governing rule, enforced rather than documented. `CI` is set by GitHub
// Actions and by every other runner worth naming.
if (process.env["CI"] !== undefined) {
  fail(
    "CI is set. Live provider calls must never run in a workflow job, and no\n" +
      "workflow may carry provider credentials. Run this on an operator\n" +
      "machine and attach its report to the release issue instead.",
  );
}

const profiles =
  options.profiles.length > 0 ? options.profiles : await discoverProfiles();
if (profiles.length === 0) {
  fail("No hosting profiles are configured. Nothing to validate.");
}

const started = new Date();
const results = [];
for (const profile of profiles) {
  results.push(await validateProfile(profile));
}
const report = renderReport(results, started);

if (options.report !== undefined) {
  await mkdir(dirname(options.report), { recursive: true });
  await writeFile(options.report, report);
  process.stdout.write(`report written to ${options.report}\n`);
} else {
  process.stdout.write(report);
}

const failed = results.filter((result) => result.failures > 0);
process.exitCode = failed.length === 0 ? 0 : 1;

/** Drive the read sequence against one profile, stopping at nothing. */
async function validateProfile(profile) {
  const steps = [];
  const found = {};
  let failures = 0;
  let provider = "unknown";

  for (const read of READS) {
    if (read.needs !== undefined && found[read.needs] === undefined) {
      steps.push({
        id: read.id,
        status: "skipped",
        detail: `no ${read.needs}`,
      });
      continue;
    }
    const args = typeof read.args === "function" ? read.args(found) : read.args;
    assertReadOnly(args);

    const startedAt = Date.now();
    const outcome = await invoke(profile, args);
    const ms = Date.now() - startedAt;

    if (outcome.ok) {
      provider = outcome.data?.provider ?? provider;
      Object.assign(found, read.discovers?.(outcome.data) ?? {});
      steps.push({
        id: read.id,
        status: "pass",
        ms,
        detail: read.describes,
        shape: shapeOf(outcome.data),
      });
    } else {
      failures += 1;
      steps.push({ id: read.id, status: "fail", ms, detail: outcome.reason });
    }
  }

  return { profile, provider, steps, failures };
}

/**
 * Run one CLI invocation and classify it.
 *
 * `--json` is what makes the result checkable: the envelope itself is part of
 * the v1 contract, so a provider that has changed its response shape shows up
 * here as a malformed envelope or a failed invocation rather than as prose.
 */
async function invoke(profile, args) {
  const argv = ["--json", "--profile", profile, ...args];
  try {
    const { stdout } = await run(process.execPath, [cli, ...argv], {
      env: { ...process.env, NOVAMIRA_HQ_UPDATE_CHECK: "0" },
      maxBuffer: 32 * 1024 * 1024,
    });
    const envelope = JSON.parse(stdout);
    if (envelope?.ok !== true) {
      return { ok: false, reason: `envelope was not ok: ${code(envelope)}` };
    }
    return { ok: true, data: envelope.data };
  } catch (error) {
    // A non-zero exit still prints the v1 error envelope on stdout.
    const parsed = parse(error?.stdout);
    if (parsed !== undefined) {
      return { ok: false, reason: `${code(parsed)} (exit ${error.code})` };
    }
    return { ok: false, reason: `no envelope on stdout (exit ${error?.code})` };
  }
}

/** The error code of a v1 envelope, without any of its message text. */
function code(envelope) {
  return typeof envelope?.error?.code === "string"
    ? envelope.error.code
    : "unclassified";
}

function parse(value) {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * The keys of a response, never its values.
 *
 * This is the whole reason the report is safe to attach to an issue: a shape
 * tells a reviewer that a provider stopped returning `primaryDomain` without
 * putting one customer's domain, site id or backup name in a document.
 */
function shapeOf(data) {
  if (Array.isArray(data)) {
    return data.length === 0 ? "[]" : `[${shapeOf(data[0])} ×${data.length}]`;
  }
  if (data === null || typeof data !== "object") return typeof data;
  return `{${Object.keys(data).sort().join(", ")}}`;
}

function firstId(value) {
  const list = Array.isArray(value) ? value : [];
  const id = list[0]?.id ?? list[0]?.siteId ?? list[0]?.envId;
  return id === undefined ? undefined : String(id);
}

/** Refuse to spawn anything that is not one of the reads in the table. */
function assertReadOnly(args) {
  const verb = args.find((argument) => READ_ONLY_VERBS.has(argument));
  if (verb === undefined) {
    fail(
      `refusing to run "${args.join(" ")}": the live gate may only issue ` +
        `read commands (${[...READ_ONLY_VERBS].join(", ")})`,
    );
  }
}

/** Profiles come from HQ's own configuration, read through HQ itself. */
async function discoverProfiles() {
  const { stdout } = await run(process.execPath, [
    cli,
    "--json",
    "config",
    "list",
  ]);
  const envelope = JSON.parse(stdout);
  const listed = envelope?.data?.profiles ?? [];
  return listed.map((entry) => entry?.name ?? entry).filter(Boolean);
}

function renderReport(results, startedAt) {
  const lines = [
    "# Live provider validation",
    "",
    `Run: ${startedAt.toISOString()}`,
    `Host: operator machine (this report is refused under CI)`,
    "",
    "Read-only. No site, environment, backup, domain or DNS record was",
    "created, changed or deleted. Response *shapes* are recorded; response",
    "values are not.",
    "",
  ];

  for (const result of results) {
    const verdict =
      result.failures === 0 ? "pass" : `${result.failures} failed`;
    lines.push(`## ${result.profile} (${result.provider}) — ${verdict}`, "");
    lines.push("| Read | Status | ms | Shape or reason |");
    lines.push("| --- | --- | --- | --- |");
    for (const step of result.steps) {
      const detail = step.shape ?? step.detail ?? "";
      lines.push(
        `| \`${step.id}\` | ${step.status} | ${step.ms ?? ""} | ${detail} |`,
      );
    }
    lines.push("");
  }

  const failing = results.filter((result) => result.failures > 0);
  lines.push(
    failing.length === 0
      ? "Every profile answered every read. The adapters match the APIs they model."
      : `Adapters disagree with their provider on: ${failing
          .map((result) => result.profile)
          .join(", ")}.`,
    "",
  );
  return lines.join("\n");
}

function parseArguments(argv) {
  const parsed = { profiles: [], report: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      const value = argv[(index += 1)];
      if (value === undefined) fail("--profile needs a profile name");
      parsed.profiles.push(value);
    } else if (argument === "--report") {
      const value = argv[(index += 1)];
      if (value === undefined) fail("--report needs a path");
      parsed.report = value;
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
