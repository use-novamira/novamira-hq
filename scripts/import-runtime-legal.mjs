// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Import reviewed, checksum-verified audit evidence. This is deliberately not a
// release-clearance command and never downloads or executes third-party code.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const dir = resolve(process.argv[2]);
const root = fileURLToPath(new URL("../legal/", import.meta.url));
const inventory = JSON.parse(
  await readFile(join(dir, "inventory.json"), "utf8"),
);
const evidence = JSON.parse(
  await readFile(join(dir, "source-notices-enriched.json"), "utf8"),
);
if (inventory.denoVersion !== evidence.denoVersion)
  throw new Error("Audit version mismatch");
const byId = new Map(
  evidence.packages.map((p) => [`${p.name}@${p.version}`, p]),
);
const texts = {};
const packages = inventory.packages.map((pkg) => {
  const item = byId.get(`${pkg.name}@${pkg.version}`);
  if (pkg.kind === "registry" && item?.checksum !== pkg.checksum)
    throw new Error(`Missing verified archive: ${pkg.name}@${pkg.version}`);
  const notices = (item?.texts ?? []).map(({ path, source, text }) => {
    const sha256 = createHash("sha256").update(text).digest("hex");
    texts[sha256] = text;
    return { path, ...(source ? { source } : {}), sha256 };
  });
  return {
    ...pkg,
    ...(item?.vcs ? { vcs: item.vcs } : {}),
    ...(item?.repository ? { repository: item.repository } : {}),
    notices,
    review:
      pkg.kind === "workspace"
        ? "Deno workspace: see the Deno MIT notice; binary inclusion not established."
        : item?.textProvenance
          ? item.vcs?.git?.dirty
            ? "Published source records local changes; root license coverage needs verification."
            : "Workspace-root notices recovered; per-directory exceptions need review."
          : (item?.review ??
            "Archive notices collected; binary inclusion and nested source coverage need review."),
    ...(item?.secondaryLicenseMarkers?.length
      ? { secondaryLicenseMarkers: item.secondaryLicenseMarkers }
      : {}),
  };
});
await writeFile(
  join(root, "denort-inventory.json"),
  JSON.stringify({ ...inventory, status: "incomplete", packages }, null, 2) +
    "\n",
);
await writeFile(
  join(root, "denort-license-texts.json"),
  JSON.stringify(Object.fromEntries(Object.entries(texts).sort()), null, 2) +
    "\n",
);
process.stdout.write(
  `Imported ${packages.length} candidate packages, ${Object.keys(texts).length} unique notice texts. Desktop clearance remains incomplete.\n`,
);
