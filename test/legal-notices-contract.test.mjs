// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { isNoticePath } from "../scripts/license-archive.mjs";

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
    "DESKTOP REVIEW STATUS: MATERIALS-DOCUMENTED",
    "Corresponding Source",
    "Microsoft Corporation",
    "Microsoft WebView2 Loader — 1.0.1150.38",
    "Runtime candidate: cssparser — 0.36.0",
    "DESKTOP RUNTIME SOURCE AUDIT — NOT RELEASE CLEARANCE",
    "third_party/glibc/LICENSE",
    "GNU LESSER GENERAL PUBLIC LICENSE",
    "THIS APPLICATION INCLUDES LGPL-COVERED SOFTWARE",
    "WRITTEN OFFER FOR CORRESPONDING SOURCE",
    "dev@novamira.ai",
    "Standard license terms: Apache-2.0",
    "Published author credits: 강동윤",
    "Original source attribution",
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
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Desktop license materials verified/);
});

test("LGPL text is verbatim and the distributed offer covers relinking and retention", async () => {
  const read = (path) =>
    readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const native = JSON.parse(await read("legal/v8-source-notices.json"));
  assert.equal(
    (await read("legal/licenses/lgpl-2.1.txt")).trimEnd(),
    native.notices
      .find((item) => item.path === "third_party/glibc/LICENSE")
      .text.trimEnd(),
  );
  const offer = await read("legal/SOURCE-OFFER.txt");
  assert.match(offer, /at least three years after Ovation/);
  assert.match(offer, /last\n+distribution/);
  assert.match(offer, /section 6\(a\)/);
  assert.match(offer, /relink a modified executable/);
  const notices = await read("dist/web/static/third-party-notices.txt");
  assert.ok(notices.includes(offer));
  const guide = await read("license-docs/build-from-source.md");
  assert.ok(notices.includes(guide));
  assert.match(guide, /DENORT_BIN/);
  assert.match(guide, /V8_FROM_SOURCE=1/);
  assert.match(guide, /macOS Apple Silicon/);
  assert.match(guide, /HQ_LICENSE_REBUILD_20260928/);
  assert.ok(
    JSON.parse(await read("package.json")).files.includes("license-docs"),
  );
  const mac = await read("scripts/macos-sign.sh");
  assert.ok(mac.includes("Resources/Legal/SOURCE-OFFER.txt"));
  assert.ok(mac.includes("Resources/Legal/LGPL-2.1.txt"));
  assert.ok(mac.includes("Resources/Legal/license-docs"));
  assert.ok(
    mac.indexOf("Resources/Legal/SOURCE-OFFER.txt") <
      mac.indexOf("xcrun stapler staple"),
  );
  const linux = await read("scripts/desktop-build.mjs");
  assert.ok(linux.includes('join(tree, "SOURCE-OFFER.txt")'));
  assert.ok(linux.includes('join(tree, "LGPL-2.1.txt")'));
  assert.ok(linux.includes('join(tree, "license-docs")'));
  for (const workflow of ["macos-signing.yml", "release.yml"]) {
    const source = await read(`.github/workflows/${workflow}`);
    assert.ok(source.includes(".SOURCE-OFFER.txt"));
    assert.ok(source.includes(".build-from-source.md"));
    assert.ok(source.includes(".LGPL-2.1.txt"));
    assert.ok(source.includes(".THIRD-PARTY-NOTICES.txt"));
  }
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
  assert.ok(
    inventory.packages.find((item) => item.name === "wasite").notices.length,
  );
  for (const item of inventory.packages) {
    assert.ok(item.review);
    for (const notice of item.notices) {
      assert.ok(isNoticePath(notice.path), notice.path);
      assert.equal(
        createHash("sha256").update(texts[notice.sha256]).digest("hex"),
        notice.sha256,
      );
    }
  }
});

test("runtime target evidence stays consistent with the reviewed lock and notice inventory", async () => {
  const read = async (name) =>
    JSON.parse(
      await readFile(new URL(`../legal/${name}`, import.meta.url), "utf8"),
    );
  const inventory = await read("denort-inventory.json");
  const report = await read("runtime-targets.json");
  assert.equal(report.lockSha256, inventory.lockSha256);
  assert.equal(report.denoVersion, inventory.denoVersion);
  assert.deepEqual(
    Object.values(report.targets)
      .map((target) => target.triple)
      .sort(),
    [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
    ],
  );
  const packages = new Map(
    inventory.packages.map((item) => [`${item.name}@${item.version}`, item]),
  );
  for (const target of Object.values(report.targets)) {
    const ids = [...report.commonPackages, ...target.additionalPackages];
    assert.equal(new Set(ids).size, target.packageCount);
    assert.equal(ids.length, target.packageCount);
    for (const id of ids) assert.ok(packages.has(id), id);
    assert.deepEqual(
      target.packagesWithoutCollectedNotices,
      ids
        .filter(
          (id) =>
            packages.get(id).kind === "registry" &&
            packages.get(id).notices.length === 0,
        )
        .sort(),
    );
  }
});

