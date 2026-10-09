// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installNsis,
  NSIS_SHA256,
  NSIS_URL,
  NSIS_VERSION,
} from "../scripts/windows-nsis.mjs";

const script = await readFile(
  new URL("../scripts/windows/installer.nsi", import.meta.url),
  "utf8",
);
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("the installer is per-user, HKCU-only and installs at a stable path", () => {
  assert.match(script, /^RequestExecutionLevel user$/m);
  assert.ok(script.includes('InstallDir "$LOCALAPPDATA\\Programs\\${APP}"'));
  assert.match(script, /^!define APP "Novamira HQ"$/m);
  assert.doesNotMatch(script, /HKLM|\$PROGRAMFILES|EnVar|Environment"/);
  assert.doesNotMatch(script, /MUI_PAGE_DIRECTORY/);
  for (const key of [
    "DisplayName",
    "DisplayVersion",
    "Publisher",
    "InstallLocation",
    "UninstallString",
    "QuietUninstallString",
  ])
    assert.ok(
      script.includes(`WriteRegStr HKCU "\${UNINSTALL_KEY}" "${key}"`),
      key,
    );
});

test("the installer ships the legal files beside the app", () => {
  for (const name of [
    "novamira-hq-desktop.exe",
    "LICENSE",
    "SOURCE-OFFER.txt",
    "LGPL-2.1.txt",
    "THIRD-PARTY-NOTICES.txt",
  ])
    assert.match(script, new RegExp(escape(`File "\${STAGE}\\${name}"`)));
});

test("only HQ's own executables are stopped, by 64-bit PowerShell, and awaited", () => {
  const stop = script.slice(
    script.indexOf("!macro StopRunning"),
    script.indexOf("!macroend"),
  );
  // A 32-bit installer would otherwise start 32-bit PowerShell, which cannot
  // read the path of the 64-bit HQ process.
  assert.ok(stop.includes("${RunningX64}"));
  assert.ok(
    stop.includes(
      "$WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe",
    ),
  );
  assert.ok(stop.includes("Get-CimInstance Win32_Process"));
  // Exact executables, passed through the environment: no prefix match that
  // could reach other programs, no quoting of paths containing apostrophes.
  assert.ok(
    stop.includes(
      'SetEnvironmentVariable(t "HQ_STOP_APP", t "$INSTDIR\\${EXE}")',
    ),
  );
  assert.ok(
    stop.includes(
      'SetEnvironmentVariable(t "HQ_STOP_LAUNCHER", t "$LOCALAPPDATA\\Novamira HQ\\State\\command\\novamira-hq.exe")',
    ),
  );
  assert.ok(stop.includes("-in @($$env:HQ_STOP_APP, $$env:HQ_STOP_LAUNCHER)"));
  assert.doesNotMatch(stop, /StartsWith|'\$INSTDIR|'\$LOCALAPPDATA/);
  assert.ok(stop.includes("Wait-Process"));
  assert.ok(
    script.indexOf("!insertmacro StopRunning") <
      script.indexOf('SetOutPath "$INSTDIR"'),
  );
});

test("uninstall keeps settings and credentials", () => {
  const uninstall = script.slice(script.indexOf('Section "Uninstall"'));
  assert.ok(
    uninstall.includes('RMDir /r "$LOCALAPPDATA\\Novamira HQ\\State\\command"'),
  );
  assert.doesNotMatch(uninstall, /RMDir \/r "\$LOCALAPPDATA\\Novamira HQ"/);
  assert.doesNotMatch(uninstall, /\$APPDATA\\Novamira HQ/);
  assert.ok(uninstall.includes('DeleteRegKey HKCU "${UNINSTALL_KEY}"'));
});

test("signing has one marked place and no site CLI is installed", () => {
  assert.equal((script.match(/Code signing goes here/g) ?? []).length, 1);
  assert.doesNotMatch(script, /site-cli|File "[^"]*\\novamira-hq\.exe"/);
});

test("NSIS is pinned by version and checksum and a mismatch writes nothing", async () => {
  assert.equal(NSIS_VERSION, "3.13");
  assert.equal(
    NSIS_URL,
    "https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip",
  );
  assert.equal(
    NSIS_SHA256,
    "ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8",
  );
  const folder = await mkdtemp(join(tmpdir(), "hq-nsis-"));
  try {
    await assert.rejects(
      installNsis(folder, async () => new Response("tampered")),
      /NSIS checksum mismatch/,
    );
    assert.deepEqual(await readdir(folder), []);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("--package builds the installer on Windows from the staged legal files", async () => {
  const builder = await readFile(
    new URL("../scripts/desktop-build.mjs", import.meta.url),
    "utf8",
  );
  assert.match(builder, /platform === "win32"\)\s*await packageWindows\(\)/);
  const start = builder.indexOf("async function packageWindows");
  assert.ok(start >= 0, "packageWindows is defined");
  const windows = builder.slice(start);
  assert.match(windows, /installNsis\(/);
  assert.match(windows, /novamira-hq-setup-windows-x86_64\.exe/);
  for (const define of ["/DVERSION=", "/DSTAGE=", "/DOUTFILE="])
    assert.ok(windows.includes(define), define);
  for (const name of [
    "LICENSE",
    "SOURCE-OFFER.txt",
    "LGPL-2.1.txt",
    "THIRD-PARTY-NOTICES.txt",
    "novamira-hq.ico",
  ])
    assert.ok(windows.includes(name), name);
});

test("package acceptance installs, upgrades a running copy and uninstalls", async () => {
  const acceptance = await readFile(
    new URL("../scripts/desktop-artifact-acceptance.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(
    acceptance.includes("dist-desktop/novamira-hq-setup-windows-x86_64.exe"),
  );
  const start = acceptance.indexOf('endsWith("-setup-windows-x86_64.exe")');
  assert.ok(start >= 0, "installer branch exists");
  const windows = acceptance.slice(start);
  assert.ok(windows.includes('"/S", `/D=${target}`'));
  assert.ok(windows.includes('["--mcp"]'));
  assert.ok(windows.includes("Uninstall.exe"));
  assert.ok(windows.includes("`_?=${target}`"));
  assert.ok(windows.includes("acceptance-sentinel"));
  assert.ok(windows.includes("desktop-smoke.mjs"));
});

test("installer acceptance refuses to touch a real user setup", async () => {
  const acceptance = await readFile(
    new URL("../scripts/desktop-artifact-acceptance.mjs", import.meta.url),
    "utf8",
  );
  const windows = acceptance.slice(
    acceptance.indexOf('endsWith("-setup-windows-x86_64.exe")'),
  );
  assert.ok(windows.includes("process.env.CI"));
  assert.ok(windows.includes("--destructive"));
  assert.ok(
    windows.includes(
      "HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\NovamiraHQ",
    ),
  );
  assert.ok(
    windows.indexOf("--destructive") < windows.indexOf('"/S", `/D=${target}`'),
  );
});
