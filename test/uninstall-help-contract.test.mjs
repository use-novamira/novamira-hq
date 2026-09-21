// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderUninstallHelp } from "../dist/web/views/settings.js";
import { renderHtml } from "../dist/web/html.js";

test("uninstall help separates executable removal from optional disconnection", () => {
  const markup = renderHtml(renderUninstallHelp());
  for (const text of [
    "npm uninstall -g @novamira/cli",
    "novamira sites list --json",
    "novamira --site PROFILE_NAME auth logout",
    "novamira sites remove PROFILE_NAME",
    "before uninstalling",
    "remote revocation can fail",
    "does not run removal commands",
  ])
    assert.ok(markup.includes(text), text);
  assert.doesNotMatch(markup, /<button|data-on:|rm -rf/);
  assert.equal(
    (markup.match(/<details class="uninstall-extra">/g) ?? []).length,
    2,
  );
  const simple = markup.slice(0, markup.indexOf("<details"));
  assert.ok(simple.includes("What stays"));
  assert.ok(!simple.includes("<pre"));
  assert.ok(
    markup.indexOf("novamira --site PROFILE_NAME auth logout") <
      markup.indexOf("npm uninstall -g @novamira/cli"),
  );
});

test("both installers explain the bundled CLI without installing a standalone copy", async () => {
  for (const path of ["install.sh", "install.ps1"]) {
    const source = await readFile(
      new URL(`../${path}`, import.meta.url),
      "utf8",
    );
    assert.ok(source.includes("site CLI is bundled"));
    assert.ok(!source.includes("npm uninstall -g @novamira/cli"));
  }
});
