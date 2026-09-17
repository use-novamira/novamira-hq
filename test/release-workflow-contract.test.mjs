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
const verification = await readFile(
  join(root, ".github/workflows/macos-signing.yml"),
  "utf8",
);
const signer = await readFile(join(root, "scripts/macos-sign.sh"), "utf8");
const entitlements = await readFile(
  join(root, "scripts/macos/entitlements.plist"),
  "utf8",
);
const appIcon = await readFile(join(root, "scripts/macos/icon.png"));

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

test("macOS signing secrets are reachable from the signing job alone", () => {
  const jobs = workflow.split(/\n  (?=[a-z-]+:\n)/);
  const signing = jobs.filter((job) => job.includes("secrets.APPLE_"));
  assert.equal(signing.length, 1, "one job may see the Apple secrets");
  assert.ok(signing[0].startsWith("desktop-macos:"));
  assert.match(signing[0], /environment: macos-signing/);
  assert.match(signing[0], /bash scripts\/macos-sign\.sh/);
  // The gate is npm-release, upstream; this environment only scopes secrets.
  assert.match(signing[0], /needs: \[prepare, github-release\]/);
  for (const secret of [
    "APPLE_CERT_P12_BASE64",
    "APPLE_CERT_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_API_KEY_P8_BASE64",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER_ID",
  ]) {
    assert.ok(signer.includes(secret), `the signer requires ${secret}`);
    assert.ok(
      signing[0].includes(`secrets.${secret}`),
      `the job must pass ${secret}`,
    );
  }
  // Both macOS architectures, each compiled natively and signed on its own
  // runner, and each publishing its bare executable and its `.app.zip`.
  assert.match(signing[0], /runner: macos-latest/);
  assert.match(signing[0], /runner: macos-15-intel/);
  assert.match(signing[0], /novamira-hq-desktop-macos-arm64/);
  assert.match(signing[0], /novamira-hq-desktop-macos-x86_64/);
  assert.match(signing[0], /\$ASSET\.app\.zip/);
  assert.match(
    signing[0],
    /node scripts\/desktop-smoke\.mjs "dist-desktop\/\$ASSET"/,
  );
  assert.match(signing[0], /xcrun stapler validate/);
  // The unsigned matrix must not have grown a macOS leg back.
  const unsigned = jobs.find((job) => job.startsWith("desktop:"));
  assert.ok(!unsigned.includes("macos-latest"), "macOS signs in its own job");
});

test("Linux and Windows desktop assets carry their icons and are proved to run", () => {
  const jobs = workflow.split(/\n  (?=[a-z-]+:\n)/);
  const desktop = jobs.find((job) => job.startsWith("desktop:"));

  // Both executables, and Linux's tarball beside its bare one.
  assert.match(desktop, /asset: novamira-hq-desktop-linux-x86_64\n/);
  assert.match(desktop, /asset: novamira-hq-desktop-windows-x86_64\.exe\n/);
  assert.match(desktop, /archive: novamira-hq-desktop-linux-x86_64\.tar\.gz/);
  assert.match(desktop, /if \[ -n "\$ARCHIVE" \]/);

  // The Windows icon is embedded by the compile; the Linux one travels in the
  // archive, which is the whole reason `--package` exists.
  assert.match(desktop, /node scripts\/desktop-build\.mjs --package/);
  assert.match(desktop, /runner\.os == 'Linux'/);

  // Every compiled executable this release publishes is run before it is
  // uploaded, on the platform that compiled it.
  assert.match(desktop, /node scripts\/desktop-smoke\.mjs/);
  assert.ok(
    desktop.indexOf("desktop-smoke.mjs") < desktop.indexOf("gh release upload"),
    "the smoke test must run before the upload",
  );
});

