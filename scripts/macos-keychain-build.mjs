// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

// Universal helper: no Node/Swift installation is required on a user's Mac.
// The release signer signs/notarizes it; local builds are development only.
const root = fileURLToPath(new URL("..", import.meta.url));
export const helperBundle = join(
  root,
  "native",
  "macos",
  "Novamira HQ Credentials.app",
);
export async function buildKeychainHelper() {
  if (process.platform !== "darwin")
    throw new Error("The Keychain helper builds on macOS only.");
  const work = await mkdtemp(join(tmpdir(), "hq-keychain-build-"));
  const contents = join(helperBundle, "Contents");
  // Generated bundle only: never retain a stale signature from a prior build.
  await rm(helperBundle, { recursive: true, force: true });
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"), { recursive: true });
  await copyFile(join(root, "LICENSE"), join(contents, "Resources", "LICENSE"));
  function run(command, args) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.error || result.status !== 0)
      throw new Error("Keychain helper compilation failed.");
  }
  try {
    for (const architecture of ["arm64", "x86_64"]) {
      run("xcrun", [
        "swiftc",
        "-O",
        "-parse-as-library",
        "-target",
        `${architecture}-apple-macos11.0`,
        "-module-cache-path",
        join(work, "modules"),
        join(root, "native/macos/keychain.swift"),
        "-o",
        join(work, architecture),
      ]);
    }
    run("xcrun", [
      "lipo",
      "-create",
      join(work, "arm64"),
      join(work, "x86_64"),
      "-output",
      join(contents, "MacOS", "novamira-hq-keychain"),
    ]);
    await writeFile(
      join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.novamira.hq.credentials</string>
<key>CFBundleExecutable</key><string>novamira-hq-keychain</string>
<key>CFBundleName</key><string>Novamira HQ Credentials</string>
<key>CFBundleDisplayName</key><string>Novamira HQ Credentials</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await buildKeychainHelper();
