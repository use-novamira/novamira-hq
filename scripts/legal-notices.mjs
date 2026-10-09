// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Offline, deterministic notices. Never fetch a license during a build.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { WINDOWS_WEBVIEW_HASHES } from "./windows-native.mjs";
import { NSIS_SHA256 } from "./windows-nsis.mjs";
import { validateDeclaredLicense } from "./runtime-license-evidence.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFile(join(root, path), "utf8");
const manifest = JSON.parse(await read("legal/manifest.json"));
const pkg = JSON.parse(await read("package.json"));
const lock = JSON.parse(await read("desktop/deno.lock"));
const components = manifest.components;
const loader = components.find((item) => item.id === "webview2-loader");
if (
  loader?.artifact?.filename !== "WebView2Loader.dll" ||
  loader.artifact.sha256 !== WINDOWS_WEBVIEW_HASHES["WebView2Loader.dll"] ||
  createHash("sha256")
    .update(await readFile(join(root, "legal/licenses/webview2-loader.txt")))
    .digest("hex") !== loader.artifact.licenseSha256
)
  throw new Error("Legal inventory needs review: Windows WebView2 loader");
const nsis = components.find((item) => item.id === "nsis");
if (
  nsis?.artifact?.sha256 !== NSIS_SHA256 ||
  createHash("sha256")
    .update(await readFile(join(root, "legal/licenses/nsis.txt")))
    .digest("hex") !== nsis.artifact.licenseSha256
)
  throw new Error("Legal inventory needs review: NSIS installer");
const npmInventory = JSON.parse(await read("legal/npm-inventory.json"));
if (
  createHash("sha256")
    .update(await read("bun.lock"))
    .digest("hex") !== npmInventory.lockSha256
)
  throw new Error("Legal inventory needs review: npm lock changed");

for (const [path, expected] of Object.entries(manifest.assetDigests)) {
  const actual = createHash("sha256")
    .update(await readFile(join(root, path)))
    .digest("hex");
  if (actual !== expected)
    throw new Error(`Legal inventory needs review: asset changed: ${path}`);
}
for (const name of Object.keys(pkg.dependencies)) {
  const installed = JSON.parse(await read(`node_modules/${name}/package.json`));
  for (const dependency of Object.keys({
    ...installed.dependencies,
    ...installed.optionalDependencies,
  })) {
    const transitive = JSON.parse(
      await read(
        `node_modules/${name}/node_modules/${dependency}/package.json`,
      ).catch(() => read(`node_modules/${dependency}/package.json`)),
    );
    if (
      !components.some(
        (item) =>
          item.name === dependency &&
          item.version === transitive.version &&
          item.scope === "npm runtime",
      )
    )
      throw new Error(
        `Legal inventory needs review: new transitive runtime dependencies of ${name}`,
      );
  }
  if (
    !components.some(
      (item) =>
        item.name === name &&
        item.version === installed.version &&
        item.scope === "npm runtime",
    )
  )
    throw new Error(
      `Legal inventory needs review: ${name}@${installed.version}`,
    );
}
for (const key of Object.keys(lock.jsr)) {
  if (!components.some((item) => `${item.name}@${item.version}` === key))
    throw new Error(`Legal inventory needs review: ${key}`);
}
for (const key of Object.keys(lock.npm)) {
  if (!components.some((item) => `${item.name}@${item.version}` === key))
    throw new Error(`Legal inventory needs review: ${key}`);
}

