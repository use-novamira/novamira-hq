// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `install.sh`, `install.ps1`, and what the package ships.
 *
 * Pure static analysis: this suite **runs nothing**. It reads the two installer
 * scripts and `package.json` as text and asserts the properties that a reviewer
 * would otherwise have to remember — the exact `skills@` pin, the
 * `--ignore-scripts` on the global install, the `doctor --offline` smoke test,
 * and the absence of anything that would make `@novamira/cli` a dependency.
 *
 * These are the highest-leverage lines in the repository and the least covered
 * by everything else: they run on a machine that has nothing installed, as
 * `curl … | sh`, usually as the very first thing a new user does. A regression
 * here is a broken first impression that no contract test would otherwise see.
 */

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const shell = await readFile(join(root, "install.sh"), "utf8");
const powershell = await readFile(join(root, "install.ps1"), "utf8");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const scripts = { "install.sh": shell, "install.ps1": powershell };

/**
 * The executable half of a script: every comment line removed.
 *
 * Both files carry a house-style header explaining what the Go did and why it
 * is not ported, which means the header legitimately *names* the things the
 * script must not do — `~/.claude`, `skills@latest`. A "does not contain"
 * assertion over the raw text would forbid explaining the rule while enforcing
 * it, so the negative assertions below read this instead. Both files use `#`
 * comments, and neither has a `#` inside a string.
 */
const code = Object.fromEntries(
  Object.entries(scripts).map(([name, source]) => [
    name,
    source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n"),
  ]),
);

