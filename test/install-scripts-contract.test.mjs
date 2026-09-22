// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("legacy installers direct users to desktop setup without a toolchain", async () => {
  for (const path of ["install.sh", "install.ps1"]) {
    const source = await readFile(path, "utf8");
    assert.match(
      source,
      /https:\/\/github.com\/use-novamira\/novamira-hq\/releases/,
    );
    assert.match(source, /Configure AI/);
    assert.match(source, /through MCP/);
    assert.doesNotMatch(source, /Connect your agents|novamira-hq site-cli/);
    assert.doesNotMatch(
      source,
      /npm install|npx|--global|Invoke-WebRequest|curl /,
    );
  }
  if (process.platform !== "win32") {
    const result = spawnSync("sh", ["install.sh"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No Node, npm, or Deno is required/);
  }
});

test("HQ is private and desktop artifact acceptance replaces public npm packaging", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.publishConfig, undefined);
  assert.equal(manifest.scripts["package:acceptance"], undefined);
  assert.match(
    manifest.scripts["desktop:acceptance"],
    /desktop-artifact-acceptance/,
  );
  assert.equal(manifest.dependencies["@novamira/cli"], "1.3.1");
});
