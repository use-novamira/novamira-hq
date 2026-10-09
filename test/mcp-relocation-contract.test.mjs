// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultFileSecurity } from "../dist/config/file-security.js";
import { createMcpConnectionService } from "../dist/mcp/configuration.js";
import {
  findClientsUsing,
  isOutsideApplications,
  mentions,
  nextLaunchRecord,
  nodeDetectionHost,
  readLaunchRecord,
  writeLaunchRecord,
} from "../dist/mcp/relocation.js";

test("the launch record keeps every previous command until it is cleared", () => {
  assert.deepEqual(nextLaunchRecord(undefined, "/new/hq"), {
    command: "/new/hq",
  });
  assert.deepEqual(nextLaunchRecord({ command: "/new/hq" }, "/new/hq"), {
    command: "/new/hq",
  });
  assert.deepEqual(nextLaunchRecord({ command: "/old/hq" }, "/new/hq"), {
    command: "/new/hq",
    previous: ["/old/hq"],
  });
  // Still pending from an earlier launch: kept until detection clears it.
  assert.deepEqual(
    nextLaunchRecord({ command: "/new/hq", previous: ["/old/hq"] }, "/new/hq"),
    { command: "/new/hq", previous: ["/old/hq"] },
  );
  // A further move keeps the first old location too.
  assert.deepEqual(
    nextLaunchRecord(
      { command: "/new/hq", previous: ["/old/hq"] },
      "/third/hq",
    ),
    { command: "/third/hq", previous: ["/new/hq", "/old/hq"] },
  );
  // Moving back to an old location stops treating it as old.
  assert.deepEqual(
    nextLaunchRecord({ command: "/new/hq", previous: ["/old/hq"] }, "/old/hq"),
    { command: "/old/hq", previous: ["/new/hq"] },
  );
  // Bounded.
  assert.equal(
    nextLaunchRecord(
      { command: "/6", previous: ["/5", "/4", "/3", "/2", "/1"] },
      "/7",
    ).previous.length,
    5,
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
      { command: "/a", previous: ["/b"] },
      defaultFileSecurity(),
    );
    assert.deepEqual(await readLaunchRecord(path), {
      command: "/a",
      previous: ["/b"],
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
    exists: async () => false,
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

function spawnRecorder(calls, failures = new Set()) {
  return (command, args) => {
    calls.push([command, ...args].join(" "));
    const child = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit("close", failures.has(args[1]) ? 1 : 0));
    return child;
  };
}

test("relocation reports clients on the old command until none remain, and dismiss clears it", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hq-relocation-"));
  try {
    let files = {};
    const service = (command) =>
      createMcpConnectionService(
        { command, args: ["--mcp"] },
        {},
        spawnRecorder([]),
        {
          stateDir: folder,
          security: defaultFileSecurity(),
          executable: command,
          host: {
            ...host({}, {}, "linux"),
            readText: async (path) => files[path],
          },
        },
      );
    assert.equal(await service("/old/hq").relocation(), undefined);
    files = { "/Users/mario/.cursor/mcp.json": '{"command":"/old/hq"}' };
    const moved = service("/new/hq");
    assert.deepEqual(await moved.relocation(), {
      previous: ["/old/hq"],
      current: "/new/hq",
      clients: ["cursor"],
    });
    await moved.dismissRelocation();
    assert.equal(await service("/new/hq").relocation(), undefined);
    // A later move shows it again.
    files = { "/Users/mario/.cursor/mcp.json": '{"command":"/new/hq"}' };
    assert.deepEqual(await service("/third/hq").relocation(), {
      previous: ["/new/hq"],
      current: "/third/hq",
      clients: ["cursor"],
    });
    // Nothing left on the old command clears the record by itself.
    files = {};
    assert.equal(await service("/third/hq").relocation(), undefined);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("replace removes, then adds, even when nothing was there to remove", async () => {
  for (const [client, remove] of [
    ["claude-code", "claude mcp remove --scope user novamira-hq"],
    ["codex", "codex mcp remove novamira-hq"],
  ]) {
    const calls = [];
    const service = createMcpConnectionService(
      { command: "/new/hq", args: ["--mcp"] },
      {},
      spawnRecorder(calls, new Set(["remove"])),
    );
    assert.equal(
      await service.connect(client, { replace: true }),
      "configured",
    );
    assert.equal(calls[0], remove);
    assert.match(calls[1], / mcp add /);
    assert.ok(!calls.some((call) => call.includes("mcp get")));
  }
});

function relocating(folder, command, files, existing = new Set(), counter) {
  return createMcpConnectionService(
    { command, args: ["--mcp"] },
    {},
    spawnRecorder([]),
    {
      stateDir: folder,
      security: defaultFileSecurity(),
      executable: command,
      host: {
        ...host({}, {}, "linux"),
        readText: async (path) => {
          if (counter) counter.reads++;
          return files()[path];
        },
        exists: async (path) => existing.has(path),
      },
    },
  );
}

test("an old location that still exists is not reported", async () => {
  // Enabling command registration, or copying instead of moving, leaves the
  // old executable in place: clients configured with it still work.
  const folder = await mkdtemp(join(tmpdir(), "hq-relocation-"));
  try {
    const files = () => ({
      "/Users/mario/.cursor/mcp.json": '{"command":"/old/hq"}',
    });
    await relocating(folder, "/old/hq", files).relocation();
    assert.equal(
      await relocating(
        folder,
        "/launcher",
        files,
        new Set(["/old/hq"]),
      ).relocation(),
      undefined,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a second move keeps reporting clients left on the first location", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hq-relocation-"));
  try {
    const files = () => ({
      "/Users/mario/.cursor/mcp.json": '{"command":"/a/hq"}',
    });
    await relocating(folder, "/a/hq", files).relocation();
    assert.ok(await relocating(folder, "/b/hq", files).relocation());
    assert.deepEqual(await relocating(folder, "/c/hq", files).relocation(), {
      previous: ["/a/hq"],
      current: "/c/hq",
      clients: ["cursor"],
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("page views reuse recent detection and do not rewrite an unchanged record", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hq-relocation-"));
  try {
    const files = () => ({
      "/Users/mario/.cursor/mcp.json": '{"command":"/old/hq"}',
    });
    await relocating(folder, "/old/hq", files).relocation();
    const record = join(folder, "mcp-launch.json");
    const quiet = await stat(record);
    await relocating(folder, "/old/hq", files).relocation();
    assert.equal((await stat(record)).ino, quiet.ino);
    const counter = { reads: 0 };
    const service = relocating(folder, "/new/hq", files, new Set(), counter);
    assert.ok(await service.relocation());
    const reads = counter.reads;
    const written = await stat(record);
    assert.ok(await service.relocation());
    assert.equal(counter.reads, reads, "detection is reused within a minute");
    assert.equal((await stat(record)).ino, written.ino);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a client CLI that hangs is killed when detection gives up", async () => {
  const started = Date.now();
  const output = await nodeDetectionHost(process.env, { timeoutMs: 200 }).run(
    process.execPath,
    ["-e", "process.stdout.write('x'); setInterval(() => {}, 1000)"],
  );
  assert.equal(output, undefined);
  assert.ok(Date.now() - started < 5000);
});

test("Windows npm shims are run through cmd.exe with fixed arguments", async () => {
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push([command, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      if (command === "claude") {
        child.emit(
          "error",
          Object.assign(new Error("spawn"), { code: "ENOENT" }),
        );
        return;
      }
      child.stdout.emit("data", Buffer.from("Command: C:\\old.exe"));
      child.emit("close", 0);
    });
    return child;
  };
  const output = await nodeDetectionHost(
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    { platform: "win32", spawnProcess },
  ).run("claude", ["mcp", "get", "novamira-hq"]);
  assert.equal(output, "Command: C:\\old.exe");
  assert.deepEqual(calls[1], [
    "C:\\Windows\\System32\\cmd.exe",
    "/d",
    "/s",
    "/c",
    "claude mcp get novamira-hq",
  ]);
});
