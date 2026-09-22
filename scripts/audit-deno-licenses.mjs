// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Explicit, networked source audit. Not part of build/check and never compiles
// or executes third-party code. Run with Bun (its built-in TOML parser).
import { TOML } from "bun";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const version = process.argv[2];
const output = process.argv[3];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !output)
  throw new Error(
    "Usage: bun scripts/audit-deno-licenses.mjs VERSION OUTPUT_DIRECTORY",
  );
const dir = resolve(output);
await mkdir(join(dir, "cache"), { recursive: true });
const userAgent =
  "Novamira-HQ-license-review/1.0 (https://github.com/use-novamira/novamira-hq)";
async function get(url) {
  const file = join(
    dir,
    "cache",
    createHash("sha256").update(url).digest("hex"),
  );
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await globalThis.fetch(url, {
      headers: { "User-Agent": userAgent },
      signal: globalThis.AbortSignal.timeout(30_000),
    });
    if (response.status === 429 || response.status >= 500) {
      await delay(
        Math.max(
          1000,
          Math.min(
            60_000,
            Number(response.headers.get("retry-after") ?? 2 ** attempt) * 1000,
          ),
        ),
      );
      continue;
    }
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    const text = await response.text();
    await writeFile(file, text);
    return text;
  }
  throw new Error(`Retry budget exhausted: ${url}`);
}
async function pool(items, action, concurrency = 4) {
  let index = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (index < items.length) await action(items[index++]);
    }),
  );
}
const base = `https://raw.githubusercontent.com/denoland/deno/v${version}/`;
const root = TOML.parse(await get(base + "Cargo.toml"));
const lockText = await get(base + "Cargo.lock");
const lock = TOML.parse(lockText);
const packages = new Map(
  lock.package.map((p) => [`${p.name} ${p.version}`, p]),
);
const workspace = new Map();
const workspacePaths = [
  ...new Set([
    ...root.workspace.members,
    ...Object.values(root.workspace.dependencies).flatMap((spec) =>
      spec?.path ? [spec.path.replace(/^\.\//, "")] : [],
    ),
  ]),
];
await pool(workspacePaths, async (path) => {
  if (path.includes("*"))
    throw new Error(`Workspace glob needs review: ${path}`);
  const manifest = TOML.parse(await get(base + path + "/Cargo.toml"));
  const normal = { ...manifest.dependencies };
  for (const target of Object.values(manifest.target ?? {}))
    Object.assign(normal, target.dependencies);
  const names = Object.entries(normal).map(([name, spec]) => {
    const declaration = spec?.workspace
      ? root.workspace.dependencies[name]
      : spec;
    return declaration?.package ?? name;
  });
  workspace.set(manifest.package.name, { path, names, manifest });
});

const visited = new Map();
function visit(pkg) {
  const id = `${pkg.name} ${pkg.version}`;
  if (visited.has(id)) return;
  visited.set(id, pkg);
  const local = workspace.get(pkg.name);
  for (const dependency of pkg.dependencies ?? []) {
    const [name, dependencyVersion] = dependency.split(" ");
    if (local && !local.names.includes(name)) continue;
    const matches = [...packages.values()].filter(
      (p) =>
        p.name === name &&
        (!dependencyVersion || p.version === dependencyVersion),
    );
    if (matches.length !== 1)
      throw new Error(`Ambiguous dependency: ${id} -> ${dependency}`);
    visit(matches[0]);
  }
}
const runtime = packages.get(`denort ${version}`);
if (!runtime) throw new Error("No matching denort in lock");
visit(runtime);
process.stdout.write(
  `denort candidate graph: ${visited.size} packages (not a target-specific binary SBOM)\n`,
);

const records = [];
let completed = 0;
await pool(
  [...visited.values()],
  async (pkg) => {
    const local = workspace.get(pkg.name);
    let record;
    try {
      if (local) {
        const value = local.manifest.package.license;
        record = {
          name: pkg.name,
          version: pkg.version,
          license: value?.workspace ? root.workspace.package.license : value,
          source: base + local.path + "/Cargo.toml",
          kind: "workspace",
        };
      } else if (pkg.source?.startsWith("registry+")) {
        const metadata = JSON.parse(
          await get(
            `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}`,
          ),
        ).version;
        if (metadata.num !== pkg.version || metadata.crate !== pkg.name)
          throw new Error("Registry identity mismatch");
        record = {
          name: pkg.name,
          version: pkg.version,
          license: metadata.license,
          source: `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`,
          checksum: pkg.checksum,
          kind: "registry",
        };
      } else {
        record = {
          name: pkg.name,
          version: pkg.version,
          source: pkg.source,
          kind: "git",
          review: "Needs source/license review",
        };
      }
    } catch (error) {
      record = { name: pkg.name, version: pkg.version, review: error.message };
    }
    records.push(record);
    completed++;
    if (completed % 50 === 0)
      process.stdout.write(`Reviewed ${completed}/${visited.size} manifests\n`);
  },
  3,
);
records.sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
);
const report = {
  denoVersion: version,
  runtime: "denort",
  lockSha256: createHash("sha256").update(lockText).digest("hex"),
  scope:
    "Candidate closure from denort. Workspace development/build-only edges excluded; registry build dependencies, target alternatives and optional features are conservatively retained. Not proof of inclusion in a specific binary, and not a compatibility verdict.",
  packages: records,
};
await writeFile(
  join(dir, "inventory.json"),
  JSON.stringify(report, null, 2) + "\n",
);
const licenses = {};
for (const item of records)
  licenses[item.license ?? "UNRESOLVED"] =
    (licenses[item.license ?? "UNRESOLVED"] ?? 0) + 1;
process.stdout.write(
  JSON.stringify(
    {
      directory: dir,
      count: records.length,
      licenses,
      unresolved: records.filter((p) => !p.license || p.review),
    },
    null,
    2,
  ) + "\n",
);
