// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Invoked by desktop-smoke with isolated storage and no external runtimes. */
export async function verifyCommandRegistration(executable, home, environment) {
  const name =
    process.platform === "win32"
      ? "novamira-hq-desktop.exe"
      : "novamira-hq-desktop";
  const bundle = join(home, "App space & ' !", "Novamira HQ.app");
  const app =
    process.platform === "darwin"
      ? join(bundle, "Contents", "MacOS", name)
      : join(bundle, name);
  await mkdir(dirname(app), { recursive: true });
  await copyFile(executable, app);
  if (process.platform === "darwin")
    await writeFile(
      join(bundle, "Contents", "Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.novamira.hq.desktop</string></dict></plist>',
    );
  const run = (command, args, input) =>
    spawnSync(command, args, {
      env: environment,
      encoding: "utf8",
      timeout: 60000,
      input,
    });
  const registered = run(app, ["--command-registration", "enable"]);
  assert.equal(registered.status, 0, registered.stderr);
  const { launcher } = JSON.parse(registered.stdout);
  for (const args of [
    ["--help"],
    ["hosting", "--help"],
    ["site-cli", "--help"],
    ["doctor", "--offline", "--json"],
    ["bad command ' & $ !", "a b", '"quoted"'],
  ]) {
    const direct = run(app, ["--cli", ...args], "piped input\n");
    const forwarded = run(launcher, args, "piped input\n");
    assert.equal(forwarded.status, direct.status, forwarded.stderr);
    if (args[0] === "doctor")
      assert.equal(JSON.parse(forwarded.stdout).ok, true);
    else {
      assert.equal(forwarded.stdout, direct.stdout);
      assert.equal(forwarded.stderr, direct.stderr);
    }
  }
  assert.equal(run(app, ["--command-registration", "enable"]).status, 0);
  // An in-place app update must keep command access.
  await copyFile(executable, app);
  assert.equal(run(launcher, ["--help"]).status, 0);
  const movedBundle = `${bundle} moved`;
  await rename(bundle, movedBundle);
  const moved = app.replace(bundle, movedBundle);
  if (process.platform !== "darwin") {
    const missing = run(launcher, ["--help"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /missing/);
  }
  assert.equal(run(moved, ["--command-registration", "repair"]).status, 0);
  assert.equal(run(launcher, ["--help"]).status, 0);
  return { launcher, executable: moved };
}
