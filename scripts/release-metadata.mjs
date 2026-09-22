#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import process from "node:process";

const tag = process.argv[2];
if (!tag?.startsWith("v")) throw new Error("release tag must start with v");
const version = tag.slice(1);
const match =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
    version,
  );
if (
  !match ||
  (match[4]?.split(".") ?? []).some((part) => /^0\d+$/.test(part))
) {
  throw new Error(`invalid release version: ${version}`);
}
const manifest = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.version !== version) {
  throw new Error(
    `tag ${tag} does not match package version ${manifest.version}`,
  );
}
process.stdout.write(
  `version=${version}\nprerelease=${match[4] !== undefined}\n`,
);
