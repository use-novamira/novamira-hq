// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Offline, deterministic notices. Never fetch a license during a build.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFile(join(root, path), "utf8");
const manifest = JSON.parse(await read("legal/manifest.json"));
const pkg = JSON.parse(await read("package.json"));
const lock = JSON.parse(await read("desktop/deno.lock"));
const components = manifest.components;
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
  if (
    Object.keys({
      ...installed.dependencies,
      ...installed.optionalDependencies,
    }).length > 0
  )
    throw new Error(
      `Legal inventory needs review: new transitive runtime dependencies of ${name}`,
    );
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
  "SCOPE\nNovamira CLI and AI clients are separate products, not dependencies bundled in the HQ npm package. They have their own notices. Development-only npm tools are not shipped in the application. System-provided web engines are not treated as HQ-owned code. Trademarks remain the property of their respective owners; license notices do not imply endorsement.",
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
sections.push(
  `DESKTOP RUNTIME SOURCE AUDIT — NOT RELEASE CLEARANCE\nReference Deno version: ${runtime.denoVersion}\nCargo.lock SHA-256: ${runtime.lockSha256}\n${runtime.scope}\nSome records describe optional, build-time or other-platform dependencies. Inclusion here does not claim that every component ships in HQ. Missing notices and unresolved scope remain explicit below.`,
);
const referencedTexts = new Set();
for (const item of runtime.packages) {
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
        : ["No package-specific text collected; see review above."]),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
for (const sha256 of [...referencedTexts].sort())
  sections.push(`Runtime notice text ${sha256}\n\n${runtimeTexts[sha256]}`);
sections.push(
  `V8 SOURCE-TREE AUDIT\n${native.scope}\nRevision: ${native.revision}`,
);
for (const notice of native.notices) {
  if (typeof notice.text !== "string" || notice.text.trim().length < 100)
    throw new Error(`Missing V8 source notice: ${notice.path}`);
  sections.push(`${notice.path}\nSource: ${notice.url}\n\n${notice.text}`);
}

if (
  process.argv.includes("--check-desktop") &&
  (manifest.desktopReview.status !== "complete" ||
    runtime.status !== "complete" ||
    native.status !== "complete")
) {
  process.stderr.write(
    "Desktop legal review is incomplete. See legal/AUDIT.md. No release clearance.\n",
  );
  process.exitCode = 1;
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