test("1: install.sh is an executable POSIX sh script with strict mode", async () => {
  assert.ok(shell.startsWith("#!/bin/sh\n"));
  assert.match(shell, /^set -eu$/m);
  // `bash`-isms would break on dash and on BusyBox: this runs before the user
  // has anything, so it may only use what /bin/sh guarantees.
  assert.ok(!shell.includes("#!/bin/bash"));
  assert.ok(!/\[\[/.test(shell));

  if (process.platform !== "win32") {
    const info = await stat(join(root, "install.sh"));
    assert.equal(info.mode & 0o777, 0o755);
  }
});

test("2: both carry the SPDX header, and the shell one after its shebang", () => {
  for (const [name, source] of Object.entries(scripts)) {
    assert.ok(
      source.includes("SPDX-License-Identifier: AGPL-3.0-or-later"),
      name,
    );
    assert.ok(
      source.includes("SPDX-FileCopyrightText: 2026 Ovation S.r.l."),
      name,
    );
  }
  const lines = shell.split("\n");
  assert.equal(lines[0], "#!/bin/sh");
  assert.match(lines[1], /^# SPDX-FileCopyrightText:/);
});

test("3: both install @novamira/hq globally with --ignore-scripts", () => {
  for (const [name, source] of Object.entries(scripts)) {
    assert.ok(source.includes("@novamira/hq"), name);
    assert.ok(source.includes("novamira-hq"), name);
    assert.ok(source.includes("--ignore-scripts"), name);
    assert.ok(source.includes("--global"), name);
    // The site CLI's executable is never installed or invoked here.
    assert.ok(!/\bnovamira --version\b/.test(source), name);
  }
  assert.match(
    shell,
    /npm install --global --ignore-scripts "\$package"/,
    "install.sh",
  );
  assert.match(
    powershell,
    /"install", "--global", "--ignore-scripts", \$package/,
    "install.ps1",
  );
});

test("4: the skills CLI is pinned to an exact version, never a range", () => {
  const pin = /skills@(\d+\.\d+\.\d+)/;
  for (const [name, source] of Object.entries(code)) {
    const match = pin.exec(source);
    assert.ok(match, `${name} does not pin the skills CLI`);
    // An exact `x.y.z` and nothing else: `^`, `~`, `latest` and a bare major
    // are all a supply-chain hole with a scheduled trigger.
    assert.ok(!/skills@[\^~*]/.test(source), name);
    assert.ok(!/skills@latest/.test(source), name);
    assert.ok(!/skills@\d+(\.\d+)?["\s]/.test(source), name);
  }
  // Both scripts pin the same version.
  assert.equal(pin.exec(shell)[1], pin.exec(powershell)[1]);
  // …and it is the version the site CLI's installers pin, so a user installing
  // both tools does not fetch two copies of the same tool.
  assert.equal(pin.exec(shell)[1], "1.5.18");
});

test("5: the smoke test is doctor --offline, which is why a warn report exits 0", () => {
  for (const [name, source] of Object.entries(scripts)) {
    assert.ok(source.includes("doctor"), name);
    assert.ok(source.includes("--offline"), name);
    assert.ok(source.includes("--version"), name);
  }
  assert.match(shell, /"\$novamira_hq_bin" doctor --offline/);
  assert.match(
    powershell,
    /Invoke-Checked \$novamiraHqBin @\("doctor", "--offline"\)/,
  );
});

test("6: the agent skill is registered from the packaged directory, never written by hand", () => {
  for (const [name, source] of Object.entries(code)) {
    assert.ok(source.includes("skills/novamira-hq/SKILL.md"), name);
    assert.ok(
      source.includes("--skill novamira-hq") ||
        source.includes('"--skill", "novamira-hq"'),
      name,
    );
    assert.ok(source.includes("DISABLE_TELEMETRY"), name);
    assert.ok(source.includes("npm_config_ignore_scripts"), name);
    // Go hand-wrote ~/.agents/skills/novamira/SKILL.md and symlinked
    // ~/.claude/skills/novamira at it. Neither path appears here.
    assert.ok(!source.includes(".claude"), name);
    assert.ok(!source.includes(".agents"), name);
    assert.ok(!/\bln -s\b/.test(source), name);
    // NOVAMIRA_HQ_AGENT first, NOVAMIRA_AGENT as the shared fallback.
    assert.ok(source.includes("NOVAMIRA_HQ_AGENT"), name);
    assert.ok(source.includes("NOVAMIRA_AGENT"), name);
  }
});

test("7: @novamira/cli appears only as the optional closing hint", () => {
  for (const [name, source] of Object.entries(scripts)) {
    assert.ok(source.includes("@novamira/cli"), name);
    assert.ok(source.includes("Optional:"), name);
    // It is never installed, never required, and its absence never fails.
    assert.ok(!/npm install --global[^\n]*@novamira\/cli/.test(source), name);
    assert.ok(
      !/Invoke-Checked \$npm @\("install"[^\n]*@novamira\/cli/.test(source),
      name,
    );
    // The one mention is inside a message, not a command.
    for (const line of source.split("\n")) {
      if (!line.includes("@novamira/cli")) continue;
      assert.ok(
        line.includes("printf") ||
          line.includes("Write-Output") ||
          line.trimStart().startsWith("#"),
        `${name}: @novamira/cli outside a message: ${line}`,
      );
    }
  }
});

test("8: neither script carries a secret or fetches an unpinned URL", () => {
  for (const [name, source] of Object.entries(code)) {
    // No `curl … | sh`, no `iwr … | iex`: an installer that pipes another
    // download into a shell is an unbounded trust delegation.
    assert.ok(!/curl[^\n]*\|\s*(sh|bash)/.test(source), name);
    assert.ok(!/(iwr|irm)[^\n]*\|\s*iex/i.test(source), name);
    // No URL at all, in fact: everything comes from the npm registry the user's
    // package manager is already configured with.
    assert.ok(!/https?:\/\//.test(source), name);
    // Nothing that looks like a credential.
    assert.ok(!/(?:api[_-]?key|token|password|secret)\s*=/i.test(source), name);
    assert.ok(!/_authToken/.test(source), name);
  }
});

test("9: the installers are not shipped inside the package they install", () => {
  assert.deepEqual(manifest.files, ["dist", "skills", "README.md", "LICENSE"]);
  for (const entry of manifest.files) {
    assert.ok(!entry.includes("install.sh"), entry);
    assert.ok(!entry.includes("install.ps1"), entry);
  }
  // `bin` and the two runtime dependencies, restated here because the
  // installers' contract depends on both.
  assert.deepEqual(manifest.bin, { "novamira-hq": "dist/index.js" });
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    "@starfederation/datastar-sdk",
    "commander",
  ]);
  // No lifecycle script, so `--ignore-scripts` costs the user nothing.
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"])
    assert.equal(manifest.scripts[lifecycle], undefined, lifecycle);
  // The acceptance script the workflows run.
  assert.ok(
    manifest.scripts["package:acceptance"].includes("package-acceptance"),
  );
});
