// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installWindowsWebview,
  WINDOWS_WEBVIEW_HASHES,
  WEBVIEW_VERSION,
} from "../scripts/windows-native.mjs";

test("Windows native assets are pinned and checked before packaging", async (t) => {
  assert.equal(WEBVIEW_VERSION, "0.9.0");
  assert.deepEqual(Object.keys(WINDOWS_WEBVIEW_HASHES), [
    "webview.dll",
    "WebView2Loader.dll",
  ]);
  for (const digest of Object.values(WINDOWS_WEBVIEW_HASHES))
    assert.match(digest, /^[a-f0-9]{64}$/);
  const directory = await mkdtemp(join(tmpdir(), "hq-windows-native-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    installWindowsWebview(directory, async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })),
    /checksum mismatch: webview\.dll/,
  );
});

test("Windows build embeds native assets and stages them before webview import", async () => {
  const config = JSON.parse(
    await readFile(new URL("../desktop/deno.json", import.meta.url), "utf8"),
  );
  const build = await readFile(
    new URL("../scripts/desktop-build.mjs", import.meta.url),
    "utf8",
  );
  const runtime = await readFile(
    new URL("../desktop/runtime.ts", import.meta.url),
    "utf8",
  );
  const main = await readFile(
    new URL("../desktop/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    config.tasks["compile:windows"],
    /--include \.\.\/dist-desktop\/native-windows/,
  );
  assert.match(
    build,
    /await installWindowsWebview\(join\(outDir, "native-windows"\)\)/,
  );
  assert.match(runtime, /Deno\.readFileSync\(asset\)/);
  assert.match(runtime, /defaultFileSecurity\(\)\.secureDirectory\(stage\)/);
  assert.match(runtime, /Deno\.env\.set\("PLUGIN_URL", pathToFileURL/);
  assert.ok(
    main.indexOf("prepareBundledWebview()") <
      main.indexOf('await import("@webview/webview")'),
  );
});

test("the window role hides only a console that belongs to it alone", async () => {
  const runtime = await readFile(
    new URL("../desktop/runtime.ts", import.meta.url),
    "utf8",
  );
  const main = await readFile(
    new URL("../desktop/main.ts", import.meta.url),
    "utf8",
  );
  const start = runtime.indexOf("export function hideOwnConsole");
  assert.ok(start >= 0, "hideOwnConsole is defined");
  const hide = runtime.slice(start, runtime.indexOf("\n}\n", start));
  assert.match(hide, /Deno\.build\.os !== "windows"/);
  assert.match(hide, /GetConsoleProcessList\(ids, 2\) === 1/);
  assert.match(hide, /ShowWindow\(handle, 0\)/);
  // Hiding keeps the console for children; freeing it would open new ones.
  assert.doesNotMatch(runtime, /FreeConsole/);
  const windowRole = main.slice(main.indexOf("async function window()"));
  assert.ok(
    windowRole.indexOf("hideOwnConsole();") >= 0 &&
      windowRole.indexOf("hideOwnConsole();") <
        windowRole.indexOf("commandRegistration()"),
  );
  // Only the window role hides it: CLI, MCP and the launcher keep output.
  assert.equal((main.match(/hideOwnConsole\(\);/g) ?? []).length, 1);
});
