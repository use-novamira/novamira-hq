// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, URL } from "node:url";

export const WEBVIEW_VERSION = "0.9.0";
export const WEBVIEW_HASHES = Object.freeze({
  aarch64: "1bd58e657fb0a3d1e57b365720cb9c1a1b5cc46749f3c7edd4e06a815f6aa875",
  x86_64: "2e2fd6f7654bcddd963fca632c152fe4d41bbc9327100ebe4b8251c379180b41",
});

export function macArchitecture(binary) {
  if (binary.length < 8 || binary.readUInt32LE(0) !== 0xfeedfacf)
    throw new Error("Expected a thin 64-bit Mach-O executable");
  switch (binary.readUInt32LE(4)) {
    case 0x01000007:
      return "x86_64";
    case 0x0100000c:
      return "aarch64";
    default:
      throw new Error("Unsupported macOS executable architecture");
  }
}

/** Build-time download only. Pin both the upstream version and file digest. */
export async function installMacWebview(
  binary,
  app,
  fetcher = globalThis.fetch,
) {
  const config = JSON.parse(
    await readFile(new URL("../desktop/deno.json", import.meta.url), "utf8"),
  );
  if (
    config.imports["@webview/webview"] !==
    `jsr:@webview/webview@${WEBVIEW_VERSION}`
  )
    throw new Error(
      "Update the native webview checksums alongside its version",
    );
  const arch = macArchitecture(await readFile(binary));
  const filename = `libwebview.${arch}.dylib`;
  const response = await fetcher(
    `https://github.com/webview/webview_deno/releases/download/${WEBVIEW_VERSION}/${filename}`,
    { signal: globalThis.AbortSignal.timeout(30_000) },
  );
  if (!response.ok)
    throw new Error(`Native webview download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== WEBVIEW_HASHES[arch])
    throw new Error("Native webview checksum mismatch");
  const frameworks = join(app, "Contents", "Frameworks");
  const resources = join(app, "Contents", "Resources");
  await mkdir(frameworks, { recursive: true });
  await mkdir(resources, { recursive: true });
  await writeFile(join(frameworks, filename), bytes);
  await copyFile(
    new URL("./macos/webview-LICENSE.txt", import.meta.url),
    join(resources, "webview-LICENSE.txt"),
  );
  return join(frameworks, filename);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 4)
    throw new Error("Usage: macos-native.mjs <binary> <app>");
  process.stdout.write(
    `${await installMacWebview(process.argv[2], process.argv[3])}\n`,
  );
}
