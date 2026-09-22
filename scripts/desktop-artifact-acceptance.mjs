// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercise the shipped container, not a source-tree npm installation. The
// shared smoke retains stdin for the server and isolates homes/runtime caches.
const artifact = resolve(
  process.argv[2] ??
    (process.platform === "linux"
      ? "dist-desktop/novamira-hq-desktop-linux-x86_64.tar.gz"
      : "dist-desktop/novamira-hq-desktop.exe"),
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
