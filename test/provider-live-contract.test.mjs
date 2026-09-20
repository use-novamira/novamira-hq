// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The live provider gate's contract.
 *
 * `scripts/provider-live.mjs` is the one thing in the repository that may talk
 * to a real provider, so what it may *not* do is the part worth pinning. These
 * tests assert the two refusals that keep it off CI, the read-only shape of its
 * command table, and — the governing rule from `AGENTS.md`, enforced rather
 * than documented — that no workflow file carries a provider credential.
 *
 * Nothing here performs a live provider call. Every assertion is either static
 * or a run of the script that ends in a refusal before it spawns anything.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { PROVIDER_KINDS, defaultCredentialEnv } from "../dist/config/schema.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts/provider-live.mjs");
const source = await readFile(script, "utf8");
const conventions = await readFile(join(root, "AGENTS.md"), "utf8");
const runbook = await readFile(join(root, "docs/releasing.md"), "utf8");

const workflowDirectory = join(root, ".github/workflows");
const workflows = await Promise.all(
  (await readdir(workflowDirectory))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map(async (name) => ({
      name,
      text: await readFile(join(workflowDirectory, name), "utf8"),
    })),
);

test("the gate refuses to run unless it is asked for explicitly", () => {
  const result = runGate({});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /NOVAMIRA_HQ_LIVE_PROVIDERS is not set to 1/);
  assert.equal(result.stdout, "");
});

test("the gate refuses to run under CI even when it is asked for", () => {
  const result = runGate({ NOVAMIRA_HQ_LIVE_PROVIDERS: "1", CI: "true" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must never run in a workflow job/);
  assert.equal(result.stdout, "");

  // `CI=false` is still CI declaring itself; the check is presence, not truth.
  const falsey = runGate({ NOVAMIRA_HQ_LIVE_PROVIDERS: "1", CI: "false" });
  assert.equal(falsey.status, 2);
  assert.match(falsey.stderr, /must never run in a workflow job/);
});

test("the gate's command table is read-only", () => {
  const table = source.slice(
    source.indexOf("const READS = ["),
    source.indexOf("const READ_ONLY_VERBS"),
  );
  assert.ok(table.length > 0, "the command table must be findable");

  for (const verb of [
    "create",
    "create-plain",
    "clone",
    "push",
    "restore",
    "remove",
    "delete",
    "reset",
    "setup",
    "purge",
  ]) {
    assert.ok(
      !new RegExp(`"${verb}"`).test(table),
      `the live gate must not be able to issue "${verb}"`,
    );
  }

  // And the allowlist that backs the runtime check is itself only reads.
  const allowlist = source.slice(
    source.indexOf("const READ_ONLY_VERBS"),
    source.indexOf("const options ="),
  );
  assert.deepEqual(
    [...allowlist.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]).sort(),
    ["capabilities", "get", "list", "show", "validate"],
  );
});

test("the gate reports shapes, never values", () => {
  // The report is meant to be attachable to an issue, which is only true while
  // it carries key names and not the customer data behind them.
  assert.match(source, /function shapeOf\(data\)/);
  assert.match(source, /Object\.keys\(data\)/);
  assert.ok(
    !/Object\.values\(data\)/.test(source),
    "the report must not render response values",
  );
});

test("no workflow carries a provider credential", () => {
  const credentials = [
    ...PROVIDER_KINDS.map((kind) => defaultCredentialEnv(kind)),
    "PRESSABLE_CLIENT_ID",
    "WPE_API_USER_ID",
    "ROCKETNET_USERNAME",
    "CLOUDWAYS_EMAIL",
    "NOVAMIRA_HQ_LIVE_PROVIDERS",
  ];

  for (const { name, text } of workflows) {
    for (const credential of credentials) {
      assert.ok(
        !text.includes(credential),
        `${name} names ${credential}; no workflow may carry a provider credential or enable live provider calls`,
      );
    }
  }
});

test("the rule the gate enforces is written down where changes are made", () => {
  assert.match(conventions, /No workflow may carry provider credentials/);
  assert.match(runbook, /Verify provider adapters/);
  assert.match(runbook, /scripts\/provider-live\.mjs/);
});

function runGate(environment) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    // A clean environment, so the developer's own gate or CI variable cannot
    // change what these assertions mean.
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      ...environment,
    },
  });
}
