// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Copy the dashboard's static assets into `dist/`.
//
// `tsc` copies TypeScript output and nothing else, so without this step
// `dist/web/static/` does not exist and the dashboard ships with no stylesheet,
// no Datastar runtime and no fonts — a failure that shows up as a blank page in
// a browser rather than as a build error. The verification pass below turns it
// back into a build error: every asset the server's allowlist names must exist
// and be non-empty, and a missing one exits non-zero.
//
// The list is duplicated from `src/web/static.ts` on purpose: this script runs
// before (and independently of) the compiled output, and a check that imports
// the thing it is checking cannot fail in the interesting way.

import { cp, stat } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { exit, stdout, stderr } from "node:process";

const source = fileURLToPath(new URL("../src/web/static/", import.meta.url));
const target = fileURLToPath(new URL("../dist/web/static/", import.meta.url));

const required = [
  "app.css",
  "datastar.js",
  "relative-time.js",
  "sites-filter.js",
  "ui-feedback.js",
  "novamira-hq-logo-white.svg",
  "fonts/montserrat-var.woff2",
  "fonts/montserrat-OFL.txt",
  "fonts/jetbrains-mono-var.woff2",
  "fonts/jetbrains-mono-OFL.txt",
];

await cp(source, target, { recursive: true, force: true });

const missing = [];
for (const relative of required) {
  try {
    const info = await stat(new URL(relative, `file://${target}`));
    if (!info.isFile() || info.size === 0) missing.push(relative);
  } catch {
    missing.push(relative);
  }
}

if (missing.length > 0) {
  stderr.write(
    `Missing dashboard assets in dist/web/static:\n  ${missing.join("\n  ")}\n`,
  );
  exit(1);
}

stdout.write(`Copied ${required.length} dashboard assets to dist/web/static\n`);
