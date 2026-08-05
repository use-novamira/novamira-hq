// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG_LOCK_KEY, lockFilePath } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { CREDENTIAL_SERVICE } from "../dist/credentials/keychain-backends.js";
import { UPDATE_CHECK_FILE, UPDATE_CHECK_LOCK } from "../dist/update/index.js";

// The site CLI's namespace, hard-coded rather than imported: this test must
// keep failing if `@novamira/cli` ever moves, and HQ must never depend on it.
const SITE_CLI_KEYCHAIN_SERVICE = "ai.novamira.cli";
const SITE_CLI_PATHS = {
  linux: {
    configFile: "/home/fake/.config/novamira/config.json",
    stateDir: "/home/fake/.local/state/novamira",
    locksDir: "/home/fake/.local/state/novamira/locks",
    cacheDir: "/home/fake/.cache/novamira",
    credentialsDir: "/home/fake/.local/state/novamira/credentials",
  },
  darwin: {
    configFile: "/Users/fake/Library/Application Support/Novamira/config.json",
    stateDir: "/Users/fake/Library/Application Support/Novamira/State",
    locksDir: "/Users/fake/Library/Application Support/Novamira/State/locks",
    cacheDir: "/Users/fake/Library/Caches/Novamira",
    credentialsDir:
      "/Users/fake/Library/Application Support/Novamira/Credentials",
  },
  win32: {
    configFile: "C:\\Users\\fake\\AppData\\Roaming\\Novamira\\config.json",
    stateDir: "C:\\Users\\fake\\AppData\\Local\\Novamira\\State",
    locksDir: "C:\\Users\\fake\\AppData\\Local\\Novamira\\State\\locks",
    cacheDir: "C:\\Users\\fake\\AppData\\Local\\Novamira\\Cache",
    credentialsDir: "C:\\Users\\fake\\AppData\\Local\\Novamira\\Credentials",
  },
};

// sha256("config") — the lock file `CONFIG_LOCK_KEY` resolves to.
const CONFIG_LOCK_FILE_NAME =
  "b79606fb3afea5bd1609ed40b622142f1c98125abcfe89a76a661b0e8e343910.lock";

const HOMES = {
  linux: "/home/fake",
  darwin: "/Users/fake",
  win32: "C:\\Users\\fake",
};

const ENVIRONMENTS = {
  linux: {},
  darwin: {},
  win32: {
    APPDATA: "C:\\Users\\fake\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\fake\\AppData\\Local",
  },
};

function hqPaths(platform, extraEnvironment = {}) {
  return platformPaths(
    { ...ENVIRONMENTS[platform], ...extraEnvironment },
    platform,
    HOMES[platform],
  );
}

function separatorFor(platform) {
  return platform === "win32" ? "\\" : "/";
}

/** True when `inner` is `outer` or lives below it, separator-aware. */
function contains(outer, inner, platform) {
  const separator = separatorFor(platform);
  return inner === outer || inner.startsWith(`${outer}${separator}`);
}

test("HQ resolves an entirely separate namespace on linux, macOS and Windows", () => {
  assert.deepEqual(hqPaths("linux"), {
    configDir: "/home/fake/.config/novamira-hq",
    configFile: "/home/fake/.config/novamira-hq/config.json",
    stateDir: "/home/fake/.local/state/novamira-hq",
    locksDir: "/home/fake/.local/state/novamira-hq/locks",
    lockFile: `/home/fake/.local/state/novamira-hq/locks/${CONFIG_LOCK_FILE_NAME}`,
    cacheDir: "/home/fake/.cache/novamira-hq",
    credentialsDir: "/home/fake/.local/state/novamira-hq/credentials",
  });

  assert.deepEqual(hqPaths("darwin"), {
    configDir: "/Users/fake/Library/Application Support/Novamira HQ",
    configFile:
      "/Users/fake/Library/Application Support/Novamira HQ/config.json",
    stateDir: "/Users/fake/Library/Application Support/Novamira HQ/State",
    locksDir: "/Users/fake/Library/Application Support/Novamira HQ/State/locks",
    lockFile: `/Users/fake/Library/Application Support/Novamira HQ/State/locks/${CONFIG_LOCK_FILE_NAME}`,
    cacheDir: "/Users/fake/Library/Caches/Novamira HQ",
    credentialsDir:
      "/Users/fake/Library/Application Support/Novamira HQ/Credentials",
  });

  assert.deepEqual(hqPaths("win32"), {
    configDir: "C:\\Users\\fake\\AppData\\Roaming\\Novamira HQ",
    configFile: "C:\\Users\\fake\\AppData\\Roaming\\Novamira HQ\\config.json",
    stateDir: "C:\\Users\\fake\\AppData\\Local\\Novamira HQ\\State",
    locksDir: "C:\\Users\\fake\\AppData\\Local\\Novamira HQ\\State\\locks",
    lockFile: `C:\\Users\\fake\\AppData\\Local\\Novamira HQ\\State\\locks\\${CONFIG_LOCK_FILE_NAME}`,
    cacheDir: "C:\\Users\\fake\\AppData\\Local\\Novamira HQ\\Cache",
    credentialsDir: "C:\\Users\\fake\\AppData\\Local\\Novamira HQ\\Credentials",
  });

  // Windows resolution is pure: `path.win32` is used regardless of the host, so
  // the Windows namespace is provable from Linux CI.
  assert.deepEqual(
    platformPaths({}, "win32", "C:\\Users\\fake").configFile,
    "C:\\Users\\fake\\AppData\\Roaming\\Novamira HQ\\config.json",
  );
});

