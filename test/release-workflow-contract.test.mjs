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

test("release metadata selects prerelease and stable desktop releases", async () => {
  const prerelease = await runMetadataIn(
    { version: "1.0.0-beta1" },
    "v1.0.0-beta1",
  );
  assert.equal(prerelease.status, 0, prerelease.stderr);
  assert.match(prerelease.stdout, /^version=1\.0\.0-beta1$/m);
  assert.doesNotMatch(prerelease.stdout, /dist_tag/);
  assert.match(prerelease.stdout, /^prerelease=true$/m);

  const stable = await runMetadataIn({ version: "1.0.0" }, "v1.0.0");
  assert.equal(stable.status, 0, stable.stderr);
  assert.doesNotMatch(stable.stdout, /dist_tag/);
  assert.match(stable.stdout, /^prerelease=false$/m);
});

/** The actions a job uses, in order, each pinned to a full commit SHA. */
function pinnedActions(job) {
  return [...job.matchAll(/uses: (\S+)/g)].map(([, action]) => {
    const [name, ref] = action.split("@");
    assert.match(ref, /^[0-9a-f]{40}$/, `${name} is pinned to a commit`);
    return name;
  });
}

test("publication remains desktop-only", () => {
  assert.doesNotMatch(workflow, /npm publish|NPM_BOOTSTRAP_TOKEN/);
  // The only OIDC tokens the release may mint are the Windows signing jobs'.
  const jobs = workflow.split(/\n  (?=[a-z-]+:\n)/);
  const minting = jobs.filter((job) => job.includes("id-token: write"));
  assert.deepEqual(
    minting.map((job) => job.slice(0, job.indexOf(":"))),
    ["sign-windows-native", "sign-windows-exe", "sign-windows-setup"],
  );
});

test("Windows signing jobs run no repository code", () => {
  const jobs = workflow.split(/\n  (?=[a-z-]+:\n)/);
  const named = (name) => jobs.find((job) => job.startsWith(`${name}:\n`));
  const signing = jobs.filter(
    (job) =>
      job.includes("secrets.AZURE_") ||
      job.includes("environment: windows-signing") ||
      job.includes("artifact-signing-action"),
  );
  assert.deepEqual(
    signing.map((job) => job.slice(0, job.indexOf(":"))),
    ["sign-windows-native", "sign-windows-exe", "sign-windows-setup"],
  );
  for (const job of signing) {
    assert.match(job, /\n    environment: windows-signing\n/);
    assert.match(job, /\n    permissions:\n      id-token: write\n    steps:/);
    // Download, sign and upload, with actions pinned to a commit.
    assert.doesNotMatch(
      job,
      /\brun:|actions\/checkout|uses: \S*\/setup-|shell:/,
    );
    assert.deepEqual(pinnedActions(job), [
      "actions/download-artifact",
      "azure/login",
      "azure/artifact-signing-action",
      "actions/upload-artifact",
    ]);
    assert.doesNotMatch(job, /client-secret|certificate-path|creds:/);
    assert.match(job, /certificate-profile-name: ovation-public-trust\n/);
    assert.match(job, /timestamp-digest: SHA256\n/);
  }

  // Sign the library, compile it in, sign the executable, package it, sign
  // the installer, then verify all three before the smoke test and upload.
  const chain = [
    ["windows-native", "prepare, acceptance", "windows-native-unsigned"],
    ["sign-windows-native", "windows-native", "windows-native-signed"],
    ["windows-compile", "prepare, sign-windows-native", "windows-exe-unsigned"],
    ["sign-windows-exe", "windows-compile", "windows-exe-signed"],
    ["windows-package", "prepare, sign-windows-exe", "windows-setup-unsigned"],
    ["sign-windows-setup", "windows-package", "windows-setup-signed"],
  ];
  for (const [name, needs, uploads] of chain) {
    const job = named(name);
    assert.ok(job, name);
    assert.ok(job.includes(`    needs: [${needs}]\n`), `${name} needs`);
    assert.ok(job.includes(`          name: ${uploads}\n`), `${name} uploads`);
  }
  assert.match(
    named("windows-native"),
    /run: node scripts\/windows-native\.mjs dist-desktop\/native-windows\n/,
  );
  assert.match(named("sign-windows-native"), /\\signing\\webview\.dll\n/);
  assert.match(
    named("windows-compile"),
    /run: node scripts\/desktop-build\.mjs --reuse-native\n/,
  );
  assert.match(
    named("sign-windows-exe"),
    /\\signing\\novamira-hq-desktop\.exe\n/,
  );
  assert.match(
    named("windows-package"),
    /run: node scripts\/desktop-build\.mjs --package --reuse-compiled\n/,
  );
  assert.match(
    named("sign-windows-setup"),
    /\\signing\\novamira-hq-setup-windows-x86_64\.exe\n/,
  );

  const windows = named("desktop-windows");
  assert.doesNotMatch(windows, /id-token|secrets\.|environment:/);
  assert.match(
    windows,
    /needs: \[prepare, sign-windows-native, sign-windows-exe, sign-windows-setup\]/,
  );
  for (const artifact of [
    "windows-native-signed",
    "windows-exe-signed",
    "windows-setup-signed",
  ])
    assert.ok(windows.includes(`          name: ${artifact}\n`), artifact);
  const verify = windows.indexOf("Get-AuthenticodeSignature");
  const smoke = windows.indexOf("desktop-smoke.mjs");
  const accept = windows.indexOf("desktop:acceptance");
  const upload = windows.indexOf("actions/upload-artifact");
  assert.ok(
    verify > 0 && verify < smoke && smoke < accept && accept < upload,
    "verify, smoke, accept, upload",
  );
  assert.match(windows, /TimeStamperCertificate/);
  assert.match(
    windows,
    /foreach \(\$file in "dist-desktop\/native-windows\/webview\.dll", "dist-desktop\/novamira-hq-desktop\.exe", "dist-desktop\/\$env:ASSET"\)/,
  );
  // The publishing job waits for it and downloads what it uploads; nothing
  // unsigned matches the pattern it downloads.
  assert.match(windows, /name: novamira-hq-desktop-windows-x86_64-release\n/);
  assert.ok(
    !/name: novamira-hq-desktop-.*-release/.test(
      chain.map(([name]) => named(name)).join("\n"),
    ),
  );
  const release = named("github-release");
  assert.match(release, /needs: \[prepare, desktop, desktop-windows, /);
});

test("legal review exception is limited to the explicitly accepted first beta", () => {
  assert.match(
    workflow,
    /continue-on-error: \$\{\{ env\.RELEASE_TAG == 'v1\.0\.0-beta1' \}\}\n        run: bun run legal:desktop-check/,
  );
  assert.equal((workflow.match(/continue-on-error:/g) ?? []).length, 1);
});

/** The unsigned artifact never lands on the checkout the signer runs from. */
function assertSignerTakesOnlyItsInputs(job) {
  assert.match(
    job,
    /name: \$\{\{ matrix\.asset \}\}-unsigned\n {10}path: \$\{\{ runner\.temp \}\}\/unsigned\n/,
  );
  assert.doesNotMatch(job, /\n {10}path: \.\n/);
  assert.match(job, /test ! -L "\$unsigned\/\$file"/);
  assert.match(job, /-type f -o -type l \\\) \| wc -l\)" -eq 2/);
  assert.ok(
    job.indexOf('cp "$unsigned/dist-desktop/$ASSET"') <
      job.indexOf("bash scripts/macos-sign.sh"),
  );
}

