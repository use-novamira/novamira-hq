// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import {
  mkdtemp,
  rm,
  readdir,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMcpConnectionService } from "../dist/mcp/configuration.js";
import { DEFAULT_MCP_LAUNCH } from "../dist/main.js";
import { createMcpBundle } from "../dist/mcp/bundle.js";
import { renderMcpPage } from "../dist/web/views/mcp.js";
import { renderHtml } from "../dist/web/html.js";
import { createDashboardUpdates } from "../dist/cli/dashboard.js";

test("client configs contain only fixed launch arguments and HQ path overrides", () => {
  const service = createMcpConnectionService(
    {
      command: "/Applications/Novamira HQ.app/Contents/MacOS/hq",
      args: ["--mcp"],
    },
    {
      NOVAMIRA_HQ_HOME: "/private/example path",
      KINSTA_API_KEY: "must-not-copy-this",
    },
  );
  const config = service.configuration();
  const server = JSON.parse(config.claude).mcpServers["novamira-hq"];
  assert.deepEqual(server.args, ["--mcp"]);
  assert.deepEqual(server.env, { NOVAMIRA_HQ_HOME: "/private/example path" });
  assert.match(config.chatgpt, /\[mcp_servers.novamira-hq\]/);
  assert.doesNotMatch(
    JSON.stringify(config),
    /must-not-copy-this|KINSTA_API_KEY/,
  );
  assert.doesNotMatch(JSON.stringify(config), /--access|--allow|--deny/);
});

test("the npm MCP launch survives Node upgrades and package relocation", () => {
  assert.deepEqual(DEFAULT_MCP_LAUNCH, {
    command: "novamira-hq",
    args: ["mcp"],
  });
  const config = createMcpConnectionService(DEFAULT_MCP_LAUNCH, {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    KINSTA_API_KEY: "must-not-copy-this",
  }).configuration();
  const server = JSON.parse(config.claude).mcpServers["novamira-hq"];
  assert.deepEqual(server, {
    command: "novamira-hq",
    args: ["mcp"],
  });
  assert.doesNotMatch(
    JSON.stringify(config),
    /KINSTA_API_KEY|must-not-copy-this/,
  );
});

test("real local MCP handshake lists tools without configuring profiles or writing state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hq-mcp-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createMcpConnectionService(
    {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../dist/index.js", import.meta.url)),
        "mcp",
      ],
    },
    { ...process.env, NOVAMIRA_HQ_HOME: root, NOVAMIRA_HQ_UPDATE_CHECK: "0" },
  );
  const result = await service.verify();
  assert.ok(result.toolCount > 0);
  assert.deepEqual(await readdir(root), []);
});

test("the downloaded MCP bundle runs after relocation and lists real tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hq-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = createMcpConnectionService(
    {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../dist/index.js", import.meta.url)),
        "mcp",
      ],
    },
    { NOVAMIRA_HQ_HOME: join(root, "home"), KINSTA_API_KEY: "never-in-bundle" },
  ).configuration();
  const zip = createMcpBundle(config, "1.0.0-rc1");
  assert.ok(!zip.includes(Buffer.from("never-in-bundle")));
  const files = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0);
    const length = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength;
    files.set(
      zip.subarray(offset + 30, start).toString(),
      zip.subarray(start, start + length),
    );
    offset = start + length;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.deepEqual(
    [...files.keys()],
    [
      "manifest.json",
      "launch.json",
      "server/index.cjs",
      "icon.png",
      "LICENSE",
      "README.txt",
    ],
  );
  const manifest = JSON.parse(files.get("manifest.json"));
  assert.deepEqual(
    files.get("LICENSE"),
    await readFile(new URL("../LICENSE", import.meta.url)),
  );
  assert.match(
    files.get("README.txt").toString(),
    /complete, unminified launcher source/,
  );
  assert.equal(manifest.icon, "icon.png");
  assert.deepEqual(
    files.get(manifest.icon),
    await readFile(new URL("../scripts/macos/icon.png", import.meta.url)),
  );
  // Claude's embedded runtime exposes JS streams rather than ordinary file
  // descriptors. An inherited-stdio child silently misses this initialize.
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  });
  const runtime = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    platform: "darwin",
    execPath: process.execPath,
    env: {},
  });
  runInNewContext(files.get("server/index.cjs").toString(), {
    process: runtime,
    require(name) {
      if (name === "node:child_process")
        return {
          spawn(command, args, options) {
            assert.equal(command, "novamira-hq");
            assert.deepEqual(Array.from(args), ["mcp"]);
            assert.equal(options.env, undefined);
            assert.equal(options.stdio, "pipe");
            assert.equal(options.shell, false);
            return child;
          },
        };
      if (name === "../launch.json") return DEFAULT_MCP_LAUNCH;
      return createRequire(import.meta.url)(name);
    },
  });
  runtime.stdin.write("initialize\n");
  assert.equal(child.stdin.read().toString(), "initialize\n");
  child.stdout.write("reply\n");
  assert.equal(runtime.stdout.read().toString(), "reply\n");
  child.stderr.write("diagnostic\n");
  assert.equal(runtime.stderr.read().toString(), "diagnostic\n");
  assert.equal(runtime.stdout.read(), null);
  child.emit("close", 0);
  assert.equal(runtime.exitCode, 0);
  assert.equal(manifest.description, "Manage your sites with Novamira HQ.");
  assert.equal(manifest.server.mcp_config.command, "node");
  const portableConfig = {
    ...config,
    launch: DEFAULT_MCP_LAUNCH,
    claude: JSON.stringify({
      mcpServers: { "novamira-hq": { env: { PATH: "/private/old-node/bin" } } },
    }),
  };
  assert.ok(
    !createMcpBundle(portableConfig, "1.0.0").includes(
      Buffer.from("/private/old-node/bin"),
    ),
  );
  const defaultLaunch = JSON.parse(files.get("launch.json"));
  assert.doesNotMatch(
    files.get("server/index.cjs").toString(),
    /node_modules|process.execPath|existsSync|NVM|homebrew/,
  );
  assert.ok(defaultLaunch.command);
  assert.deepEqual(manifest.server.mcp_config.args, [
    "${__dirname}/server/index.cjs",
  ]);
  const destination = join(root, "Claude extensions with spaces");
  await mkdir(join(destination, "server"), { recursive: true });
  for (const [name, data] of files)
    await writeFile(join(destination, name), data);
  const launch = createMcpConnectionService(
    {
      command: process.execPath,
      args: [join(destination, manifest.server.entry_point)],
    },
    { ...process.env, ...manifest.server.mcp_config.env },
  );
  assert.ok((await launch.verify()).toolCount > 0);
  const markup = renderHtml(
    renderMcpPage({ profiles: [], pushes: [] }, config, "claude"),
  );
  assert.ok(markup.includes('href="/mcp/novamira-hq.mcpb"'));
  assert.ok(!markup.includes("About this connection"));
});