test("the macOS signer hardens, notarizes and leaves no credential behind", () => {
  assert.match(signer, /^#!\/usr\/bin\/env bash$/m);
  assert.match(signer, /^set -euo pipefail$/m);
  // Notarization requires the Hardened Runtime and a secure timestamp.
  assert.match(signer, /--options runtime/);
  assert.match(signer, /--timestamp/);
  assert.match(signer, /--entitlements "\$entitlements"/);
  // An App Store Connect key, never a person's Apple ID and app password.
  assert.match(signer, /xcrun notarytool "\$@"/);
  assert.match(signer, /--key "\$api_key"/);
  assert.ok(!/--apple-id|--password/.test(signer));
  // `--wait` alone has been known to exit 0 on a rejected submission, and the
  // status alone never says which binary was rejected.
  assert.match(signer, /notary submit "\$work\/notarize\.zip" --wait/);
  assert.match(signer, /if \[ "\$status" != "Accepted" \]; then/);
  assert.match(signer, /notary log "\$\(field id "\$submission"\)"/);
  // Only a bundle can carry its ticket, so only the bundle is stapled.
  assert.match(signer, /xcrun stapler staple "\$app"/);
  assert.match(signer, /spctl --assess --type execute/);
  // The throwaway keychain, the .p12 and the .p8 go away on every exit path.
  assert.match(signer, /trap cleanup EXIT INT TERM/);
  assert.match(signer, /security delete-keychain/);
  assert.match(signer, /rm -f "\$certificate" "\$api_key"/);
  // A secret may be decoded into a file; none may reach stdout or stderr.
  for (const line of signer.split("\n")) {
    if (!/^\s*(echo|printf)/.test(line)) continue;
    if (/>\s*"\$/.test(line)) continue;
    assert.ok(
      !/APPLE_CERT_PASSWORD|APPLE_CERT_P12_BASE64|APPLE_API_KEY_P8_BASE64|keychain_password/.test(
        line,
      ),
      `the signer must not print a secret: ${line.trim()}`,
    );
  }
});

test("the app bundle carries its icon, built from one committed master", () => {
  // A PNG's IHDR is the first chunk: 8 signature bytes, 4 length, "IHDR",
  // then width and height as big-endian uint32s.
  assert.equal(appIcon.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(appIcon.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(appIcon.readUInt32BE(16), 1024);
  assert.equal(appIcon.readUInt32BE(20), 1024);
  // Derived at signing time from that master, never committed as an .icns.
  assert.match(signer, /icon=\$root\/scripts\/macos\/icon\.png/);
  assert.match(signer, /for size in 16 32 128 256 512; do/);
  assert.match(signer, /sips -z "\$size" "\$size" "\$icon"/);
  assert.match(signer, /sips -z "\$retina" "\$retina" "\$icon"/);
  assert.match(
    signer,
    /iconutil --convert icns "\$iconset"[\s\S]{0,80}Contents\/Resources\/novamira-hq\.icns/,
  );
  // An .icns nothing in Info.plist names is an .icns the Finder ignores.
  assert.match(
    signer,
    /<key>CFBundleIconFile<\/key>\n {2}<string>novamira-hq</,
  );
  assert.match(
    signer,
    /<key>CFBundleIconName<\/key>\n {2}<string>novamira-hq</,
  );
  // The iconset is scratch, and goes away on every exit path with the rest.
  assert.match(signer, /rm -rf "\$staging" "\$iconset"/);
});

test("the hardened-runtime exceptions are the three the shell needs", () => {
  const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(keys, [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    // `@webview/webview` dlopens a dylib `@denosaurs/plug` downloads; deleting
    // this key means vendoring and signing that dylib first.
    "com.apple.security.cs.disable-library-validation",
  ]);
  // `get-task-allow` is a debug entitlement and notarization refuses it.
  assert.ok(!entitlements.includes("get-task-allow"));
  assert.ok(!entitlements.includes("com.apple.security.app-sandbox"));
});

test("signing can be proved on demand, without publishing anything", () => {
  // Dispatch only: it must never fire on a tag, a push or a pull request.
  assert.match(verification, /^on:\n {2}workflow_dispatch:\n/m);
  assert.ok(!/^ {2}(push|pull_request|schedule):/m.test(verification));
  // It publishes nothing. No release, no registry, no write permission.
  assert.match(verification, /^permissions:\n {2}contents: read$/m);
  assert.ok(!verification.includes("gh release"));
  assert.ok(!verification.includes("contents: write"));
  assert.ok(!verification.includes("npm publish"));
  // The same script, the same secret scope and the same two architectures as
  // the release job, so a release cannot be the first time Intel is signed.
  assert.match(verification, /environment: macos-signing/);
  assert.match(verification, /bash scripts\/macos-sign\.sh/);
  assert.match(verification, /runner: macos-15-intel/);
  assert.match(verification, /novamira-hq-desktop-macos-x86_64/);
  // Here a missing secret is a failure: the release job's warning fallback
  // would make an unconfigured repository look configured.
  assert.ok(!verification.includes("::warning"));
  assert.match(verification, /xcrun stapler validate/);
  assert.ok(
    !/uses: [^\n]+@v\d/.test(verification),
    "actions must be SHA-pinned",
  );
});

test("the runbook explains the Apple credentials it asks for", () => {
  assert.match(runbook, /macos-signing/);
  assert.match(runbook, /Developer ID Application/);
  assert.match(runbook, /notariz/i);
  assert.match(runbook, /App Store Connect/);
  assert.match(runbook, /Verify macOS signing/);
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