test("no HQ path or keychain service collides with the site CLI's", () => {
  assert.equal(CREDENTIAL_SERVICE, "ai.novamira.hq");
  assert.notEqual(CREDENTIAL_SERVICE, SITE_CLI_KEYCHAIN_SERVICE);

  for (const platform of ["linux", "darwin", "win32"]) {
    const hq = hqPaths(platform);
    const site = SITE_CLI_PATHS[platform];
    const hqValues = Object.values(hq);
    const siteValues = Object.values(site);

    for (const hqPath of hqValues) {
      for (const sitePath of siteValues) {
        assert.notEqual(
          hqPath,
          sitePath,
          `${platform}: ${hqPath} collides with the site CLI`,
        );
        // A distinct string is not enough: neither tree may nest inside the
        // other, or HQ's writes would land inside the site CLI's directories.
        assert.equal(
          contains(sitePath, hqPath, platform),
          false,
          `${platform}: ${hqPath} lives below the site CLI's ${sitePath}`,
        );
        assert.equal(
          contains(hqPath, sitePath, platform),
          false,
          `${platform}: the site CLI's ${sitePath} lives below ${hqPath}`,
        );
      }
    }

    // Every HQ path is namespaced, and the site CLI's plain `novamira`
    // directory name never appears as a path segment of an HQ path.
    const separator = separatorFor(platform);
    for (const hqPath of hqValues) {
      const segments = hqPath.split(separator);
      assert.equal(segments.includes("novamira"), false, hqPath);
      assert.equal(segments.includes("Novamira"), false, hqPath);
      assert.ok(
        segments.includes("novamira-hq") || segments.includes("Novamira HQ"),
        hqPath,
      );
    }
  }
});

test("NOVAMIRA_HOME is ignored while the HQ overrides are honoured", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    assert.deepEqual(
      hqPaths(platform, { NOVAMIRA_HOME: "/site/cli/root" }),
      hqPaths(platform),
      `${platform}: NOVAMIRA_HOME must not move HQ's paths`,
    );
  }

  const rooted = hqPaths("linux", { NOVAMIRA_HQ_HOME: "/hq/root" });
  assert.deepEqual(rooted, {
    configDir: "/hq/root",
    configFile: "/hq/root/config.json",
    stateDir: "/hq/root/state",
    locksDir: "/hq/root/state/locks",
    lockFile: `/hq/root/state/locks/${CONFIG_LOCK_FILE_NAME}`,
    cacheDir: "/hq/root/cache",
    credentialsDir: "/hq/root/credentials",
  });

  // An explicit config override relocates only `config.json`.
  const overridden = hqPaths("linux", {
    NOVAMIRA_HQ_CONFIG: "/etc/hq/custom.json",
  });
  assert.equal(overridden.configFile, "/etc/hq/custom.json");
  assert.equal(overridden.configDir, "/etc/hq");
  assert.equal(overridden.stateDir, hqPaths("linux").stateDir);
  assert.equal(overridden.cacheDir, hqPaths("linux").cacheDir);
  assert.equal(overridden.credentialsDir, hqPaths("linux").credentialsDir);

  // Empty values are treated as unset rather than producing relative paths.
  assert.deepEqual(
    hqPaths("linux", { NOVAMIRA_HQ_HOME: "", NOVAMIRA_HQ_CONFIG: "" }),
    hqPaths("linux"),
  );
});

test("the config lock file is the one ProfileLockManager writes", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const hq = hqPaths(platform);
    assert.ok(contains(hq.stateDir, hq.locksDir, platform));
    assert.ok(contains(hq.locksDir, hq.lockFile, platform));
    if (platform !== "win32") {
      assert.equal(hq.lockFile, lockFilePath(hq.stateDir, CONFIG_LOCK_KEY));
    }
  }
  assert.equal(CONFIG_LOCK_KEY, "config");
});

test("the update-check record resolves under HQ's namespace on every platform", () => {
  const separator = (platform) => (platform === "win32" ? "\\" : "/");
  for (const platform of ["linux", "darwin", "win32"]) {
    const hq = hqPaths(platform);
    const record = `${hq.stateDir}${separator(platform)}${UPDATE_CHECK_FILE}`;
    // The file name is appended to the resolved `stateDir` and nowhere else: no
    // namespace segment is ever joined by hand.
    assert.ok(contains(hq.stateDir, record, platform));
    // It never lands in the site CLI's tree, whatever the platform.
    assert.ok(
      !contains(SITE_CLI_PATHS[platform].stateDir, record, platform),
      platform,
    );
  }

  // `NOVAMIRA_HQ_HOME` relocates it; `NOVAMIRA_HOME` does not, and never will.
  const isolated = hqPaths("linux", {
    NOVAMIRA_HQ_HOME: "/tmp/hq-root",
    NOVAMIRA_HOME: "/tmp/site-root",
  });
  assert.equal(isolated.stateDir, "/tmp/hq-root/state");
  assert.equal(
    `${isolated.stateDir}/${UPDATE_CHECK_FILE}`,
    "/tmp/hq-root/state/update-check.json",
  );

  const siteOnly = hqPaths("linux", { NOVAMIRA_HOME: "/tmp/site-root" });
  assert.deepEqual(siteOnly, hqPaths("linux"));

  assert.equal(UPDATE_CHECK_FILE, "update-check.json");
  // The lock key is double-underscored, so no legal profile name can collide.
  assert.equal(UPDATE_CHECK_LOCK, "__update_check__");
});