test("macOS builds, signs and verifies in separate jobs", () => {
  const jobs = workflow.split(/\n  (?=[a-z-]+:\n)/);
  const named = (name) => jobs.find((job) => job.startsWith(`${name}:\n`));
  const signing = jobs.filter(
    (job) =>
      job.includes("secrets.APPLE_") ||
      job.includes("environment: macos-signing"),
  );
  assert.deepEqual(
    signing.map((job) => job.slice(0, job.indexOf(":"))),
    ["sign-macos"],
  );
  const sign = signing[0];
  assert.match(sign, /needs: \[prepare, macos-build\]/);
  assert.match(sign, /bash scripts\/macos-sign\.sh "dist-desktop\/\$ASSET"/);
  for (const secret of [
    "APPLE_CERT_P12_BASE64",
    "APPLE_CERT_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_API_KEY_P8_BASE64",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER_ID",
  ]) {
    assert.ok(signer.includes(secret), `the signer requires ${secret}`);
    assert.ok(sign.includes(`secrets.${secret}`), `the job passes ${secret}`);
  }
  assert.doesNotMatch(
    sign,
    /bun |deno|npm |setup-bun|setup-deno|desktop:build/,
  );
  assert.deepEqual(pinnedActions(sign), [
    "actions/checkout",
    "actions/setup-node",
    "actions/download-artifact",
    "actions/upload-artifact",
  ]);
  assert.deepEqual(
    [
      ...sign.matchAll(
        /\n {6}- (?:name: [^\n]+\n {8}env:[\s\S]*?)?run: ([^\n]+)/g,
      ),
    ].map((match) => match[1]),
    ["|", 'bash scripts/macos-sign.sh "dist-desktop/$ASSET"'],
  );
  assertSignerTakesOnlyItsInputs(sign);

  // Both macOS architectures, each compiled natively and signed on its own
  // runner, and each publishing its bare executable and its `.app.zip`.
  for (const name of ["macos-build", "sign-macos", "desktop-macos"]) {
    const job = named(name);
    assert.match(job, /runner: macos-latest/, name);
    assert.match(job, /runner: macos-15-intel/, name);
    assert.match(job, /novamira-hq-desktop-macos-arm64/, name);
    assert.match(job, /novamira-hq-desktop-macos-x86_64/, name);
  }
  const build = named("macos-build");
  assert.match(build, /needs: \[prepare, acceptance\]/);
  assert.match(build, /run: bun run desktop:build\n/);
  assert.match(build, /name: \$\{\{ matrix\.asset \}\}-unsigned\n/);
  assert.match(sign, /name: \$\{\{ matrix\.asset \}\}-unsigned\n/);
  assert.match(sign, /name: \$\{\{ matrix\.asset \}\}-signed\n/);

  const verify = named("desktop-macos");
  assert.match(verify, /needs: \[prepare, sign-macos\]/);
  assert.match(verify, /name: \$\{\{ matrix\.asset \}\}-signed\n/);
  assert.match(verify, /\$ASSET\.app\.zip/);
  assert.match(verify, /xcrun stapler validate/);
  assert.match(
    verify,
    /node scripts\/desktop-smoke\.mjs "dist-desktop\/\$ASSET"/,
  );
  const steps = [
    "xcrun stapler validate",
    "node --test test/macos-keychain-contract.test.mjs",
    "desktop-smoke.mjs",
    "desktop-artifact-acceptance.mjs",
    "actions/upload-artifact",
  ].map((step) => verify.indexOf(step));
  assert.ok(
    steps.every(
      (at, index) => at > 0 && (index === 0 || steps[index - 1] < at),
    ),
    "verify, test, smoke, accept, upload",
  );
  assert.match(verify, /name: \$\{\{ matrix\.asset \}\}-release\n/);
  // The unsigned matrix must not have grown a macOS leg back.
  const unsigned = named("desktop");
  assert.ok(!unsigned.includes("macos-latest"), "macOS signs in its own job");
});

