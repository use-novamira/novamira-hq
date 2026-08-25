// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Deno desktop shell in `desktop/`.
 *
 * Mostly static analysis, in the manner of `install-scripts-contract`: the
 * shell is a second runtime this repository's Node toolchain cannot type-check
 * or lint, so what this suite pins is the shape that keeps it honest — the same
 * runtime dependencies at the same ranges as `package.json`, no copy of the
 * dashboard, a self-spawned `--serve` role, port 0, the parent watch — and it
 * then hands the file to `deno fmt` and `deno lint` when a `deno` is on `PATH`.
 * Both are offline; `deno check` and the compile need the JSR cache and are
 * `bun run desktop:check` / CI's job. Nothing here opens a window.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const denoConfig = JSON.parse(
  await readFile(join(root, "desktop", "deno.json"), "utf8"),
);
const shell = await readFile(join(root, "desktop", "main.ts"), "utf8");
const types = await readFile(join(root, "desktop", "hq.d.ts"), "utf8");
const code = shell
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join("\n");

test("desktop shell pins HQ's runtime dependencies at package.json's ranges", () => {
  assert.equal(denoConfig.version, manifest.version);
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    assert.equal(
      denoConfig.imports[name],
      `npm:${name}@${range}`,
      `${name} must be mapped to the npm package at package.json's range`,
    );
  }
  const extra = Object.keys(denoConfig.imports).filter(
    (name) => !(name in manifest.dependencies),
  );
  assert.deepEqual(extra, ["@webview/webview"]);
  assert.match(
    denoConfig.imports["@webview/webview"],
    /^jsr:@webview\/webview@\d/,
  );
});

test("desktop shell is outside the npm package and the Node toolchain", async () => {
  assert.ok(!manifest.files.includes("desktop"));
  assert.ok(!manifest.files.includes("dist-desktop"));
  assert.equal(manifest.dependencies["@webview/webview"], undefined);
  assert.equal(manifest.devDependencies["@webview/webview"], undefined);
  const prettierIgnore = await readFile(join(root, ".prettierignore"), "utf8");
  const gitIgnore = await readFile(join(root, ".gitignore"), "utf8");
  const eslint = await readFile(join(root, "eslint.config.js"), "utf8");
  assert.match(prettierIgnore, /^desktop$/m);
  assert.match(prettierIgnore, /^dist-desktop$/m);
  assert.match(gitIgnore, /^dist-desktop\/$/m);
  assert.match(eslint, /"desktop\/\*\*"/);
  assert.match(
    manifest.scripts["desktop:check"],
    /deno check desktop\/main\.ts/,
  );
  assert.match(manifest.scripts["desktop:build"], /^bun run build && /);
});

test("desktop shell runs HQ's own dashboard command and nothing else", () => {
  for (const file of [shell, types]) {
    assert.match(file, /^\/\/ SPDX-License-Identifier: AGPL-3\.0-or-later$/m);
  }
  // The server role is `main` from `dist/`, with the CLI's own command line.
  assert.match(code, /new URL\("\.\.\/dist\/main\.js", import\.meta\.url\)/);
  assert.match(
    code,
    /main\(\["dashboard", "--json", "--listen", "127\.0\.0\.1:0"\]\)/,
  );
  assert.match(
    types,
    /export function main\(argv: readonly string\[\]\): Promise<number>;/,
  );
  // Re-spawns itself, never a `novamira-hq` or `node` found on PATH.
  assert.match(code, /new Deno\.Command\(Deno\.execPath\(\)/);
  assert.ok(!/"node"|"novamira-hq"|"npx"/.test(code));
  // No second server, no HTTP handling, no site access.
  for (const forbidden of [
    "Deno.serve",
    "Deno.listen",
    "node:http",
    "Application Password",
    "wp-json",
    "fetch(",
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `desktop shell must not use ${forbidden}`,
    );
  }
  // The window is the parent's whole lifetime: the server watches its stdin.
  assert.match(code, /stdin: "piped"/);
  assert.match(code, /Deno\.stdin\.read\(/);
  assert.match(code, /Deno\.kill\(Deno\.pid, "SIGTERM"\)/);
  // The webview library loads on import, so the server role must never import it.
  assert.ok(!/^import .*@webview\/webview/m.test(code));
  assert.match(code, /await import\("@webview\/webview"\)/);
  // The compile embeds HQ's build and skills, and nothing from node_modules.
  assert.match(denoConfig.tasks.compile, /--include \.\.\/dist /);
  assert.match(denoConfig.tasks.compile, /--include \.\.\/skills /);
  assert.ok(!denoConfig.tasks.compile.includes("node_modules"));
});

test("desktop shell is formatted and lint-clean under deno", (t) => {
  const probe = spawnSync("deno", ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) {
    t.skip("deno is not installed");
    return;
  }
  for (const args of [["fmt", "--check"], ["lint"]]) {
    const result = spawnSync("deno", args, {
      cwd: join(root, "desktop"),
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  }
});
