// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { McpConfiguration } from "../mcp-connection.js";
import { readFileSync } from "node:fs";

/** Small ZIP STORE writer for the fixed, in-memory MCPB files. No user filenames. */
function archive(files: Readonly<Record<string, string | Buffer>>): Buffer {
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

// Forward stdio to the installed command, independent of its package manager.
const LAUNCHER = `// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later
const { spawn } = require('node:child_process');
const launch = require('../launch.json');
// Claude's embedded runtime supplies JS streams, not necessarily OS fds 0/1/2.
const child = spawn(launch.command, launch.args, { shell: false, stdio: 'pipe' });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
child.on('error', () => { process.stderr.write('Novamira HQ could not start. Make sure novamira-hq is installed and available to your AI client.\\n'); process.exit(1); });
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
  const env = Object.fromEntries(
    Object.entries(server?.env ?? {}).filter(
      ([name]) => name.toUpperCase() !== "PATH",
    ),
  );
  const manifest = {
    manifest_version: "0.3",
    name: "novamira-hq",
    display_name: "Novamira HQ",
    version,
    description: "Manage your sites with Novamira HQ.",
    icon: "icon.png",
    author: { name: "Ovation S.r.l." },
    license: "AGPL-3.0-or-later",
    tools_generated: true,
    server: {
      type: "node",
      entry_point: "server/index.cjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/index.cjs"],
        ...(Object.keys(env).length ? { env } : {}),
      },
    },
  };
  return archive({
    "manifest.json": JSON.stringify(manifest, null, 2),
    "launch.json": JSON.stringify(configuration.launch),
    "server/index.cjs": LAUNCHER,
    "icon.png": readFileSync(new URL("./icon.png", import.meta.url)),
    LICENSE: readFileSync(new URL("./LICENSE", import.meta.url)),
    "README.txt": `Novamira HQ ${version} connector\nCopyright (c) 2026 Ovation S.r.l.\nLicense: AGPL-3.0-or-later (see LICENSE).\n\nThis bundle contains the complete, unminified launcher source in server/index.cjs and the Novamira HQ icon. It starts a separately installed Novamira HQ; it does not embed Node, Deno or the HQ runtime dependencies. For those components, see About Novamira HQ > Legal notices in the installed application.\n\nHQ source: https://github.com/use-novamira/novamira-hq\nAsk your distributor for the matching source if you cannot access that repository.\n`,
  });
}