test("offline notice generation rejects asset drift and missing license text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hq-legal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [
    "scripts/legal-notices.mjs",
    "scripts/windows-native.mjs",
    "scripts/windows-nsis.mjs",
    "scripts/runtime-license-evidence.mjs",
    "legal",
    "license-docs",
    "LICENSE",
    "package.json",
    "bun.lock",
    "desktop/deno.lock",
    ...Object.keys(manifest.assetDigests),
    "node_modules/commander/package.json",
    "node_modules/@novamira/cli/package.json",
    "node_modules/@starfederation/datastar-sdk/package.json",
  ];
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(new URL(`../${path}`, import.meta.url), join(root, path), {
      recursive: true,
    });
  }
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [join(root, "scripts/legal-notices.mjs"), ...args],
      {
        encoding: "utf8",
        cwd: tmpdir(),
      },
    );
  assert.equal(run().status, 0);
  const asset = Object.keys(manifest.assetDigests)[0];
  const original = await readFile(join(root, asset));
  await writeFile(join(root, asset), "changed asset");
  assert.match(run().stderr, /Legal inventory needs review: asset changed/);
  await writeFile(join(root, asset), original);
  const manifestPath = join(root, "legal/manifest.json");
  const originalManifest = await readFile(manifestPath, "utf8");
  const changed = JSON.parse(originalManifest);
  changed.components.find(
    (item) => item.id === "webview2-loader",
  ).artifact.sha256 = "0".repeat(64);
  await writeFile(manifestPath, JSON.stringify(changed));
  assert.match(
    run().stderr,
    /Legal inventory needs review: Windows WebView2 loader/,
  );
  await writeFile(manifestPath, originalManifest);
  const nsis = JSON.parse(originalManifest);
  const record = nsis.components.find((item) => item.id === "nsis");
  assert.equal(record.version, "3.13");
  assert.equal(record.artifact.filename, "nsis-3.13.zip");
  assert.deepEqual(record.licenseFiles, ["licenses/nsis.txt"]);
  record.artifact.sha256 = "0".repeat(64);
  await writeFile(manifestPath, JSON.stringify(nsis));
  assert.match(run().stderr, /Legal inventory needs review: NSIS installer/);
  await writeFile(manifestPath, originalManifest);
  // Historical audit-completeness flags do not substitute for evidence checks.
  for (const file of [
    "manifest.json",
    "denort-inventory.json",
    "v8-source-notices.json",
  ]) {
    const path = join(root, "legal", file);
    const value = JSON.parse(await readFile(path, "utf8"));
    if (file === "manifest.json") value.desktopReview.status = "incomplete";
    else value.status = "incomplete";
    await writeFile(path, JSON.stringify(value));
  }
  assert.equal(run("--check-desktop").status, 0);
  const evidencePath = join(root, "legal/runtime-license-evidence.json");
  const evidenceOriginal = await readFile(evidencePath, "utf8");
  const evidence = JSON.parse(evidenceOriginal);
  evidence.packages.shift();
  await writeFile(evidencePath, JSON.stringify(evidence));
  const missing = run("--check-desktop");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing license evidence/);
  const conflict = JSON.parse(evidenceOriginal);
  conflict.packages[0].selectedLicense = "Apache-2.0";
  await writeFile(evidencePath, JSON.stringify(conflict));
  assert.match(
    run("--check-desktop").stderr,
    /Unreviewed or conflicting license selection/,
  );
  const drift = JSON.parse(evidenceOriginal);
  drift.packages[0].archiveSha256 = "0".repeat(64);
  await writeFile(evidencePath, JSON.stringify(drift));
  assert.match(
    run("--check-desktop").stderr,
    /Changed license declaration or archive/,
  );
  await writeFile(evidencePath, evidenceOriginal);
  const runtimePath = join(root, "legal/denort-inventory.json");
  const runtimeOriginal = await readFile(runtimePath, "utf8");
  const unknown = JSON.parse(runtimeOriginal);
  unknown.packages.find((item) => item.notices.length > 0).license =
    "LicenseRef-Unknown";
  await writeFile(runtimePath, JSON.stringify(unknown));
  assert.match(
    run("--check-desktop").stderr,
    /Missing or unreviewed license declaration/,
  );
  await writeFile(runtimePath, runtimeOriginal);
  const termsPath = join(root, "legal/licenses/mit-terms.txt");
  const terms = await readFile(termsPath, "utf8");
  await writeFile(termsPath, "missing terms");
  assert.match(
    run("--check-desktop").stderr,
    /Missing or changed standard license text/,
  );
  await writeFile(termsPath, terms);
  const blocked = JSON.parse(await readFile(manifestPath, "utf8"));
  blocked.desktopReview.blockers = [
    "Required attribution for an embedded component is missing",
  ];
  await writeFile(manifestPath, JSON.stringify(blocked));
  assert.match(run("--check-desktop").stderr, /Required attribution/);
  await writeFile(manifestPath, originalManifest);
  await rm(join(root, "legal/licenses/commander.txt"));
  assert.notEqual(run().status, 0);
});