const sections = [
  `NOVAMIRA HQ ${pkg.version} — LEGAL AND THIRD-PARTY NOTICES`,
  "THIS APPLICATION INCLUDES LGPL-COVERED SOFTWARE\nThe desktop Deno/V8 runtime includes glibc-derived mathematical code under LGPL-2.1-or-later.\nCopyright (C) 2001-2022 Free Software Foundation, Inc.\nThe complete LGPL 2.1 text and written source offer follow. Third-party copyright notices are retained below.",
  await read("legal/SOURCE-OFFER.txt"),
  await read("license-docs/build-from-source.md"),
  await read("legal/licenses/lgpl-2.1.txt"),
  `Inventory reviewed: ${manifest.reviewedAt}\n\n${manifest.coverage}`,
  "NOVAMIRA HQ\nCopyright © 2026 Ovation S.r.l.\nSPDX-License-Identifier: AGPL-3.0-or-later\nSource: https://github.com/use-novamira/novamira-hq\nRecipients of a binary must receive access to the matching Corresponding Source, including build scripts. Contact the distributor if the repository is private or the matching revision is unavailable.\n\n" +
    (await read("LICENSE")),
  "SCOPE\nNovamira CLI is included as a pinned npm dependency and embedded in desktop, with its guide data and license. AI clients are separate products with their own notices. Development-only npm tools are not shipped in the application. System-provided web engines are not treated as HQ-owned code. Trademarks remain the property of their respective owners; license notices do not imply endorsement.",
  "DESKTOP REVIEW STATUS: " +
    manifest.desktopReview.status.toUpperCase() +
    "\n" +
    manifest.desktopReview.remaining.map((value) => "- " + value).join("\n"),
];
const texts = new Map();
for (const item of components) {
  sections.push(
    [
      `${item.name} — ${item.version}`,
      `Scope: ${item.scope}`,
      `License: ${item.license}`,
      `Source / terms: ${item.source}`,
      item.notes ?? "",
      `License texts: ${item.licenseFiles.join(", ") || "See brand terms above"}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  for (const path of item.licenseFiles) {
    if (!/^licenses\/[a-z0-9]+(?:[.-][a-z0-9]+)*\.txt$/.test(path))
      throw new Error(`Invalid legal text path: ${path}`);
    if (texts.has(path)) continue;
    const text = await read(`legal/${path}`);
    if (text.trim().length < 100)
      throw new Error(`Missing legal text: ${path}`);
    texts.set(path, text);
  }
}
for (const [path, text] of texts) sections.push(`${path}\n\n${text.trimEnd()}`);

const runtime = JSON.parse(await read("legal/denort-inventory.json"));
const runtimeTexts = JSON.parse(await read("legal/denort-license-texts.json"));
const native = JSON.parse(await read("legal/v8-source-notices.json"));
const declarationEvidence = JSON.parse(
  await read("legal/runtime-license-evidence.json"),
);
if (declarationEvidence.lockSha256 !== runtime.lockSha256)
  throw new Error(
    "Legal inventory needs review: runtime evidence lock changed",
  );
const declarations = new Map(
  declarationEvidence.packages.map((item) => [
    `${item.name}@${item.version}`,
    item,
  ]),
);
if (declarations.size !== declarationEvidence.packages.length)
  throw new Error("Duplicate runtime license evidence");
const standardTexts = new Map();
for (const [id, record] of Object.entries(
  declarationEvidence.standardLicenses,
)) {
  if (!/^licenses\/[a-z0-9]+(?:[.-][a-z0-9]+)*\.txt$/.test(record.file))
    throw new Error(`Invalid standard license path: ${id}`);
  const text = await read(`legal/${record.file}`);
  if (
    text.trim().length < 100 ||
    createHash("sha256").update(text).digest("hex") !== record.sha256
  )
    throw new Error(`Missing or changed standard license text: ${id}`);
  standardTexts.set(id, text);
}
if (
  !Array.isArray(manifest.desktopReview.blockers) ||
  !manifest.desktopReview.blockers.every(
    (issue) => typeof issue === "string" && issue.trim().length > 0,
  )
)
  throw new Error("Invalid desktop license blockers");
const blockingIssues = [...manifest.desktopReview.blockers];
sections.push(
  `DESKTOP RUNTIME SOURCE AUDIT — NOT RELEASE CLEARANCE\nReference Deno version: ${runtime.denoVersion}\nCargo.lock SHA-256: ${runtime.lockSha256}\n${runtime.scope}\nSome records describe optional, build-time or other-platform dependencies. Inclusion here does not claim that every component ships in HQ. Missing notices and unresolved scope remain explicit below.`,
);
const referencedTexts = new Set();
for (const item of runtime.packages) {
  const licenseMaterial = [];
  const customDeclaration = declarationEvidence.customDeclarations.some(
    (record) =>
      record.name === item.name &&
      record.version === item.version &&
      record.archiveSha256 === item.checksum &&
      record.declaredLicense === item.license &&
      item.notices.length > 0,
  );
  if (
    !declarationEvidence.reviewedLicenseExpressions.includes(item.license) &&
    !customDeclaration
  )
    blockingIssues.push(
      `Missing or unreviewed license declaration: ${item.name}@${item.version}`,
    );
  if (item.kind === "registry" && item.notices.length === 0) {
    const evidence = declarations.get(`${item.name}@${item.version}`);
    try {
      const selected = validateDeclaredLicense(item, evidence);
      if (!standardTexts.has(selected))
        throw new Error(`Missing standard license: ${selected}`);
      for (const path of evidence.additionalNativeNotices ?? []) {
        if (!native.notices.some((notice) => notice.path === path))
          throw new Error(
            `Missing supplementary native notice: ${item.name}: ${path}`,
          );
      }
      licenseMaterial.push(
        `License basis: published Cargo.toml; selected ${selected}; standard terms included below.`,
      );
      if (evidence.authors.length)
        licenseMaterial.push(
          `Published author credits: ${evidence.authors.join("; ")}`,
        );
      for (const header of evidence.copyrightHeaders)
        licenseMaterial.push(
          `Original source attribution (${header.paths.join(", ")}):\n${header.text}`,
        );
    } catch (error) {
      blockingIssues.push(error.message);
    }
  }
  sections.push(
    [
      `Runtime candidate: ${item.name} — ${item.version}`,
      `Declared license: ${item.license}`,
      `Source: ${item.source}`,
      item.checksum ? `Source archive SHA-256: ${item.checksum}` : "",
      `Review: ${item.review}`,
      ...(item.notices.length
        ? item.notices.map((notice) => {
            if (!/^[a-f0-9]{64}$/.test(notice.sha256))
              throw new Error(`Invalid runtime notice reference: ${item.name}`);
            const text = runtimeTexts[notice.sha256];
            if (
              typeof text !== "string" ||
              createHash("sha256").update(text).digest("hex") !== notice.sha256
            )
              throw new Error(
                `Missing or changed runtime notice: ${item.name}`,
              );
            referencedTexts.add(notice.sha256);
            return `Notice: ${notice.path} — text ${notice.sha256}${notice.source ? ` — ${notice.source}` : ""}`;
          })
        : item.kind === "workspace"
          ? [
              "Deno workspace component: covered by the bundled Deno MIT notice.",
            ]
          : licenseMaterial),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
for (const sha256 of [...referencedTexts].sort())
  sections.push(`Runtime notice text ${sha256}\n\n${runtimeTexts[sha256]}`);
for (const [id, text] of standardTexts)
  sections.push(
    `Standard license terms: ${id}\nSource: ${declarationEvidence.standardLicenses[id].source}\n\n${text}`,
  );
sections.push(
  `V8 SOURCE-TREE AUDIT\n${native.scope}\nRevision: ${native.revision}`,
);
for (const notice of native.notices) {
  if (typeof notice.text !== "string" || notice.text.trim().length < 100)
    throw new Error(`Missing V8 source notice: ${notice.path}`);
  sections.push(`${notice.path}\nSource: ${notice.url}\n\n${notice.text}`);
}

if (blockingIssues.length > 0) {
  process.stderr.write("Desktop license material check failed:\n");
  process.stderr.write(blockingIssues.map((issue) => `- ${issue}\n`).join(""));
  process.exitCode = 1;
} else if (process.argv.includes("--check-desktop")) {
  process.stdout.write(
    `Desktop license materials verified; ${declarations.size} published declarations use bundled standard terms.\n`,
  );
} else if (!process.argv.includes("--check")) {
  const target = join(root, "dist/web/static/third-party-notices.txt");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    sections.join("\n\n" + "=".repeat(78) + "\n\n") + "\n",
  );
  process.stdout.write(
    `Bundled legal notices for ${components.length} component records\n`,
  );
}
