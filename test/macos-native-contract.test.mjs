// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installMacWebview,
  macArchitecture,
  WEBVIEW_VERSION,
} from "../scripts/macos-native.mjs";

function macho(cpu) {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpu, 4);
  return bytes;
}

test("native Mac library follows the binary architecture, not the build host", () => {
  assert.equal(macArchitecture(macho(0x01000007)), "x86_64");
  assert.equal(macArchitecture(macho(0x0100000c)), "aarch64");
  assert.throws(() => macArchitecture(Buffer.alloc(8)), /Mach-O/);
  assert.throws(() => macArchitecture(macho(0)), /architecture/);
});

test("native Mac packaging rejects unverified bytes before writing the bundle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hq-native-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "binary");
  const app = join(root, "Test.app");
  await writeFile(binary, macho(0x01000007));
  const urls = [];
  await assert.rejects(
    installMacWebview(binary, app, async (url) => {
      urls.push(url);
      return new Response("wrong library");
    }),
    /checksum mismatch/,
  );
  assert.deepEqual(urls, [
    `https://github.com/webview/webview_deno/releases/download/${WEBVIEW_VERSION}/libwebview.x86_64.dylib`,
  ]);
  await assert.rejects(stat(app), { code: "ENOENT" });
  await assert.rejects(
    installMacWebview(
      binary,
      app,
      async () => new Response("", { status: 404 }),
    ),
    /HTTP 404/,
  );
});

test("Mac bundles select a local library before importing webview and sign it first", async () => {
  const runtime = await readFile(
    new URL("../desktop/runtime.ts", import.meta.url),
    "utf8",
  );
  const main = await readFile(
    new URL("../desktop/main.ts", import.meta.url),
    "utf8",
  );
  const signer = await readFile(
    new URL("../scripts/macos-sign.sh", import.meta.url),
    "utf8",
  );
  assert.match(runtime, /\.app\/Contents/);
  assert.match(runtime, /Deno\.statSync\(file\)/);
  assert.match(runtime, /Deno\.env\.set\("PLUGIN_URL", pathToFileURL/);
  assert.ok(
    main.indexOf("prepareBundledWebview();") <
      main.indexOf('await import("@webview/webview")'),
  );
  assert.ok(
    signer.indexOf('sign "$native_library"') < signer.indexOf('sign "$app"'),
  );
  assert.match(signer, /macos-native\.mjs/);
});

test("Mac downloads use a fixed loopback endpoint and command lookup stays transient", async () => {
  const runtime = await readFile(
    new URL("../desktop/runtime.ts", import.meta.url),
    "utf8",
  );
  assert.match(runtime, /new URL\("\/mcp\/novamira-hq\.mcpb", origin\)/);
  assert.match(runtime, /url\.hostname !== "127\.0\.0\.1"/);
  assert.match(runtime, /event\.isTrusted/);
  assert.match(runtime, /Opening download in your browser/);
  assert.match(runtime, /\.local\/bin/);
  assert.match(runtime, /3000/);
  assert.doesNotMatch(runtime, /writeFile|npm|nvm|\.codex/);
});
