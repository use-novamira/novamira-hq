// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { isNoticePath, readCrateArchive } from "../scripts/license-archive.mjs";

function entry(name, content, type = "0") {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write(type, 156);
  return Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}

test("license archive reader reads regular files, without extracting or following links", () => {
  const files = readCrateArchive(
    gzipSync(
      Buffer.concat([
        entry("crate/LICENSE", "original license"),
        entry("crate/link", "", "2"),
        entry("crate/hardlink", "", "1"),
      ]),
    ),
  );
  assert.equal(files.size, 1);
  assert.equal(files.get("crate/LICENSE").toString(), "original license");
});

test("license archive reader supports long names and rejects truncated entries", () => {
  const path = "crate/" + "a".repeat(150) + "/LICENSE";
  const files = readCrateArchive(
    gzipSync(
      Buffer.concat([
        entry("././@LongLink", path + "\0", "L"),
        entry("short", "text"),
      ]),
    ),
  );
  assert.equal(files.get(path).toString(), "text");
  assert.throws(
    () => readCrateArchive(gzipSync(entry("LICENSE", "text").subarray(0, 513))),
    /Truncated/,
  );
});

test("notice paths cover original variants, without treating source files as notices", () => {
  for (const path of [
    "LICENSE",
    "crate/License.txt",
    "crate/LICENSE-MIT",
    "crate/licenses/Apache.txt",
    "COPYING",
    "NOTICE.md",
  ])
    assert.equal(isNoticePath(path), true, path);
  assert.equal(isNoticePath("src/licensing.rs"), false);
  assert.equal(isNoticePath("src/main.rs"), false);
});