test("MCP page chooses a client before showing its setup", () => {
  const config = createMcpConnectionService(
    { command: "/a path/node", args: ["/hq/index.js", "mcp"] },
    {},
  ).configuration();
  const choice = renderHtml(
    renderMcpPage(
      {
        profiles: [
          {
            name: "future-profile",
            provider: "future-adapter",
            credentialAvailable: false,
          },
        ],
        pushes: [],
      },
      config,
    ),
  );
  assert.ok(choice.includes("Which AI client do you use?"));
  assert.ok(choice.includes("/configure-ai?client=chatgpt"));
  assert.ok(choice.includes("/configure-ai?client=claude"));
  assert.ok(!choice.includes("Copy configuration"));

  const markup = renderHtml(
    renderMcpPage(
      {
        profiles: [
          {
            name: "future-profile",
            provider: "future-adapter",
            credentialAvailable: false,
          },
        ],
        pushes: [],
      },
      config,
      "chatgpt",
    ),
  );
  for (const text of [
    "ChatGPT Desktop",
    "Configure with one click",
    "Manual configuration",
    "Copy configuration",
    "Choose another AI client",
  ])
    assert.ok(markup.includes(text), text);
  assert.ok(!markup.includes("Test Novamira HQ locally"));
  assert.doesNotMatch(markup, /(?<!Novamira )\bHQ\b/);
});

test("one-click ChatGPT setup checks first, then uses the official codex command without a shell", async () => {
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit("close", calls.length === 1 ? 1 : 0));
    return child;
  };
  const service = createMcpConnectionService(
    { command: "/a path/node", args: ["/hq/index.js", "mcp"] },
    { NOVAMIRA_HQ_HOME: "/private/hq home" },
    fakeSpawn,
  );
  await service.connect("chatgpt");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "codex");
  assert.deepEqual(calls[0].args, ["mcp", "get", "novamira-hq"]);
  assert.deepEqual(calls[1].args, [
    "mcp",
    "add",
    "novamira-hq",
    "--env",
    "NOVAMIRA_HQ_HOME=/private/hq home",
    "--",
    "/a path/node",
    "/hq/index.js",
    "mcp",
  ]);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.stdio, "ignore");
});

test("standalone desktop never delegates its updater to npm", async () => {
  const updates = createDashboardUpdates({
    distribution: "desktop",
    paths: { stateDir: "/unused" },
    version: "1.0.0",
    createUpdateChecker: () => {
      throw new Error("must not inspect npm");
    },
  });
  assert.equal(updates.desktop, true);
  assert.equal(typeof updates.refresh, "function");
  await assert.rejects(updates.install(), /standalone desktop/);
});

test("MCP rejects removed launch options instead of silently broadening access", () => {
  for (const option of ["--access", "--allow", "--deny"]) {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../dist/index.js", import.meta.url)),
        "mcp",
        option,
        "read",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(child.status, 0);
    assert.doesNotMatch(child.stdout, /"tools"/);
  }
});
