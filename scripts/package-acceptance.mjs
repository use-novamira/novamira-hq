#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pack the tarball, install it into a throwaway prefix, and prove that what
 * lands on a user's machine works.
 *
 * `bun run pack:inspect` answers "what is in the tarball?". This answers the
 * harder question — "does the installed thing run?" — which is the one that
 * catches a missing `skills/` directory, a `dist/web/static/` copy step that
 * did not run, a lost shebang, a non-executable `dist/index.js`, or a
 * `dependencies` entry that quietly grew a third package. Every one of those
 * passes `tsc`, passes the contract tests, and breaks the first install.
 *
 * **Everything here is offline.** The only network is npm's own fetch of the
 * tarball's declared dependencies into the throwaway prefix. The installed CLI
 * is exercised with `--version`, `skills list`, `skills get hosting` and
 * `doctor --offline` — no provider credential, no provider API call, no
 * registry read. `NOVAMIRA_HQ_UPDATE_CHECK=0` and a per-run `NOVAMIRA_HQ_HOME`
 * belt-and-brace it: no invocation writes into the runner's real home and none
 * consults a package registry.
 *
 * `doctor --offline` is the load-bearing assertion. It must exit **0** on a
 * machine with no hosting profiles and no site CLI, where `profile.credentials`
 * and `integration.site_cli` both warn — which is exactly the state a fresh
 * install is in, and exactly what `install.sh`'s smoke test depends on.
 *
 * With `--package=@novamira/hq@<version>` it verifies a published version
 * instead of the working tree, which is what the release workflow runs after
 * `npm publish`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { verifySiteCli } from "./site-cli-acceptance.mjs";
import { fileURLToPath, URL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "novamira-hq-package-"));
const packageArgument = process.argv.find((value) =>
  value.startsWith("--package="),
);
const packageSpec = packageArgument?.slice("--package=".length);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const cleanEnvironment = {
  ...process.env,
  // No background registry read, and no write into the runner's real home.
  NOVAMIRA_HQ_UPDATE_CHECK: "0",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_ignore_scripts: "true",
  npm_config_min_release_age: "0",
  // `npm pack` loads an Arborist tree of the directory it runs in, and writes a
  // `package-lock.json` beside `package.json` when none exists. This repository
  // locks with `bun.lock`; an npm lockfile appearing in the working tree after
  // an acceptance run is an artifact nobody asked for and one `git add .` away
  // from being committed as a second, conflicting source of truth.
  npm_config_package_lock: "false",
};

/** Browser assets plus the offline generated legal notices. */
const STATIC_ASSETS = [
  "third-party-notices.txt",
  "app.css",
  "datastar.js",
  "relative-time.js",
  "sites-filter.js",
  "novamira-hq-logo-white.svg",
  "fonts/montserrat-var.woff2",
  "fonts/montserrat-OFL.txt",
  "fonts/jetbrains-mono-var.woff2",
  "fonts/jetbrains-mono-OFL.txt",
];

