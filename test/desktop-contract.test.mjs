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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import {
  generateIcons,
  HICOLOR_SIZES,
  ICO_SIZES,
  ICON_NAME,
} from "../scripts/desktop-icons.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const denoConfig = JSON.parse(
  await readFile(join(root, "desktop", "deno.json"), "utf8"),
);
const shell = await readFile(join(root, "desktop", "main.ts"), "utf8");
const types = await readFile(join(root, "desktop", "hq.d.ts"), "utf8");
const entry = await readFile(
  join(root, "desktop", "ai.novamira.hq.desktop.desktop"),
  "utf8",
);
const builder = await readFile(
  join(root, "scripts", "desktop-build.mjs"),
  "utf8",
);
const smoke = await readFile(
  join(root, "scripts", "desktop-smoke.mjs"),
  "utf8",
);
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
  assert.match(
    manifest.scripts["desktop:build"],
    /node scripts\/desktop-build\.mjs$/,
  );
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

test("the Windows compile embeds the icon and is otherwise the same compile", () => {
  const { compile } = denoConfig.tasks;
  const windows = denoConfig.tasks["compile:windows"];
  assert.equal(
    windows,
    compile.replace(
      "--output",
      `--icon ../dist-desktop/icons/${ICON_NAME}.ico --output`,
    ),
    "the Windows task must be the compile task plus --icon, nothing else",
  );
  // `deno compile` bakes anything after the script path into the executable as
  // its arguments, so a flag placed there is silently not a flag.
  assert.ok(
    windows.indexOf("--icon") < windows.indexOf("main.ts"),
    "--icon must precede the script path",
  );
  // Which task to run is a fact about the host — `--icon` refuses on any target
  // but Windows — and that is the decision `desktop-build.mjs` exists to make.
  assert.match(builder, /platform === "win32"\n?\s*\? "compile:windows"/);
  assert.match(builder, /generateIcons\(/);
});

test("the Linux archive carries the entry and the icons an ELF cannot", () => {
  assert.match(entry, /^\[Desktop Entry\]$/m);
  assert.match(entry, /^# SPDX-License-Identifier: AGPL-3\.0-or-later$/m);
  assert.match(entry, /^Type=Application$/m);
  assert.match(entry, /^Exec=novamira-hq-desktop$/m);
  assert.match(entry, new RegExp(`^Icon=${ICON_NAME}$`, "m"));
  assert.match(entry, /^Terminal=false$/m);
  // The window is not a terminal program, and the name the shell gives it is
  // how a Linux desktop matches the window back to this entry.
  assert.match(entry, /^StartupWMClass=novamira-hq-desktop$/m);

  assert.match(builder, /--package/);
  assert.match(builder, /novamira-hq-desktop-linux-\$\{architecture\}/);
  assert.match(builder, /"icons", "hicolor"/);
  // Reproducible, so a rerun of a release job cannot publish a different
  // archive than the one it replaces.
  for (const flag of ["--sort=name", "--owner=0", "--group=0", "--mtime=@0"]) {
    assert.ok(builder.includes(flag), `the archive must be built with ${flag}`);
  }
});

test("the smoke test holds the pipe the server's life depends on", () => {
  // A shell that backgrounds the server hands it /dev/null on stdin, which is
  // EOF, which is exactly the signal that means "the window is gone".
  assert.match(smoke, /stdio: \["pipe", "pipe", "inherit"\]/);
  assert.match(smoke, /child\.stdin\.end\(\)/);
  assert.match(smoke, /NOVAMIRA_HQ_HOME: home/);
  assert.match(smoke, /NOVAMIRA_HQ_UPDATE_CHECK: "0"/);
  assert.match(smoke, /"--serve"/);
  // Loopback only, and no provider call of any kind.
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(smoke));
});

test("the server role stops deterministically on every platform", () => {
  // Windows has no deliverable SIGTERM, and an unhandled throw in the stdin
  // watcher would be the only thing stopping the server there.
  assert.match(code, /Deno\.kill\(Deno\.pid, "SIGTERM"\)/);
  assert.match(code, /catch \{\n\s*Deno\.exit\(0\);/);
});

test("every desktop icon is derived from the one committed master", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "novamira-icons-"));
  try {
    const written = await generateIcons({
      master: join(root, "scripts", "macos", "icon.png"),
      outDir,
    });
    assert.equal(written.length, HICOLOR_SIZES.length + 1);

    for (const size of HICOLOR_SIZES) {
      const png = await readFile(
        join(outDir, "hicolor", `${size}x${size}`, "apps", `${ICON_NAME}.png`),
      );
      assert.deepEqual(readPngSize(png), { width: size, height: size });
    }

    const ico = await readFile(join(outDir, `${ICON_NAME}.ico`));
    assert.equal(ico.readUInt16LE(0), 0, "reserved");
    assert.equal(ico.readUInt16LE(2), 1, "an icon, not a cursor");
    assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
    ICO_SIZES.forEach((size, index) => {
      const at = 6 + index * 16;
      assert.equal(ico[at], size >= 256 ? 0 : size, `${size} width`);
      assert.equal(ico[at + 1], size >= 256 ? 0 : size, `${size} height`);
      assert.equal(ico.readUInt16LE(at + 6), 32, `${size} is 32bpp`);
      const length = ico.readUInt32LE(at + 8);
      const offset = ico.readUInt32LE(at + 12);
      assert.ok(offset + length <= ico.length, `${size} lies inside the file`);
      const body = ico.subarray(offset, offset + length);
      // Windows reads both; a PNG entry must still be the size it claims.
      if (body.subarray(0, 8).equals(PNG_SIGNATURE)) {
        assert.deepEqual(readPngSize(body), { width: size, height: size });
      } else {
        assert.equal(body.readUInt32LE(0), 40, `${size} DIB header`);
        assert.equal(body.readInt32LE(4), size, `${size} DIB width`);
        assert.equal(body.readInt32LE(8), size * 2, `${size} DIB height`);
      }
    });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readPngSize(png) {
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), "PNG signature");
  assert.equal(png.toString("latin1", 12, 16), "IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
