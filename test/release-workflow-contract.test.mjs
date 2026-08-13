// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflow = await readFile(
  join(root, ".github/workflows/release.yml"),
  "utf8",
);
const runbook = await readFile(join(root, "docs/releasing.md"), "utf8");

test("release metadata selects prerelease and stable dist-tags", async () => {
  const prerelease = runMetadata("v1.0.0-rc1");
  assert.match(prerelease, /^version=1\.0\.0-rc1$/m);
  assert.match(prerelease, /^dist_tag=next$/m);
  assert.match(prerelease, /^prerelease=true$/m);

  const temporary = await mkdtemp(join(tmpdir(), "novamira-release-test-"));
  try {
    await writeFile(join(temporary, "package.json"), '{"version":"1.0.0"}\n');
    const stable = run(
      "node",
      [join(root, "scripts/release-metadata.mjs"), "v1.0.0"],
      temporary,
    );
    assert.equal(stable.status, 0, stable.stderr);
    assert.match(stable.stdout, /^dist_tag=latest$/m);
    assert.match(stable.stdout, /^prerelease=false$/m);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("release ordering rejects equal and older dist-tag versions", () => {
  assert.equal(runMetadata("--assert-newer", "1.0.0-rc2", "1.0.0-rc1"), "");
  assert.notEqual(
    runMetadataResult("--assert-newer", "1.0.0-rc1", "1.0.0-rc1").status,
    0,
  );
  assert.notEqual(
    runMetadataResult("--assert-newer", "1.0.0", "1.1.0").status,
    0,
  );
});

test("release transaction is serialized, cross-platform, pinned, and rerunnable", () => {
  assert.match(workflow, /group: npm-release\n  cancel-in-progress: false/);
  for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.ok(workflow.includes(os), os);
  }
  assert.match(workflow, /needs: \[prepare, acceptance\]/);
  assert.match(
    workflow,
    /git merge-base --is-ancestor "\$commit" origin\/main/,
  );
  assert.match(workflow, /steps\.registry\.outputs\.publish == 'true'/);
  assert.match(workflow, /published tarball integrity does not match/);
  assert.match(workflow, /gh release view/);
  assert.match(workflow, /gh release upload .*--clobber/);
  assert.ok(!/uses: [^\n]+@v\d/.test(workflow), "actions must be SHA-pinned");
});

test("first-publication and accepted risks are explicit", () => {
  assert.match(runbook, /NPM_BOOTSTRAP_TOKEN/);
  assert.match(runbook, /public repository/i);
  assert.match(runbook, /trusted publisher/i);
  assert.match(runbook, /Cancel the automatic tag-triggered run/);
  assert.match(runbook, /delete.*NPM_BOOTSTRAP_TOKEN/is);
  assert.match(runbook, /Accepted Risks/);
});

function runMetadata(...args) {
  const result = runMetadataResult(...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function runMetadataResult(...args) {
  return run("node", ["scripts/release-metadata.mjs", ...args], root);
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}
