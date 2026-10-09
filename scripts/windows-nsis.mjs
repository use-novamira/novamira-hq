// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const NSIS_VERSION = "3.13";
export const NSIS_URL = `https://downloads.sourceforge.net/project/nsis/NSIS%203/${NSIS_VERSION}/nsis-${NSIS_VERSION}.zip`;
export const NSIS_SHA256 =
  "ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8";

/** Download only while packaging; nothing from NSIS runs on users' machines but the stub. */
export async function installNsis(directory, fetcher = globalThis.fetch) {
  const response = await fetcher(NSIS_URL, {
    signal: globalThis.AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`NSIS download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== NSIS_SHA256)
    throw new Error("NSIS checksum mismatch");
  await mkdir(directory, { recursive: true });
  const archive = join(directory, `nsis-${NSIS_VERSION}.zip`);
  await writeFile(archive, bytes);
  // bsdtar ships with Windows 10 and later and reads zip archives.
  const extracted = spawnSync("tar", ["-xf", archive, "-C", directory], {
    stdio: "inherit",
  });
  if (extracted.status !== 0) throw new Error("NSIS extraction failed");
  return join(directory, `nsis-${NSIS_VERSION}`, "makensis.exe");
}
