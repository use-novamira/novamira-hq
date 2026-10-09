// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultFileSecurity } from "../dist/config/file-security.js";
import {
  findClientsUsing,
  isOutsideApplications,
  mentions,
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

const OLD =
  "C:\\Users\\Mario Rossi\\Downloads\\novamira-hq-desktop-windows-x86_64.exe";

function host(files, outputs = {}, platform = "win32") {
  return {
    platform,
    home: platform === "win32" ? "C:\\Users\\Mario Rossi" : "/Users/mario",
    environment:
      platform === "win32"
        ? { APPDATA: "C:\\Users\\Mario Rossi\\AppData\\Roaming" }
        : {},
    readText: async (path) => files[path],
    list: async (directory) =>
      Object.keys(files)
        .filter((path) => path.startsWith(directory) && path !== directory)
        .map((path) => path.slice(directory.length + 1).split(/[\\/]/)[0]),
    run: async (command, args) => outputs[[command, ...args].join(" ")],
  };
}

test("mentions matches raw and JSON/TOML-escaped commands", () => {
  assert.ok(mentions(`command = "${OLD.replaceAll("\\", "\\\\")}"`, OLD));
  assert.ok(mentions(`Command: ${OLD}`, OLD));
  assert.ok(!mentions('command = "novamira-hq"', OLD));
});

test("each client is detected from its own official location on Windows", async () => {
  const escaped = JSON.stringify(OLD);
  const home = "C:\\Users\\Mario Rossi";
  const appData = `${home}\\AppData\\Roaming`;
  const path = (...parts) => parts.join("\\");
  const files = {
    [path(home, ".codex", "config.toml")]:
      `[mcp_servers.novamira-hq]\ncommand = ${escaped}\n`,
    [path(home, ".cursor", "mcp.json")]:
      `{"mcpServers":{"novamira-hq":{"command":${escaped}}}}`,
    [path(home, ".gemini", "config", "mcp_config.json")]: `{"mcpServers":{}}`,
    [path(appData, "Code", "User", "mcp.json")]:
      `{"servers":{"novamira-hq":{"command":${escaped}}}}`,
    [path(
      appData,
      "Claude",
      "Claude Extensions",
      "local.novamira-hq",
      "launch.json",
    )]: `{"command":${escaped},"args":["--mcp"]}`,
  };
  const outputs = {
    "claude mcp get novamira-hq": `novamira-hq:\n  Command: ${OLD}\n`,
  };
  assert.deepEqual(await findClientsUsing(OLD, host(files, outputs)), [
    "claude-code",
    "codex",
    "cursor",
    "vscode",
    "claude",
  ]);
});

test("missing files and failing or hanging commands mean not detected", async () => {
  const hanging = { ...host({}), run: () => new Promise(() => {}) };
  const started = Date.now();
  assert.deepEqual(await findClientsUsing(OLD, hanging, 50), []);
  assert.ok(Date.now() - started < 2000);
});

test("macOS warns outside Applications only", () => {
  const app = "Novamira HQ.app/Contents/MacOS/novamira-hq-desktop";
  assert.equal(
    isOutsideApplications(`/Applications/${app}`, "darwin", "/Users/m"),
    false,
  );
  assert.equal(
    isOutsideApplications(`/Users/m/Applications/${app}`, "darwin", "/Users/m"),
    false,
  );
  for (const path of [
    `/Volumes/Novamira HQ/${app}`,
    `/Users/m/Downloads/${app}`,
    `/private/var/folders/x/AppTranslocation/y/d/${app}`,
  ])
    assert.equal(isOutsideApplications(path, "darwin", "/Users/m"), true, path);
  assert.equal(
    isOutsideApplications("C:\\anything.exe", "win32", "C:\\Users\\m"),
    false,
  );
});
