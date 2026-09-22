// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultFileSecurity } from "../dist/config/file-security.js";
import {
  DesktopUpdateChecker,
  desktopAsset,
  selectDesktopRelease,
} from "../dist/update/desktop.js";

const asset = desktopAsset("linux", "x64");
function release(version, overrides = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes("-"),
    assets: [
      {
        name: asset,
        size: 100,
        state: "uploaded",
        browser_download_url: `https://github.com/use-novamira/novamira-hq/releases/download/v${version}/${asset}`,
      },
    ],
    ...overrides,
  };
}

test("desktop channels select by SemVer and require a published platform artifact", () => {
  const catalog = [
    release("2.0.0-rc1"),
    release("1.1.0"),
    release("9.0.0", { draft: true }),
    release("8.0.0", { assets: [] }),
    release("1.0.0"),
  ];
  assert.equal(selectDesktopRelease(catalog, "1.0.0", asset).latest, "1.1.0");
  assert.equal(
    selectDesktopRelease(catalog, "1.0.0-rc1", asset).latest,
    "2.0.0-rc1",
  );
  assert.equal(
    selectDesktopRelease([release("1.0.0")], "1.0.0-rc1", asset).latest,
    "1.0.0",
  );
  const bad = release("3.0.0");
  bad.assets[0].browser_download_url = "https://example.com/update";
  assert.throws(
    () => selectDesktopRelease([bad], "1.0.0", asset),
    /No published/,
  );
  assert.throws(() => selectDesktopRelease({}, "1.0.0", asset), /invalid/);
  assert.equal(
    desktopAsset("darwin", "arm64"),
    "novamira-hq-desktop-macos-arm64.dmg",
  );
  assert.equal(
    desktopAsset("darwin", "x64"),
    "novamira-hq-desktop-macos-x86_64.dmg",
  );
  assert.equal(
    desktopAsset("win32", "x64"),
    "novamira-hq-desktop-windows-x86_64.exe",
  );
  assert.equal(desktopAsset("linux", "arm64"), undefined);
});

test("desktop cache survives launches, coalesces checks, throttles failures, and permits manual retries", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hq-desktop-update-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = Date.now();
  let calls = 0;
  let fail = false;
  const options = {
    current: "1.0.0",
    platform: "linux",
    arch: "x64",
    now: () => now,
    fetch: async (url, init) => {
      calls++;
      assert.equal(
        String(url),
        "https://updates.novamira.ai/api/novamira-hq/releases",
      );
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Accept, "application/json");
      if (fail) throw new Error("offline");
      return Response.json([release("1.1.0")]);
    },
  };
  const make = () =>
    new DesktopUpdateChecker(home, defaultFileSecurity(), options);
  const checker = make();
  const statuses = await Promise.all([checker.check(), checker.check()]);
  assert.equal(statuses[0].updateAvailable, true);
  assert.equal(calls, 1);
  assert.equal((await make().check()).latest, "1.1.0");
  assert.equal(calls, 1);
  now += 24 * 60 * 60 * 1000;
  fail = true;
  assert.equal(await make().check(), undefined);
  assert.equal(await make().check(), undefined);
  assert.equal(calls, 2);
  await assert.rejects(make().check(true), /Desktop update check failed/);
  assert.equal(calls, 3);
  fail = false;
  assert.equal((await make().check(true)).updateAvailable, true);
  assert.equal(calls, 4);
  assert.equal(
    JSON.parse(await readFile(join(home, "desktop-update-check.json"), "utf8"))
      .identity,
    `1.0.0/${asset}`,
  );
  await assert.rejects(readFile(join(home, "update-check.json")), {
    code: "ENOENT",
  });
});

test("update statistics persist within a month, rotate, and can be disabled", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hq-update-stats-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = process.env.NOVAMIRA_HQ_UPDATE_STATS;
  delete process.env.NOVAMIRA_HQ_UPDATE_STATS;
  t.after(() => {
    if (previous === undefined) delete process.env.NOVAMIRA_HQ_UPDATE_STATS;
    else process.env.NOVAMIRA_HQ_UPDATE_STATS = previous;
  });
  let now = Date.parse("2026-09-22T12:00:00Z");
  const requests = [];
  const make = () =>
    new DesktopUpdateChecker(home, defaultFileSecurity(), {
      current: "1.0.0",
      platform: "linux",
      arch: "x64",
      now: () => now,
      fetch: async (_url, init) => {
        requests.push(init.headers);
        return Response.json([release("1.1.0")]);
      },
    });
  await make().check(true);
  await make().check(true);
  const id = requests[0]["X-Novamira-Install"];
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(requests[0], {
    Accept: "application/json",
    "X-Novamira-Install": id,
    "X-Novamira-Version": "1.0.0",
    "X-Novamira-Platform": "linux",
    "X-Novamira-Arch": "x64",
  });
  assert.deepEqual(requests[1], requests[0]);
  now = Date.parse("2026-10-01T00:00:00Z");
  await make().check(true);
  assert.notEqual(requests[2]["X-Novamira-Install"], id);
  await rm(join(home, "desktop-update-stats.json"));
  process.env.NOVAMIRA_HQ_UPDATE_STATS = "0";
  await make().check(true);
  assert.deepEqual(requests[3], { Accept: "application/json" });
  await assert.rejects(readFile(join(home, "desktop-update-stats.json")), {
    code: "ENOENT",
  });
});

test("invalid, oversized and HTTP-error catalogs never claim the desktop is current", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hq-desktop-errors-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const response of [
    Response.json([]),
    new Response("bad json"),
    new Response("rate limited", { status: 403 }),
    new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const checker = new DesktopUpdateChecker(home, defaultFileSecurity(), {
      current: "1.0.0",
      platform: "linux",
      arch: "x64",
      fetch: async () => response,
    });
    await assert.rejects(checker.check(true), /Desktop update check failed/);
  }
});