test("Linux and Windows desktop assets carry their icons and are proved to run", () => {
  const jobs = workflow.split(/\n  (?=[a-z-]+:\n)/);
  const desktop = jobs.find((job) => job.startsWith("desktop:"));

  // Both executables, and Linux's tarball beside its bare one.
  assert.match(desktop, /asset: novamira-hq-desktop-linux-x86_64\n/);
  assert.ok(!desktop.includes("windows"), "Windows signs in its own job");
  // The portable Windows name was a one-release transition: only the
  // installer ships, and a leg without an archive uploads its asset alone.
  assert.ok(!desktop.includes("novamira-hq-desktop-windows-x86_64.exe"));
  assert.match(
    desktop,
    /dist-desktop\/\$\{\{ matrix\.archive \|\| matrix\.asset \}\}\n/,
  );
  assert.match(desktop, /archive: novamira-hq-desktop-linux-x86_64\.tar\.gz/);

  // The Windows icon is embedded by the compile; the Linux one travels in the
  // archive, which is the whole reason `--package` exists.
  assert.match(desktop, /run: node scripts\/desktop-build\.mjs --package\n/);
  assert.doesNotMatch(desktop, /desktop-build\.mjs\n/);
  assert.match(desktop, /runner\.os == 'Linux'/);

  // Every uploaded artifact matches what the publishing job downloads.
  const release = jobs.find((job) => job.startsWith("github-release:"));
  assert.match(release, /pattern: novamira-hq-desktop-\*-release\n/);
  assert.match(desktop, /name: \$\{\{ matrix\.artifact \}\}-release\n/);
  const artifacts = [...desktop.matchAll(/artifact: (\S+)\n/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(artifacts, ["novamira-hq-desktop-linux-x86_64"]);

  // Every compiled executable this release publishes is run before it is
  // uploaded, on the platform that compiled it.
  assert.match(desktop, /bun run desktop:acceptance/);
  assert.ok(
    desktop.indexOf("desktop:acceptance") <
      desktop.indexOf("actions/upload-artifact"),
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
  const verificationJobs = verification.split(/\n  (?=[a-z-]+:\n)/);
  const verificationSigning = verificationJobs.filter(
    (job) =>
      job.includes("secrets.APPLE_") ||
      job.includes("environment: macos-signing"),
  );
  assert.equal(verificationSigning.length, 1);
  assert.ok(verificationSigning[0].startsWith("sign:\n"));
  assert.doesNotMatch(
    verificationSigning[0],
    /bun |deno|npm |setup-bun|setup-deno|desktop:build/,
  );
  assertSignerTakesOnlyItsInputs(verificationSigning[0]);
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

function runMetadata(...args) {
  const result = runMetadataResult(...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/**
 * Run the metadata script against a throwaway release with its own
 * `package.json`, so the assertions describe the script rather than whatever
 * state this repository's release happens to be in.
 */
async function runMetadataIn({ version }, ...args) {
  const temporary = await mkdtemp(join(tmpdir(), "novamira-release-test-"));
  try {
    await writeFile(
      join(temporary, "package.json"),
      `${JSON.stringify({ version })}\n`,
    );
    return run(
      "node",
      [join(root, "scripts/release-metadata.mjs"), ...args],
      temporary,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function runMetadataResult(...args) {
  return run("node", ["scripts/release-metadata.mjs", ...args], root);
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}
