// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createProgram } from "../dist/cli/program.js";
import { platformPaths } from "../dist/config/paths.js";
import { VERSION, main } from "../dist/main.js";

/** Run `main` against captured streams and an isolated HQ root. */
async function run(argv, { root, env = {} } = {}) {
  const out = [];
  const err = [];
  const code = await main(
    argv,
    {
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => err.push(chunk) },
    },
    { ...(root === undefined ? {} : { NOVAMIRA_HQ_HOME: root }), ...env },
  );
  return { code, stdout: out.join(""), stderr: err.join("") };
}

async function isolated(body) {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-cli-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function recordingHandlers(calls) {
  return new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (...args) =>
          calls.push({ name, args }),
    },
  );
}

test("the reported version is the published version", async () => {
  const manifest = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  );
  // release.yml matches the git tag against package.json, so a drift here
  // would ship a binary that misreports itself.
  assert.equal(VERSION, manifest.version);

  const human = await run(["--version"]);
  assert.equal(human.code, 0);
  assert.equal(human.stdout, `${manifest.version}\n`);
  assert.equal(human.stderr, "");

  const json = await run(["--version", "--json"]);
  assert.equal(json.code, 0);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data, { version: manifest.version });
  assert.match(
    envelope.meta.requestId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("config path reports the resolved namespace without creating it", async () => {
  await isolated(async (root) => {
    const result = await run(["config", "path", "--json"], { root });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trimEnd().includes("\n"), false);

    const paths = platformPaths({ NOVAMIRA_HQ_HOME: root });
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data, {
      configFile: paths.configFile,
      configDir: paths.configDir,
      stateDir: paths.stateDir,
      locksDir: paths.locksDir,
      lockFile: paths.lockFile,
      cacheDir: paths.cacheDir,
      credentialsDir: paths.credentialsDir,
    });
    // Read-only: inspecting the paths must not materialise state or secrets.
    assert.deepEqual(await readdir(root), []);

    const human = await run(["config", "path"], { root });
    assert.equal(human.code, 0);
    assert.match(human.stdout, /^configFile\s+\S/m);
  });
});

test("usage failures exit 2 through the documented envelope", async () => {
  const cases = [[], ["not-a-command"], ["--timeout", "0"], ["config"]];
  for (const argv of cases) {
    const result = await run([...argv, "--json"]);
    assert.equal(result.code, 2, argv.join(" "));
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false, argv.join(" "));
    assert.equal(envelope.error.code, "usage_error", argv.join(" "));
    assert.equal(envelope.error.retryable, false);
  }

  // Help is not a failure, and commander's text is the renderer's only rival
  // on stdout.
  for (const argv of [["--help"], ["config", "--help"]]) {
    const result = await run(argv);
    assert.equal(result.code, 0, argv.join(" "));
    assert.match(result.stdout, /Usage: novamira-hq/);
    assert.equal(result.stderr, "");
  }
});

test("the command tree routes to the handler that owns each command", async () => {
  const cases = [
    { argv: ["--version"], name: "version", args: ["test"] },
    { argv: ["config", "path"], name: "configPath", args: [] },
    { argv: ["history"], name: "historyList", args: [] },
    {
      argv: ["config", "path", "--json", "--verbose", "--timeout", "500"],
      name: "configPath",
      args: [],
      options: {
        json: true,
        verbose: true,
        timeout: 500,
        timeoutExplicit: true,
      },
    },
  ];

  for (const entry of cases) {
    const calls = [];
    await createProgram("test", recordingHandlers(calls)).parseAsync(
      entry.argv,
      { from: "user" },
    );
    assert.equal(calls.length, 1, entry.name);
    assert.equal(calls[0].name, entry.name);
    const options = calls[0].args.at(-1);
    assert.deepEqual(calls[0].args.slice(0, -1), entry.args);
    // Defaults every command inherits, whether or not it was asked for.
    assert.equal(
      options.timeoutExplicit,
      entry.options?.timeoutExplicit ?? false,
    );
    for (const [name, value] of Object.entries(entry.options ?? {}))
      assert.equal(options[name], value, `${entry.name}.${name}`);
  }
});
