// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MacOsKeychainBackend } from "../dist/credentials/keychain-backends.js";
import { createCredentialStore } from "../dist/credentials/store.js";
import { UnixFileSecurity } from "../dist/config/file-security.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = await readFile(
  join(root, "native/macos/keychain.swift"),
  "utf8",
);
const account = "c".repeat(64);

test("OS vault failure never switches to plaintext storage on any platform", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hq-no-fallback-"));
  try {
    for (const platform of ["darwin", "linux", "win32"]) {
      for (const result of [
        { code: 1, signal: null, truncated: false, stdout: "" },
        { code: null, signal: "SIGTERM", truncated: false, stdout: "" },
      ]) {
        await assert.rejects(
          createCredentialStore(folder, new UnixFileSecurity(), {
            platform,
            executor: { execute: async () => result },
          }),
          { code: "integration_unavailable" },
        );
      }
    }
    assert.deepEqual(await readdir(folder), []);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("macOS validates requests and handles denial/missing helper without leaking output", async () => {
  const calls = [];
  const backend = new MacOsKeychainBackend(
    {
      execute: async (...args) => {
        calls.push(args);
        return {
          code: 77,
          signal: null,
          truncated: false,
          stdout: "private child output",
        };
      },
    },
    "/fixed/helper",
  );
  await assert.rejects(backend.read("--other-service"), {
    code: "usage_error",
  });
  await assert.rejects(backend.read(account + "\n"), { code: "usage_error" });
  await assert.rejects(backend.replace(account, "x".repeat(524289)), {
    code: "usage_error",
  });
  assert.equal(calls.length, 0);
  for (const action of ["read", "delete"]) {
    await assert.rejects(backend[action](account), (error) => {
      assert.equal(error.code, "integration_unavailable");
      assert.match(error.message, /not authorized/);
      assert.doesNotMatch(error.message, /private child/);
      return true;
    });
  }
  const absent = new MacOsKeychainBackend({
    execute: async () => {
      throw new Error("sensitive path");
    },
  });
  await assert.rejects(absent.read(account), (error) => {
    assert.match(error.message, /helper is missing/);
    assert.doesNotMatch(error.message, /sensitive path/);
    return true;
  });
});

test("native helper pins namespace, signed caller identity and one-operation consent", () => {
  assert.match(source, /let service = "ai\.novamira\.hq"/);
  assert.match(source, /"native-v1\/" \+ arguments\[1\]/);
  assert.match(source, /SecCodeCopyGuestWithAttributes/);
  assert.match(source, /SecCodeCheckValidity/);
  assert.match(source, /certificate leaf\[subject\.OU\]/);
  assert.match(source, /ai\.novamira\.hq\.desktop/);
  assert.match(source, /alert\.addButton\(withTitle: "Deny"\)/);
  assert.match(source, /alert\.addButton\(withTitle: "Allow once"\)/);
  assert.doesNotMatch(
    source,
    /Always Allow|ProcessInfo\.processInfo\.environment|osascript-owned records\s*\n.*SecItemCopy/,
  );
  assert.ok(
    source.indexOf("guard authorize(operation)") <
      source.indexOf("SecItemCopyMatching(query"),
  );
  assert.match(source, /input\.count > maximumInput/);
  assert.match(source, /!verifiedCaller \|\| trustedParent\(\)/);
});

test(
  "compiled native protocol probe and malformed requests never touch Keychain",
  {
    skip: process.platform !== "darwin",
  },
  (t) => {
    const binary = join(
      root,
      "native/macos/Novamira HQ Credentials.app/Contents/MacOS/novamira-hq-keychain",
    );
    // Source checkouts can run TypeScript tests before explicitly building Swift.
    // The signing workflow additionally requires and exercises this binary.
    if (!existsSync(binary)) {
      t.skip("Build the native helper with bun run keychain:build on macOS.");
      return;
    }
    const probe = spawnSync(binary, ["probe"], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), { protocol: 1 });
    for (const args of [
      ["read", "invalid"],
      ["delete", "--service"],
      ["dump"],
      ["probe", "extra"],
    ]) {
      const result = spawnSync(binary, args, {
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(result.status, 64);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
    const oversized = spawnSync(binary, ["write", account], {
      input: "x".repeat(524289),
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(oversized.status, 64);
    assert.equal(oversized.stdout, "");
  },
);

test("signed helper ships to desktop and npm without granting it JIT exceptions", async () => {
  const signer = await readFile(join(root, "scripts/macos-sign.sh"), "utf8");
  const release = await readFile(
    join(root, ".github/workflows/release.yml"),
    "utf8",
  );
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.ok(
    manifest.files.includes("native/macos/Novamira HQ Credentials.app"),
  );
  assert.match(signer, /--identifier ai\.novamira\.hq\.credentials/);
  assert.match(signer, /Contents\/Helpers\/Novamira HQ Credentials\.app/);
  assert.match(signer, /stapler staple "\$helper"/);
  assert.match(release, /needs: \[prepare, acceptance, desktop-macos\]/);
  assert.match(release, /keychain\.zip -d native\/macos/);
});
