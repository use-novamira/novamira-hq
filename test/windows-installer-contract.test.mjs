// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

test("running copies are stopped without stopping the uninstaller", () => {
  const stop = script.slice(
    script.indexOf("!macro StopRunning"),
    script.indexOf("!macroend"),
  );
  assert.ok(stop.includes("StartsWith('$INSTDIR\\'"));
  assert.ok(stop.includes("State\\command\\"));
  assert.ok(stop.includes("Name -ne 'Uninstall'"));
  assert.ok(stop.includes("Stop-Process -Force"));
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
  assert.doesNotMatch(script, /site-cli|novamira-hq\.exe"/);
});
