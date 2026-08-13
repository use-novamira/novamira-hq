#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import process from "node:process";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

if (process.argv[2] === "--assert-newer") {
  const candidate = parse(process.argv[3]);
  const current = parse(process.argv[4]?.replace(/^"|"$/g, ""));
  if (compare(candidate, current) <= 0) {
    throw new Error(
      `release ${process.argv[3]} must be newer than dist-tag version ${process.argv[4]}`,
    );
  }
} else {
  const tag = process.argv[2];
  if (!tag?.startsWith("v")) throw new Error("release tag must start with v");
  const version = tag.slice(1);
  const parsed = parse(version);
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  if (manifest.version !== version) {
    throw new Error(
      `tag ${tag} does not match package version ${manifest.version}`,
    );
  }
  const prerelease = parsed.prerelease.length > 0;
  process.stdout.write(
    `version=${version}\ndist_tag=${prerelease ? "next" : "latest"}\nprerelease=${prerelease}\n`,
  );
}

function parse(value) {
  const match = SEMVER.exec(value ?? "");
  if (match === null) throw new Error(`invalid release version: ${value}`);
  const prerelease = match[4]?.split(".") ?? [];
  for (const identifier of prerelease) {
    if (
      /^\d+$/.test(identifier) &&
      identifier.length > 1 &&
      identifier[0] === "0"
    ) {
      throw new Error(`invalid release version: ${value}`);
    }
  }
  return {
    core: match.slice(1, 4).map(Number),
    prerelease,
  };
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0)
    return right.prerelease.length === 0 ? 0 : 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric)
      return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
