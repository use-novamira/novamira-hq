// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Recover omitted workspace-root notices at the crate's recorded Git revision,
// never from a moving default branch. Retain unresolved records for review.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const dir = resolve(process.argv[2]);
const report = JSON.parse(
  await readFile(join(dir, "source-notices.json"), "utf8"),
);
await mkdir(join(dir, "upstream"), { recursive: true });
const groups = new Map();
for (const pkg of report.packages.filter(
  (p) => p.review && p.texts?.length === 0,
)) {
  const repo = pkg.repository?.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/#]+)/,
  );
  const revision = pkg.vcs?.git?.sha1;
  if (!repo || !/^[a-f0-9]{40}$/.test(revision ?? "")) continue;
  const base = `https://raw.githubusercontent.com/${repo[1]}/${repo[2].replace(/\.git$/, "")}/${revision}/`;
  if (!groups.has(base)) groups.set(base, []);
  groups.get(base).push(pkg);
}
const candidates = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "LICENSE-APACHE-2.0",
  "LICENSE.BSD",
  "COPYING",
  "NOTICE",
];
const queue = [...groups.entries()];
let index = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (index < queue.length) {
      const [base, packages] = queue[index++];
      const cache = join(
        dir,
        "upstream",
        createHash("sha256").update(base).digest("hex") + ".json",
      );
      let texts;
      try {
        texts = JSON.parse(await readFile(cache, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!texts) {
        texts = [];
        for (const path of candidates) {
          const source = base + path;
          const response = await globalThis.fetch(source, {
            signal: globalThis.AbortSignal.timeout(30_000),
          });
          if (response.status === 404) continue;
          if (!response.ok) throw new Error(`${response.status}: ${source}`);
          const text = await response.text();
          if (text.trim().length < 100) continue;
          texts.push({ path: "upstream-root/" + path, source, text });
        }
        await writeFile(cache, JSON.stringify(texts, null, 2) + "\n");
      }
      if (texts.length)
        for (const pkg of packages) {
          pkg.texts = texts;
          pkg.review = pkg.vcs?.git?.dirty
            ? "Published source records local changes: root notices are evidence, not proof of matching license coverage."
            : "Workspace-root notices recovered; per-directory exceptions still need review.";
          pkg.textProvenance =
            "Workspace-root notices retrieved at the published crate's recorded Git revision; review any per-directory exceptions before release.";
        }
      process.stdout.write(
        `Root notices: ${packages.map((p) => p.name).join(", ")} — ${texts.length} files\n`,
      );
    }
  }),
);
await writeFile(
  join(dir, "source-notices-enriched.json"),
  JSON.stringify(report, null, 2) + "\n",
);
process.stdout.write(
  JSON.stringify(
    {
      packages: report.packages.length,
      unresolved: report.packages
        .filter((p) => p.review)
        .map(({ name, version, review, repository }) => ({
          name,
          version,
          review,
          repository,
        })),
    },
    null,
    2,
  ) + "\n",
);
