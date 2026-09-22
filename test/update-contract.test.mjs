// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main, VERSION } from "../dist/main.js";
import { desktopAsset } from "../dist/update/desktop.js";
import { updateCheckEnabled, UPDATE_CHECK_FILE } from "../dist/update/index.js";

async function run(args, home, overrides = {}, environment = {}) {
  let stdout = "",
    stderr = "";
  const code = await main(
    args,
    {
      stdout: {
        write: (text) => {
          stdout += text;
        },
      },
      stderr: {
        write: (text) => {
          stderr += text;
        },
      },
    },
    { NOVAMIRA_HQ_HOME: home, ...environment },
    overrides,
  );
  return { code, stdout, stderr };
}

test("both update spellings report desktop downloads without installing", async () => {
  const home = await mkdtemp(join(tmpdir(), "hq-update-"));
  const asset = desktopAsset(process.platform, process.arch);
  const downloadUrl = `https://github.com/use-novamira/novamira-hq/releases/download/v99.0.0/${asset}`;
  try {
    for (const flags of [[], ["--check"]]) {
      let calls = 0;
      const result = await run(
        ["update", ...flags, "--json"],
        home,
        {
          updateFetch: async (url, init) => {
            calls++;
            assert.equal(
              String(url),
              "https://updates.novamira.ai/api/novamira-hq/releases",
            );
            assert.equal(init.redirect, "error");
            assert.deepEqual(init.headers, { Accept: "application/json" });
            return Response.json([
              {
                tag_name: "v99.0.0",
                draft: false,
                prerelease: false,
                assets: [
                  {
                    name: asset,
                    state: "uploaded",
                    size: 42,
                    browser_download_url: downloadUrl,
                  },
                ],
              },
            ]);
          },
        },
        {
          NOVAMIRA_HQ_REGISTRY: "https://obsolete.invalid",
          NOVAMIRA_HQ_UPDATE_STATS: "0",
        },
      );
      assert.equal(result.code, 0, result.stdout);
      const { data } = JSON.parse(result.stdout);
      assert.equal(data.current, VERSION);
      assert.equal(data.updateAvailable, true);
      assert.equal(data.updated, false);
      assert.equal(data.distribution, "desktop");
      assert.equal(data.downloadUrl, downloadUrl);
      assert.equal(calls, 1);
    }
    const failure = await run(["update", "--json"], home, {
      updateFetch: async () => {
        throw Error("offline");
      },
    });
    assert.equal(JSON.parse(failure.stdout).error.code, "network_error");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("scripted and offline commands suppress requests and update state", async () => {
  for (const args of [
    ["--version"],
    ["config", "list", "--json"],
    ["config", "list", "--quiet"],
    ["doctor", "--offline", "--json"],
  ]) {
    const home = await mkdtemp(join(tmpdir(), "hq-update-suppressed-"));
    try {
      let calls = 0;
      await run(args, home, {
        updateFetch: async () => {
          calls++;
          throw Error("unexpected request");
        },
      });
      assert.equal(calls, 0);
      await assert.rejects(stat(join(home, "state", UPDATE_CHECK_FILE)), {
        code: "ENOENT",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
  assert.equal(updateCheckEnabled({ NOVAMIRA_HQ_UPDATE_CHECK: "0" }), false);
  assert.equal(
    updateCheckEnabled({ NOVAMIRA_HQ_UPDATE_CHECK: "false" }),
    false,
  );
  assert.equal(updateCheckEnabled({ NOVAMIRA_UPDATE_CHECK: "0" }), true);
});

test("terminal opt-out and either piped stream suppress background checks before IO", async () => {
  for (const [stdinTTY, stdoutTTY, stderrTTY, optOut, expectedCalls] of [
    [true, true, true, "0", 0],
    [true, true, true, "false", 0],
    [true, false, true, undefined, 0],
    [true, true, false, undefined, 0],
    [false, true, true, undefined, 0],
    [true, true, true, undefined, 1],
  ]) {
    const home = await mkdtemp(join(tmpdir(), "hq-update-tty-"));
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    try {
      Object.defineProperty(process.stdin, "isTTY", {
        value: stdinTTY,
        configurable: true,
      });
      let calls = 0;
      await main(
        ["config", "list"],
        {
          stdout: { isTTY: stdoutTTY, write() {} },
          stderr: { isTTY: stderrTTY, write() {} },
        },
        { NOVAMIRA_HQ_HOME: home, NOVAMIRA_HQ_UPDATE_CHECK: optOut },
        {
          updateFetch: async () => {
            calls++;
            throw Error("unexpected request");
          },
        },
      );
      assert.equal(calls, expectedCalls);
      if (expectedCalls === 0) {
        await assert.rejects(stat(join(home, "state", UPDATE_CHECK_FILE)), {
          code: "ENOENT",
        });
      } else {
        await stat(join(home, "state", UPDATE_CHECK_FILE));
      }
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete process.stdin.isTTY;
      await rm(home, { recursive: true, force: true });
    }
  }
});
