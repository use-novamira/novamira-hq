// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSiteCliResolver } from "../dist/integration/resolve.js";
import { forwardSiteCli } from "../dist/integration/forward.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("packaged forwarding works offline outside HQ with no global CLI and preserves child flags", async () => {
  const home = await mkdtemp(join(tmpdir(), "hq bundled cli "));
  try {
    const run = (args) =>
      spawnSync(process.execPath, [entry, "site-cli", ...args], {
        cwd: home,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: "",
          NOVAMIRA_HQ_SITE_CLI: "",
          NOVAMIRA_HQ_HOME: join(home, "hq"),
          NOVAMIRA_HOME: join(home, "site"),
        },
      });
    assert.equal(run(["--version"]).stdout.trim(), "1.3.0");
    const result = run(["guide", "list", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).data.guides.length > 0);
    assert.equal(result.stderr, "");
    assert.match(run(["--help"]).stdout, /Usage: novamira /);
    for (const argv of [
      ["update", "--json"],
      ["update", "--check", "--json"],
    ]) {
      const update = run(argv);
      assert.equal(update.status, 2);
      assert.match(
        JSON.parse(update.stdout).error.message,
        /Update Novamira HQ/,
      );
    }
    const wrapper = join(home, "selected CLI");
    if (process.platform !== "win32") {
      await writeFile(
        wrapper,
        `#!${process.execPath}\nprocess.stdin.pipe(process.stdout);process.stderr.write(JSON.stringify(process.argv.slice(2)));process.exitCode=17;\n`,
        { mode: 0o700 },
      );
      const forwarded = spawnSync(
        process.execPath,
        [entry, "site-cli", "--json", "--timeout", "37", "space ; $()"],
        {
          cwd: home,
          encoding: "utf8",
          input: "stdin bytes\n",
          timeout: 10_000,
          env: {
            ...process.env,
            NOVAMIRA_HQ_SITE_CLI: wrapper,
            NOVAMIRA_HQ_HOME: home,
          },
        },
      );
      assert.equal(forwarded.status, 17);
      assert.equal(forwarded.stdout, "stdin bytes\n");
      assert.deepEqual(JSON.parse(forwarded.stderr), [
        "--json",
        "--timeout",
        "37",
        "space ; $()",
      ]);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("forwarding uses the shared target, bounded lifetime, and inherited streams", async () => {
  const target = { command: "/HQ with spaces", prefixArgs: ["--site-cli"] };
  const resolve = createSiteCliResolver({
    environment: {},
    platform: "linux",
    packagedTarget: target,
    isFile: async () => false,
  });
  const code = await forwardSiteCli(
    ["--json"],
    resolve,
    {},
    async (invocation) => {
      assert.equal(invocation.command, target.command);
      assert.deepEqual(invocation.args, ["--site-cli", "--json"]);
      assert.equal(invocation.inheritStdio, true);
      assert.equal(invocation.env.NOVAMIRA_UPDATE_CHECK, "0");
      assert.equal(invocation.timeoutMs, 1_800_000);
      return { kind: "exited", code: 9, stdout: "", stderr: "" };
    },
  );
  assert.equal(code, 9);
});
