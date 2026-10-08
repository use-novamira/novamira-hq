// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultFileSecurity } from "../dist/config/file-security.js";
import {
  nextLaunchRecord,
  readLaunchRecord,
  writeLaunchRecord,
} from "../dist/mcp/relocation.js";

test("the launch record keeps the previous command only when it changes", () => {
  assert.deepEqual(nextLaunchRecord(undefined, "/new/hq"), {
    command: "/new/hq",
  });
  assert.deepEqual(nextLaunchRecord({ command: "/new/hq" }, "/new/hq"), {
    command: "/new/hq",
  });
  assert.deepEqual(nextLaunchRecord({ command: "/old/hq" }, "/new/hq"), {
    command: "/new/hq",
    previous: "/old/hq",
  });
  // Still pending from an earlier launch: kept until detection clears it.
  assert.deepEqual(
    nextLaunchRecord({ command: "/new/hq", previous: "/old/hq" }, "/new/hq"),
    { command: "/new/hq", previous: "/old/hq" },
  );
  // A further move replaces the pending one with the latest old location.
  assert.deepEqual(
    nextLaunchRecord({ command: "/new/hq", previous: "/old/hq" }, "/third/hq"),
    { command: "/third/hq", previous: "/new/hq" },
  );
});

test("a corrupt or foreign record reads as missing", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hq-launch-"));
  const path = join(folder, "mcp-launch.json");
  try {
    assert.equal(await readLaunchRecord(path), undefined);
    for (const content of [
      "{",
      "[]",
      '{"version":2,"command":"/x"}',
      '{"version":1}',
    ]) {
      await writeFile(path, content);
      assert.equal(await readLaunchRecord(path), undefined, content);
    }
    await writeLaunchRecord(
      path,
      { command: "/a", previous: "/b" },
      defaultFileSecurity(),
    );
    assert.deepEqual(await readLaunchRecord(path), {
      command: "/a",
      previous: "/b",
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
