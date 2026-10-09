// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercise the shipped container, not a source-tree npm installation. The
// shared smoke retains stdin for the server and isolates homes/runtime caches.
const artifact = resolve(
  process.argv[2] ??
    (process.platform === "linux"
      ? "dist-desktop/novamira-hq-desktop-linux-x86_64.tar.gz"
      : "dist-desktop/novamira-hq-setup-windows-x86_64.exe"),
);
const temporary = await mkdtemp(join(tmpdir(), "hq-artifact-"));
let mounted = false;
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
try {
  let binary = artifact;
  if (artifact.endsWith(".tar.gz")) {
    run("tar", ["-xzf", artifact, "-C", temporary]);
    const tree = join(temporary, "novamira-hq-desktop-linux-x86_64");
    for (const name of [
      "LICENSE",
      "SOURCE-OFFER.txt",
      "LGPL-2.1.txt",
      "THIRD-PARTY-NOTICES.txt",
      "INSTALL.txt",
      "ai.novamira.hq.desktop.desktop",
      "icons/hicolor",
    ]) {
      await stat(join(tree, name));
    }
    binary = join(tree, "novamira-hq-desktop");
  } else if (artifact.endsWith("-setup-windows-x86_64.exe")) {
    // No spaces: Node would quote the argument and NSIS requires /D= unquoted.
    const target = join(temporary, "NovamiraHQ");
    run(artifact, ["/S", `/D=${target}`]);
    for (const name of [
      "novamira-hq-desktop.exe",
      "Uninstall.exe",
      "LICENSE",
      "SOURCE-OFFER.txt",
      "LGPL-2.1.txt",
      "THIRD-PARTY-NOTICES.txt",
    ])
      await stat(join(target, name));
    // Upgrade over a running copy: the installer must stop it, then replace it.
    const running = spawn(join(target, "novamira-hq-desktop.exe"), ["--mcp"], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, NOVAMIRA_HQ_HOME: join(temporary, "home") },
    });
    const exited = once(running, "exit");
    await delay(3000);
    run(artifact, ["/S", `/D=${target}`]);
    await Promise.race([
      exited,
      delay(10_000).then(() => {
        throw new Error("The installer left a running copy behind");
      }),
    ]);
    run(process.execPath, [
      "scripts/desktop-smoke.mjs",
      join(target, "novamira-hq-desktop.exe"),
    ]);
    // Uninstall keeps settings, state and credentials.
    const data = join(process.env.LOCALAPPDATA ?? "", "Novamira HQ");
    const kept = join(data, "acceptance-sentinel.txt");
    await mkdir(data, { recursive: true });
    await writeFile(kept, "kept\n");
    try {
      run(join(target, "Uninstall.exe"), ["/S", `_?=${target}`]);
      await assert.rejects(stat(join(target, "novamira-hq-desktop.exe")));
      await stat(kept);
    } finally {
      await rm(kept, { force: true });
    }
    binary = undefined;
  } else if (artifact.endsWith(".dmg")) {
    run("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      temporary,
      artifact,
    ]);
    mounted = true;
    // Copy out of the disk image just as a clean installation does.
    const installed = `${temporary}-installed`;
    try {
      run("ditto", [
        join(temporary, "Novamira HQ.app"),
        join(installed, "Novamira HQ.app"),
      ]);
      run("codesign", [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        join(installed, "Novamira HQ.app"),
      ]);
      run(
        join(installed, "Novamira HQ.app/Contents/MacOS/novamira-hq-desktop"),
        ["--cli", "--version"],
      );
      run(process.execPath, [
        "scripts/desktop-smoke.mjs",
        join(installed, "Novamira HQ.app/Contents/MacOS/novamira-hq-desktop"),
      ]);
    } finally {
      await rm(installed, { recursive: true, force: true });
    }
    binary = undefined;
  }
  if (binary) run(process.execPath, ["scripts/desktop-smoke.mjs", binary]);
} finally {
  if (mounted) run("hdiutil", ["detach", temporary]);
  await rm(temporary, { recursive: true, force: true });
}
