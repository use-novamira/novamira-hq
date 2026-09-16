// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { McpConfiguration } from "../mcp-connection.js";

/** Small ZIP STORE writer for the fixed, in-memory MCPB files. No user filenames. */
function archive(files: Readonly<Record<string, string>>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12); // 1980-01-01, deterministic DOS date.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(local.length / 3, 8);
  end.writeUInt16LE(local.length / 3, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

// The installed extension forwards stdio to the existing installation. On
// Windows npm's .cmd shim cannot be spawned without a shell: use its JS entry
// with Claude's Node runtime instead, as the site CLI integration does.
const LAUNCHER = `// SPDX-License-Identifier: AGPL-3.0-or-later
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const launch = require('../launch.json');
let command = launch.command;
let args = launch.args;
if (process.platform === 'win32' && command === 'novamira-hq') {
  let entry;
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue;
    for (const relative of ['node_modules/@novamira/hq/dist/index.js', '../lib/node_modules/@novamira/hq/dist/index.js']) {
      const candidate = join(dir.replace(/^"|"$/g, ''), relative);
      if (existsSync(candidate)) { entry = candidate; break; }
    }
    if (entry) break;
  }
  if (!entry) { process.stderr.write('Install Novamira HQ before connecting Claude Desktop.\\n'); process.exit(1); }
  command = process.execPath;
  args = [entry, ...args];
}
// Claude's embedded runtime supplies JS streams, not necessarily OS fds 0/1/2.
const child = spawn(command, args, { shell: false, stdio: 'pipe' });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
child.on('error', () => { process.stderr.write('Novamira HQ could not start. Check its installation.\\n'); process.exitCode = 1; });
child.on('close', code => { process.stdin.unpipe(child.stdin); process.stdin.pause(); process.exitCode = code ?? 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
`;

/** Adapted from novamira-private's manifest + entry-point MCPB download. */
export function createMcpBundle(
  configuration: McpConfiguration,
  version: string,
): Buffer {
  const server = (
    JSON.parse(configuration.claude) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    }
  ).mcpServers["novamira-hq"];
  const manifest = {
    manifest_version: "0.3",
    name: "novamira-hq",
    display_name: "Novamira HQ",
    version,
    description: "Manage your sites with Novamira.",
    author: { name: "Ovation S.r.l." },
    license: "AGPL-3.0-or-later",
    tools_generated: true,
    server: {
      type: "node",
      entry_point: "server/index.cjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/index.cjs"],
        ...(server?.env ? { env: server.env } : {}),
      },
    },
  };
  return archive({
    "manifest.json": JSON.stringify(manifest, null, 2),
    "launch.json": JSON.stringify(configuration.launch),
    "server/index.cjs": LAUNCHER,
  });
}
