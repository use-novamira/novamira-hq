// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");
test("DMG contains an untouched application and Applications shortcut with Finder layout", async () => {
  const script = await source("scripts/macos-dmg.sh");
  assert.match(script, /ditto "\$app" "\$work\/source\/Novamira HQ.app"/);
  assert.match(script, /ln -s \/Applications/);
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /hdiutil detach/);
  assert.match(script, /-format UDZO/);
  assert.match(script, /hdiutil verify/);
  assert.match(script, /Refusing to overwrite/);
  const layout = await source("scripts/macos/dmg-layout.applescript");
  assert.match(layout, /background picture/);
  assert.match(layout, /Novamira HQ.app.*190, 290/);
  assert.match(layout, /Applications.*530, 290/);
  assert.match(
    await source("scripts/macos/dmg-background.swift"),
    /Drag Novamira HQ to Applications/,
  );
});
test("DMG is assembled after app stapling and separately signed, notarized and stapled", async () => {
  const signer = await source("scripts/macos-sign.sh");
  assert.ok(
    signer.indexOf('stapler staple "$app"') <
      signer.indexOf('bash "$root/scripts/macos-dmg.sh"'),
  );
  assert.match(signer, /codesign --timestamp .*"\$binary.dmg"/);
  assert.match(signer, /notary submit "\$binary.dmg" --wait/);
  assert.match(signer, /stapler staple "\$binary.dmg"/);
  assert.match(signer, /stapler validate "\$binary.dmg"/);
  assert.match(signer, /spctl --assess --type open/);
  for (const workflow of ["release.yml", "macos-signing.yml"]) {
    assert.match(
      await source(`.github/workflows/${workflow}`),
      /dist-desktop\/\$\{\{ matrix.asset \}\}\.dmg/,
    );
  }
});
