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
  const shippedBundle =
    process.platform === "darwin" ? enclosingApp(executable) : undefined;
  if (shippedBundle) {
    // A bundle's main executable is signed as part of that bundle, so rebuilding
    // a bundle around the executable alone makes the kernel kill it at launch
    // (SIGKILL, nothing on either stream). Copy the shipped bundle whole, which
    // is exactly what an installation does.
    await mkdir(dirname(bundle), { recursive: true });
    const copied = spawnSync("/usr/bin/ditto", [shippedBundle, bundle], {
      encoding: "utf8",
      timeout: 60000,
    });
    if (copied.error) throw copied.error;
    if (copied.status !== 0)
      throw new Error(
        `could not copy the application bundle: ${copied.stderr}`,
      );
  } else {
    await mkdir(dirname(app), { recursive: true });
    await copyFile(executable, app);
    if (process.platform === "darwin")
      await writeFile(
        join(bundle, "Contents", "Info.plist"),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.novamira.hq.desktop</string></dict></plist>',
      );
  }
  const run = (command, args, input) =>
    spawnSync(command, args, {
      env: environment,
      encoding: "utf8",
      timeout: 60000,
      input,
    });
  // A binary killed by the kernel (a code-signature or bundle rejection) exits
  // with `status: null` and writes nothing, which a bare status assertion
  // reports as an opaque "null !== 0". Name the signal and any captured output
  // so a release failure says which rejection happened.
  const describe = (result) =>
    [
      result.error ? `spawn error: ${result.error.message}` : "",
      `status=${result.status} signal=${result.signal}`,
      `stdout=${JSON.stringify((result.stdout ?? "").slice(0, 2000))}`,
      `stderr=${JSON.stringify((result.stderr ?? "").slice(0, 2000))}`,
    ]
      .filter(Boolean)
      .join("\n");
  const registered = run(app, ["--command-registration", "enable"]);
  assert.equal(registered.status, 0, describe(registered));
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
    assert.equal(forwarded.status, direct.status, describe(forwarded));
    if (args[0] === "doctor")
      assert.equal(JSON.parse(forwarded.stdout).ok, true);
    else {
      assert.equal(forwarded.stdout, direct.stdout);
      assert.equal(forwarded.stderr, direct.stderr);
    }
  }
  const reenabled = run(app, ["--command-registration", "enable"]);
  assert.equal(reenabled.status, 0, describe(reenabled));
  // Replace the executable atomically, as an app update does. Overwriting a
  // previously executed signed Mach-O in place leaves macOS's cached code
  // signature attached to a modified vnode and can cause a kernel SIGKILL.
  const replacement = `${app}.replacement`;
  await copyFile(executable, replacement);
  await rename(replacement, app);
  const updated = run(launcher, ["--help"]);
  assert.equal(updated.status, 0, describe(updated));
  const movedBundle = `${bundle} moved`;
  await rename(bundle, movedBundle);
  const moved = app.replace(bundle, movedBundle);
  if (process.platform !== "darwin") {
    const missing = run(launcher, ["--help"]);
    assert.equal(missing.status, 1, describe(missing));
    assert.match(missing.stderr, /missing/);
  }
  const repaired = run(moved, ["--command-registration", "repair"]);
  assert.equal(repaired.status, 0, describe(repaired));
  const resolved = run(launcher, ["--help"]);
  assert.equal(resolved.status, 0, describe(resolved));
  return { launcher, executable: moved };
}

/** The `.app` a macOS bundle main executable lives in, if it is in one. */
function enclosingApp(executable) {
  const marker = ".app/Contents/MacOS/";
  const end = executable.indexOf(marker);
  return end === -1 ? undefined : executable.slice(0, end + ".app".length);
}