try {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );

  const packArguments = ["pack"];
  if (packageSpec !== undefined) packArguments.push(packageSpec);
  packArguments.push(
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temporary,
  );
  const packed = run(npm, packArguments, root);
  // npm 11 reports an array of manifests; npm 12 reports an object keyed by
  // package name.
  const packResult = JSON.parse(packed.stdout);
  const [manifest] = Array.isArray(packResult)
    ? packResult
    : Object.values(packResult);
  assert.equal(manifest.name, "@novamira/hq");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.bundled.length, 0);

  /* ---------------------------------------------------------------------- */
  /* The manifest: identity, dependencies, lifecycle scripts                 */
  /* ---------------------------------------------------------------------- */

  assert.equal(packageJson.license, "AGPL-3.0-or-later");
  assert.equal(packageJson.author, "Ovation S.r.l.");
  assert.equal(packageJson.engines.node, ">=22");
  assert.deepEqual(packageJson.bin, { "novamira-hq": "dist/index.js" });
  // The managed site CLI is pinned exactly; all other runtime imports are builtins.
  assert.deepEqual(packageJson.dependencies, {
    "@novamira/cli": "1.3.1",
    "@starfederation/datastar-sdk": "^1.0.0",
    commander: "^14.0.0",
  });
  assert.equal(packageJson.publishConfig.access, "public");
  assert.equal(packageJson.publishConfig.provenance, true);
  // No lifecycle script: the documented install line is
  // `npm install -g @novamira/hq --ignore-scripts`, and it must be able to be.
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"])
    assert.equal(packageJson.scripts[lifecycle], undefined);
  // The installers are consumed from the repository and the release assets, not
  // from inside the package they install.
  assert.deepEqual(packageJson.files, [
    "dist",
    "skills",
    "legal",
    "license-docs",
    "native/macos/Novamira HQ Credentials.app",
    "README.md",
    "LICENSE",
  ]);

  /* ---------------------------------------------------------------------- */
  /* The tarball: nothing extra, nothing missing                             */
  /* ---------------------------------------------------------------------- */

  const allowedRoots = new Set([
    "LICENSE",
    "README.md",
    "dist",
    "package.json",
    "skills",
    "legal",
    "license-docs",
    "native",
  ]);
  for (const file of manifest.files)
    assert.ok(
      allowedRoots.has(file.path.split("/")[0]),
      `unexpected package file: ${file.path}`,
    );
  const required = [
    "license-docs/build-from-source.md",
    "legal/manifest.json",
    "legal/AUDIT.md",
    "legal/licenses/datastar.txt",
    "legal/licenses/commander.txt",
    "legal/licenses/mpl-2.0.txt",
    "LICENSE",
    "README.md",
    "dist/index.js",
    "dist/mcp/icon.png",
    "dist/mcp/LICENSE",
    "skills/novamira-hq/SKILL.md",
    "skills/core/SKILL.md",
    "skills/hosting/SKILL.md",
    ...STATIC_ASSETS.map((asset) => `dist/web/static/${asset}`),
  ];
  for (const file of manifest.files.filter((file) =>
    file.path.startsWith("native/"),
  )) {
    assert.ok(
      file.path.startsWith("native/macos/Novamira HQ Credentials.app/"),
      "only the built helper belongs in npm",
    );
  }
  if (process.env.NOVAMIRA_HQ_REQUIRE_SIGNED_HELPER === "1") {
    for (const path of [
      "Contents/MacOS/novamira-hq-keychain",
      "Contents/Info.plist",
      "Contents/_CodeSignature/CodeResources",
    ]) {
      assert.ok(
        manifest.files.some(
          (file) =>
            file.path === `native/macos/Novamira HQ Credentials.app/${path}`,
        ),
        `missing signed helper ${path}`,
      );
    }
  }
  for (const path of required)
    assert.ok(
      manifest.files.some((file) => file.path === path),
      `missing ${path}`,
    );

  // Windows has no execute bit to record, so a tarball packed there never
  // carries one. Released tarballs are packed on Linux, where this holds.
  if (process.platform !== "win32") {
    const executable = manifest.files.find(
      (file) => file.path === "dist/index.js",
    );
    assert.ok(
      (executable.mode & 0o111) !== 0,
      "dist/index.js is not executable",
    );
  }
  assert.ok(
    (await readFile(join(root, "dist/index.js"), "utf8")).startsWith(
      "#!/usr/bin/env node\n",
    ),
  );

  /* ---------------------------------------------------------------------- */
  /* The installed CLI                                                       */
  /* ---------------------------------------------------------------------- */

  const tarball = join(temporary, basename(manifest.filename));
  await writeFile(join(temporary, "package.json"), '{"private":true}\n');

  const globalRoot = join(temporary, "global");
  run(
    npm,
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--prefix",
      globalRoot,
      tarball,
    ],
    temporary,
  );
  const globalBin =
    process.platform === "win32"
      ? join(globalRoot, "novamira-hq.cmd")
      : join(globalRoot, "bin", "novamira-hq");
  const home = join(temporary, "hq-home");
  const installedEntry = join(
    globalRoot,
    ...(process.platform === "win32" ? [] : ["lib"]),
    "node_modules",
    "@novamira",
    "hq",
    "dist",
    "index.js",
  );
  const siteEnvironment = {
    PATH: "",
    NOVAMIRA_HQ_HOME: home,
    NOVAMIRA_HOME: join(temporary, "site-home"),
    NOVAMIRA_HQ_SITE_CLI: "",
  };
  await verifySiteCli(
    process.execPath,
    [installedEntry, "site-cli"],
    temporary,
    packageJson.dependencies["@novamira/cli"],
    "node",
  );
  assert.equal(
    run(
      process.execPath,
      [installedEntry, "site-cli", "--version"],
      temporary,
      siteEnvironment,
    ).stdout.trim(),
    packageJson.dependencies["@novamira/cli"],
  );
  const guide = JSON.parse(
    run(
      process.execPath,
      [installedEntry, "site-cli", "guide", "get", "core", "--full", "--json"],
      temporary,
      siteEnvironment,
    ).stdout,
  );
  assert.equal(guide.ok, true);
  assert.ok(guide.data.references.length > 0);

  assert.match(
    run(globalBin, ["--help"], temporary).stdout,
    /Usage: novamira-hq/,
  );
  assert.equal(
    run(globalBin, ["--version"], temporary).stdout.trim(),
    manifest.version,
  );

  // The bundled skills, read out of the installed tree rather than the repo.
  const skills = JSON.parse(
    run(globalBin, ["--json", "skills", "list"], temporary, {
      NOVAMIRA_HQ_HOME: home,
    }).stdout,
  );
  assert.equal(skills.ok, true);
  assert.deepEqual(
    skills.data.skills.map((skill) => skill.name),
    ["core", "hosting"],
  );
  const hosting = JSON.parse(
    run(globalBin, ["--json", "skills", "get", "hosting"], temporary, {
      NOVAMIRA_HQ_HOME: home,
    }).stdout,
  );
  assert.equal(hosting.ok, true);
  assert.ok(hosting.data.content.length > 0, "the hosting skill is empty");
  // The handoff sentence is the one thing this bundle must not lose.
  assert.match(hosting.data.content, /novamira-hq site-cli auth login/);

  // The installers' smoke test, and the reason a `warn` report exits 0.
  const doctor = JSON.parse(
    run(globalBin, ["--json", "doctor", "--offline"], temporary, {
      NOVAMIRA_HQ_HOME: home,
    }).stdout,
  );
  assert.equal(doctor.ok, true);
  assert.equal(doctor.data.version, 1);
  assert.equal(doctor.data.offline, true);
  assert.ok(
    !doctor.data.checks.some((check) => check.id === "update.available"),
    "--offline must not run the registry check",
  );

  const npxResult = run(
    npm,
    [
      "exec",
      "--yes",
      "--ignore-scripts",
      `--package=${tarball}`,
      "--",
      "novamira-hq",
      "--version",
    ],
    temporary,
  );
  assert.equal(npxResult.stdout.trim(), manifest.version);

  process.stdout.write(
    `${JSON.stringify({ ok: true, package: manifest.name, version: manifest.version, integrity: manifest.integrity, files: manifest.entryCount })}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

// Node refuses to spawn a .cmd shim without a shell, so Windows needs one. With
// a shell it passes the arguments verbatim, which makes quoting ours to do.
function quote(argument) {
  return /[\s"&()<>^|]/.test(argument)
    ? `"${argument.replaceAll('"', '""')}"`
    : argument;
}

function run(command, args, cwd, environment = {}) {
  const shell = process.platform === "win32";
  const result = spawnSync(
    shell ? quote(command) : command,
    shell ? args.map(quote) : args,
    {
      cwd,
      encoding: "utf8",
      shell,
      env: { ...cleanEnvironment, ...environment },
    },
  );
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nerror: ${result.error?.message ?? "none"}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result;
}
