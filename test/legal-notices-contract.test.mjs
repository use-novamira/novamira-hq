// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const manifest = JSON.parse(
  await readFile(new URL("../legal/manifest.json", import.meta.url), "utf8"),
);

test("bundled notices include license texts, versions, source and honest desktop coverage", async () => {
  const notice = await readFile(
    new URL("../dist/web/static/third-party-notices.txt", import.meta.url),
    "utf8",
  );
  for (const text of [
    "AGPL-3.0-or-later",
    "commander — 14.0.3",
    "MPL-2.0",
    "DESKTOP REVIEW STATUS: INCOMPLETE",
    "Corresponding Source",
    "Microsoft Corporation",
    "Runtime candidate: cssparser — 0.36.0",
    "DESKTOP RUNTIME SOURCE AUDIT — NOT RELEASE CLEARANCE",
    "third_party/glibc/LICENSE",
    "GNU LESSER GENERAL PUBLIC LICENSE",
  ])
    assert.ok(notice.includes(text), text);
  for (const file of new Set(
    manifest.components.flatMap((item) => item.licenseFiles),
  )) {
    const original = await readFile(
      new URL(`../legal/${file}`, import.meta.url),
      "utf8",
    );
    assert.ok(notice.includes(original.trimEnd()), file);
  }
  const result = spawnSync(
    process.execPath,
    ["scripts/legal-notices.mjs", "--check-desktop"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No release clearance/);
});

test("runtime source audit preserves every referenced original text and missing-text status", async () => {
  const inventory = JSON.parse(
    await readFile(
      new URL("../legal/denort-inventory.json", import.meta.url),
      "utf8",
    ),
  );
  const texts = JSON.parse(
    await readFile(
      new URL("../legal/denort-license-texts.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(inventory.status, "incomplete");
  assert.equal(inventory.packages.length, 900);
  assert.equal(
    inventory.packages.filter((p) => p.kind === "registry").length,
    844,
  );
  assert.equal(
    inventory.packages.filter((p) => p.kind === "registry" && !p.notices.length)
      .length,
    51,
  );
  for (const item of inventory.packages) {
    assert.ok(item.review);
    for (const notice of item.notices)
      assert.equal(
        createHash("sha256").update(texts[notice.sha256]).digest("hex"),
        notice.sha256,
      );
  }
});

test("offline notice generation rejects asset drift and missing license text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hq-legal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [
    "scripts/legal-notices.mjs",
    "legal",
    "LICENSE",
    "package.json",
    "bun.lock",
    "desktop/deno.lock",
    ...Object.keys(manifest.assetDigests),
    "node_modules/commander/package.json",
    "node_modules/@starfederation/datastar-sdk/package.json",
  ];
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(new URL(`../${path}`, import.meta.url), join(root, path), {
      recursive: true,
    });
  }
  const run = () =>
    spawnSync(process.execPath, [join(root, "scripts/legal-notices.mjs")], {
      encoding: "utf8",
      cwd: tmpdir(),
    });
  assert.equal(run().status, 0);
  const asset = Object.keys(manifest.assetDigests)[0];
  const original = await readFile(join(root, asset));
  await writeFile(join(root, asset), "changed asset");
  assert.match(run().stderr, /Legal inventory needs review: asset changed/);
  await writeFile(join(root, asset), original);
  await rm(join(root, "legal/licenses/commander.txt"));
  assert.notEqual(run().status, 0);
});
