// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Compile the Deno desktop shell for this host, with the platform's icon.
//
// `deno compile --icon` is Windows-only — it refuses outright on any other
// target — so the compile is two tasks rather than one, and choosing between
// them is a decision about the host, which a `package.json` script cannot make
// portably. That is the whole reason this file exists; everything else it does
// is assembling what a compiled executable cannot carry inside itself.
//
// macOS needs nothing here: `scripts/macos-sign.sh` builds the `.icns` from the
// same master and puts it in the bundle it signs.
//
// Linux cannot embed an icon in an executable at all, so `--package` writes the
// tarball that carries the three files a desktop entry needs beside it. It is
// opt-in because gzipping an 80 MB executable is not something an edit-compile
// loop should pay for.

import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { arch, argv, exit, platform, stderr, stdout } from "node:process";
import { fileURLToPath, URL } from "node:url";

import { generateIcons, HICOLOR_SIZES, ICON_NAME } from "./desktop-icons.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist-desktop");
const iconDir = join(outDir, "icons");
const entry = "ai.novamira.hq.desktop.desktop";
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const desktopConfig = JSON.parse(
  await readFile(join(root, "desktop/deno.json"), "utf8"),
);
const desktopLock = JSON.parse(
  await readFile(join(root, "desktop/deno.lock"), "utf8"),
);
const cliVersion = manifest.dependencies["@novamira/cli"];
if (
  desktopConfig.imports["skills/cli"] !== "npm:skills@1.5.18/dist/cli.mjs" ||
  desktopLock.npm["skills@1.5.18"]?.integrity !==
    "sha512-WwQuqIhmS2nrn1H3HAbE2tGe7e2npc1cwMcucMKqmkBdqzm7nxzcZBTqXiHjUKhpalQLE/nNPtEdcx3QYX4TTw=="
) {
  fail("The embedded registrar must match the reviewed skills@1.5.18 archive");
}
if (
  !/^\d+\.\d+\.\d+$/.test(cliVersion) ||
  desktopConfig.imports["@novamira/cli/entry"] !==
    `npm:@novamira/cli@${cliVersion}/entry` ||
  !desktopLock.npm[`@novamira/cli@${cliVersion}`]?.integrity
) {
  fail(
    "npm and desktop must pin the same integrity-locked public site CLI release",
  );
}

/** The release's asset naming, which the workflow's matrix repeats. */
const ARCHITECTURES = { x64: "x86_64", arm64: "aarch64" };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: root,
    ...options,
  });
  if (result.error !== undefined) {
    fail(`could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function fail(message) {
  stderr.write(`desktop-build: ${message}\n`);
  exit(1);
}

const icons = await generateIcons({
  master: join(root, "scripts", "macos", "icon.png"),
  outDir: iconDir,
});
stdout.write(`Generated ${icons.length} desktop icons in ${iconDir}\n`);

run("deno", [
  "task",
  "--cwd",
  join(root, "desktop"),
  platform === "win32" ? "compile:windows" : "compile",
]);

const binary =
  platform === "win32" ? "novamira-hq-desktop.exe" : "novamira-hq-desktop";

run("deno", [
  "compile",
  "--config",
  "desktop/deno.json",
  "--allow-all",
  "--include",
  "dist/integration",
  "--output",
  join(
    outDir,
    platform === "win32" ? "spawn-acceptance.exe" : "spawn-acceptance",
  ),
  "desktop/spawn-acceptance.ts",
]);

run("deno", [
  "compile",
  "--config",
  "desktop/deno.json",
  "--allow-all",
  "--include",
  "dist",
  "--include",
  "skills",
  "--output",
  join(
    outDir,
    platform === "win32" ? "registrar-acceptance.exe" : "registrar-acceptance",
  ),
  "desktop/registrar-acceptance.ts",
]);

if (argv.includes("--package")) {
  if (platform !== "linux") {
    fail("--package assembles the Linux desktop archive and needs Linux");
  }
  await packageLinux();
}

stdout.write(`Compiled ${join(outDir, binary)}\n`);

/**
 * The Linux release archive: the executable, the freedesktop entry that names
 * it, and the hicolor icons that entry's `Icon=novamira-hq` resolves against.
 * `docs/releasing.md` and the README carry the four commands that install them.
 */
async function packageLinux() {
  const architecture = ARCHITECTURES[arch] ?? arch;
  const name = `novamira-hq-desktop-linux-${architecture}`;
  const stage = join(outDir, "stage");
  const tree = join(stage, name);

  await rm(stage, { recursive: true, force: true });
  await mkdir(tree, { recursive: true });
  await cp(join(outDir, binary), join(tree, binary));
  await cp(join(root, "LICENSE"), join(tree, "LICENSE"));
  await cp(join(root, "license-docs"), join(tree, "license-docs"), {
    recursive: true,
  });
  await cp(
    join(root, "legal/SOURCE-OFFER.txt"),
    join(tree, "SOURCE-OFFER.txt"),
  );
  await cp(
    join(root, "legal/licenses/lgpl-2.1.txt"),
    join(tree, "LGPL-2.1.txt"),
  );
  await cp(
    join(root, "dist/web/static/third-party-notices.txt"),
    join(tree, "THIRD-PARTY-NOTICES.txt"),
  );
  await cp(join(root, "desktop", entry), join(tree, entry));
  await cp(join(iconDir, "hicolor"), join(tree, "icons", "hicolor"), {
    recursive: true,
  });
  await writeFile(join(tree, "INSTALL.txt"), installNotes(name), "utf8");

  // Reproducible: the same commit produces the same archive, so a re-run of a
  // release job cannot publish a different tarball than the one it replaces.
  run("tar", [
    "--sort=name",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mtime=@0",
    "-czf",
    join(outDir, `${name}.tar.gz`),
    "-C",
    stage,
    name,
  ]);
  await rm(stage, { recursive: true, force: true });
  stdout.write(`Packaged ${join(outDir, `${name}.tar.gz`)}\n`);
}

function installNotes(name) {
  return [
    "Novamira HQ desktop application",
    "",
    "Install for the current user:",
    "",
    `  install -Dm755 ${binary} ~/.local/bin/${binary}`,
    "  cp -r icons/hicolor ~/.local/share/icons/",
    `  install -Dm644 ${entry} ~/.local/share/applications/${entry}`,
    "",
    "Then log out and back in, or run:",
    "",
    "  update-desktop-database ~/.local/share/applications",
    "  gtk-update-icon-cache ~/.local/share/icons/hicolor",
    "",
    "The window needs libwebkit2gtk-4.1 installed, and downloads the small",
    "native webview library into Deno's cache the first time it runs.",
    "",
    `Icons are installed at ${HICOLOR_SIZES.join(", ")} pixels under the name`,
    `"${ICON_NAME}", which is what the desktop entry's Icon key resolves.`,
    "",
    `Archive: ${name}`,
    "",
  ].join("\n");
}
