// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Read regular-file entries only. No paths are ever extracted to disk and no
// third-party build script is executed. Rust registry archives use tar+gzip.
import { gunzipSync } from "node:zlib";

export function readCrateArchive(compressed) {
  const data = gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 });
  const files = new Map();
  let extendedPath;
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const string = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const name = [string(345, 500), string(0, 100)].filter(Boolean).join("/");
    const rawSize = string(124, 136).trim();
    if (!/^[0-7]+$/.test(rawSize)) throw new Error("Unsupported tar size");
    const size = Number.parseInt(rawSize, 8);
    const start = offset + 512;
    if (!Number.isSafeInteger(size) || size < 0 || start + size > data.length)
      throw new Error("Truncated tar entry");
    const body = data.subarray(start, start + size);
    const type = header[156];
    if (type === 120) {
      const match = body.toString("utf8").match(/(?:^|\n)\d+ path=([^\n]+)/);
      if (match) extendedPath = match[1];
    } else if (type === 76) {
      extendedPath = body.toString("utf8").replace(/\0.*$/s, "");
    } else {
      if (type === 0 || type === 48) files.set(extendedPath ?? name, body);
      extendedPath = undefined;
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

export function isNoticePath(path) {
  return /(?:^|\/)(?:licen[sc]es?|copying|notice|copyright|authors)(?:[/._-]|$)/i.test(
    path,
  );
}
