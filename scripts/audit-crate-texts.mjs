// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { TOML } from "bun";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { isNoticePath, readCrateArchive } from "./license-archive.mjs";

const dir = resolve(process.argv[2]);
const inventory = JSON.parse(
  await readFile(join(dir, "inventory.json"), "utf8"),
);
await mkdir(join(dir, "archives"), { recursive: true });
await mkdir(join(dir, "texts"), { recursive: true });
const packages = inventory.packages.filter((p) => p.kind === "registry");
let index = 0;
let done = 0;
const results = [];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (index < packages.length) {
      const pkg = packages[index++];
      const id = `${pkg.name}-${pkg.version}`;
      const target = join(dir, "texts", `${id}.json`);
      try {
        const cached = JSON.parse(await readFile(target, "utf8"));
        if (cached.parserVersion === 2 && cached.checksum === pkg.checksum) {
          results.push(cached);
          done++;
          continue;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      try {
        const cache = join(dir, "archives", `${pkg.checksum}.crate`);
        let bytes;
        try {
          bytes = await readFile(cache);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (!bytes) {
          for (let attempt = 0; attempt < 4; attempt++) {
            const response = await globalThis.fetch(pkg.source, {
              headers: {
                "User-Agent":
                  "Novamira-HQ-license-review/1.0 (https://github.com/use-novamira/novamira-hq)",
              },
              signal: globalThis.AbortSignal.timeout(60_000),
            });
            if (response.status === 429 || response.status >= 500) {
              await delay(2000 * (attempt + 1));
              continue;
            }
            if (!response.ok)
              throw new Error(`Archive download: ${response.status}`);
            const chunks = [];
            let length = 0;
            for await (const chunk of response.body) {
              length += chunk.length;
              if (length > 64 * 1024 * 1024)
                throw new Error("Archive exceeds audit size limit");
              chunks.push(chunk);
            }
            bytes = Buffer.concat(chunks);
            break;
          }
          if (!bytes) throw new Error("Archive retry budget exhausted");
          await writeFile(cache, bytes);
        }
        if (createHash("sha256").update(bytes).digest("hex") !== pkg.checksum)
          throw new Error("Archive checksum mismatch");
        const files = readCrateArchive(bytes);
        const cargo = files.get(`${id}/Cargo.toml`);
        if (!cargo) throw new Error("Missing crate manifest");
        // Some Bun versions reject otherwise valid digit-prefixed feature keys.
        // Only the package table is needed here; do not parse unrelated features.
        const packageSection = cargo
          .toString("utf8")
          .split(/\r?\n\[package\]\r?\n/)[1]
          ?.split(/\r?\n\[/)[0];
        if (!packageSection) throw new Error("Missing package table");
        const manifest = TOML.parse(packageSection);
        if (manifest.name !== pkg.name || manifest.version !== pkg.version)
          throw new Error("Archive identity mismatch");
        const texts = [...files]
          .filter(
            ([path]) =>
              isNoticePath(path) ||
              path === `${id}/${manifest["license-file"]}`,
          )
          .map(([path, data]) => ({
            path: path.slice(id.length + 1),
            text: data.toString("utf8"),
          }));
        const secondaryLicenseMarkers = [...files]
          .filter(
            ([path, data]) =>
              !isNoticePath(path) &&
              /\.(rs|c|h|cc|cpp|js|ts|md|txt)$/i.test(path) &&
              data.includes(
                Buffer.from("Incompatible With Secondary Licenses"),
              ),
          )
          .map(([path]) => path.slice(id.length + 1));
        const vcsFile = files.get(`${id}/.cargo_vcs_info.json`);
        const result = {
          parserVersion: 2,
          name: pkg.name,
          version: pkg.version,
          license: manifest.license ?? pkg.license,
          source: pkg.source,
          checksum: pkg.checksum,
          repository: manifest.repository,
          vcs: vcsFile ? JSON.parse(vcsFile.toString("utf8")) : undefined,
          texts,
          secondaryLicenseMarkers,
          ...(texts.length
            ? {}
            : {
                review: "No standalone license text found in published archive",
              }),
        };
        await writeFile(target, JSON.stringify(result, null, 2) + "\n");
        results.push(result);
      } catch (error) {
        results.push({
          name: pkg.name,
          version: pkg.version,
          review: error.message,
        });
      }
      done++;
      if (done % 50 === 0)
        process.stdout.write(
          `Read source/license texts: ${done}/${packages.length}\n`,
        );
    }
  }),
);
results.sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
);
await writeFile(
  join(dir, "source-notices.json"),
  JSON.stringify(
    {
      denoVersion: inventory.denoVersion,
      scope: inventory.scope,
      packages: results,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  JSON.stringify(
    {
      count: results.length,
      review: results
        .filter((p) => p.review || p.secondaryLicenseMarkers?.length)
        .map(({ name, version, review, secondaryLicenseMarkers }) => ({
          name,
          version,
          review,
          secondaryLicenseMarkers,
        })),
    },
    null,
    2,
  ) + "\n",
);
