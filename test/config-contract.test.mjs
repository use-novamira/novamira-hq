// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { UnixFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import { createHostingClientFactory } from "../dist/hosting/factory.js";
import {
  CONFIG_FORMAT_VERSION,
  credentialSource,
  emptyConfigDocument,
  envCredential,
  parseConfigDocument,
  parseCredentialRef,
  serializeConfigDocument,
  storedCredential,
} from "../dist/config/schema.js";

// Never a real-looking secret: every credential here is a *reference*, which is
// all `config.json` is ever allowed to contain.
const STORED_ID = "a".repeat(64);

const DOCUMENT = {
  version: CONFIG_FORMAT_VERSION,
  hostingProfiles: {
    production: {
      provider: "kinsta",
      credential: envCredential("KINSTA_API_KEY"),
      companyId: "company-1234",
      apiBaseUrl: "https://api.kinsta.com/v2",
    },
    staging: {
      provider: "wpengine",
      credential: storedCredential(STORED_ID),
    },
  },
  deployPaths: {
    "staging-to-production": {
      name: "staging-to-production",
      hostingProfile: "production",
      siteId: "site-1",
      siteLabel: "Example",
      sourceEnvId: "env-staging",
      sourceEnvName: "staging",
      targetEnvId: "env-live",
      targetEnvName: "live",
      pushDb: true,
      pushFiles: true,
      searchReplace: false,
    },
  },
};

// Name maps are built with `Object.create(null)`, so a document compares equal
// to a plain literal only after the prototypes are normalised. `assertMaps`
// asserts the prototype-less shape itself; it is never dropped silently.
function assertNameMapsAreProtoless(document) {
  assert.equal(Object.getPrototypeOf(document.hostingProfiles), null);
  assert.equal(Object.getPrototypeOf(document.deployPaths), null);
}

function plainDocument(document) {
  assertNameMapsAreProtoless(document);
  return JSON.parse(JSON.stringify(document));
}

async function isolatedConfig() {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-config-"));
  const paths = platformPaths({ NOVAMIRA_HQ_HOME: root }, "linux", root);
  const security = new UnixFileSecurity();
  const locks = new ProfileLockManager(paths.stateDir, security);
  return {
    root,
    paths,
    security,
    locks,
    store: new ConfigStore(paths.configFile, locks, security),
  };
}

test("a version-1 document round-trips through serialize and parse", () => {
  const serialized = serializeConfigDocument(DOCUMENT);
  assert.ok(serialized.endsWith("\n"));
  const reparsed = parseConfigDocument(JSON.parse(serialized));
  assert.deepEqual(plainDocument(reparsed), DOCUMENT);
  // Stable ordering keeps config diffs readable.
  assert.deepEqual(Object.keys(JSON.parse(serialized)), [
    "version",
    "hostingProfiles",
    "deployPaths",
  ]);
  assert.deepEqual(Object.keys(JSON.parse(serialized).hostingProfiles), [
    "production",
    "staging",
  ]);
  assert.equal(serializeConfigDocument(reparsed), serialized);

  assert.equal(
    credentialSource(envCredential("KINSTA_API_KEY")),
    "env:KINSTA_API_KEY",
  );
  assert.equal(
    credentialSource(storedCredential(STORED_ID)),
    `stored:${STORED_ID}`,
  );
});

test("only version 1 exists and structural damage is refused", () => {
  assert.throws(
    () => parseConfigDocument({ ...DOCUMENT, version: 2 }),
    (error) => {
      assert.equal(error.code, "config_error");
      assert.match(error.message, /version 2 is not supported/);
      return true;
    },
  );
  assert.throws(() => parseConfigDocument({ ...DOCUMENT, version: "1" }), {
    code: "config_error",
  });
  assert.throws(() => parseConfigDocument([]), { code: "config_error" });
  assert.throws(
    () =>
      parseConfigDocument({
        version: 1,
        hostingProfiles: { production: { provider: "nope", credential: {} } },
      }),
    { code: "schema_validation_failed" },
  );
});

test("a credential reference never carries an inline secret", () => {
  // A hand-migrated `config.toml` stored `stored` credentials as plaintext.
  // Loading one must fail loudly rather than silently dropping or persisting it.
  assert.throws(
    () =>
      parseCredentialRef(
        { type: "stored", id: STORED_ID, value: "inline-value-placeholder" },
        "hostingProfiles.production.credential",
      ),
    (error) => {
      assert.equal(error.code, "schema_validation_failed");
      assert.match(error.message, /must not carry an inline secret/);
      assert.doesNotMatch(error.message, /inline-value-placeholder/);
      return true;
    },
  );
  assert.throws(
    () =>
      parseCredentialRef({ type: "env", name: "K", value: "x" }, "credential"),
    { code: "schema_validation_failed" },
  );
  assert.throws(() => parseCredentialRef({ type: "inline" }, "credential"), {
    code: "schema_validation_failed",
  });
  assert.deepEqual(
    parseCredentialRef({ type: "file", path: "/tmp/ref" }, "credential"),
    {
      type: "file",
      path: "/tmp/ref",
    },
  );
});

test("a stored credential id must match the store's hexadecimal grammar", () => {
  assert.deepEqual(
    parseCredentialRef({ type: "stored", id: STORED_ID }, "credential"),
    { type: "stored", id: STORED_ID },
  );
  for (const id of [
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64), // uppercase is not in the lowercase hexadecimal grammar
    "g".repeat(64),
    "g".padEnd(64, "0"),
    `${STORED_ID.slice(0, -1)} `, // trailing control-free but non-hex space
    "../../etc/passwd",
    "",
  ]) {
    assert.throws(
      () => parseCredentialRef({ type: "stored", id }, "credential"),
      (error) => {
        assert.equal(error.code, "schema_validation_failed", id);
        return true;
      },
      id,
    );
  }
});

test("a missing config file loads as an empty version-1 document", async () => {
  const state = await isolatedConfig();
  try {
    assert.deepEqual(await state.store.load(), emptyConfigDocument());
    assert.deepEqual(await state.store.listHostingProfiles(), []);
    assert.deepEqual(await state.store.listDeployPaths(), []);
    await assert.rejects(state.store.requireHostingProfile("production"), {
      code: "profile_not_found",
    });
    await assert.rejects(state.store.selectHostingProfile(undefined), {
      code: "usage_error",
    });
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("config loading fails closed before credentials resolve when storage is unsafe", async () => {
  const state = await isolatedConfig();
  try {
    await state.store.save({
      ...emptyConfigDocument(),
      hostingProfiles: {
        production: {
          ...DOCUMENT.hostingProfiles.production,
          apiBaseUrl: "https://attacker.invalid/v2",
        },
      },
    });

    for (const unsafe of ["directory", "file"]) {
      const security = {
        secureDirectory: (path) => state.security.secureDirectory(path),
        secureFile: (path) => state.security.secureFile(path),
        verifyDirectory: async (path) =>
          unsafe !== "directory" && state.security.verifyDirectory(path),
        verifyFile: async (path) =>
          unsafe !== "file" && state.security.verifyFile(path),
      };
      const store = new ConfigStore(
        state.paths.configFile,
        state.locks,
        security,
      );
      let resolutions = 0;
      const factory = createHostingClientFactory({
        store,
        registry: { kinsta: () => ({}) },
        resolver: {
          resolve: async () => {
            resolutions += 1;
            throw new Error("credential resolution must not run");
          },
        },
      });

      await assert.rejects(factory.clientFromProfile("production"), (error) => {
        assert.equal(error.code, "config_error");
        assert.match(error.message, /unsafe ownership or permissions/);
        return true;
      });
      assert.equal(resolutions, 0);
    }
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("config loading rejects symlinked files and parent directories", async () => {
  if (process.platform === "win32") return;
  const state = await isolatedConfig();
  try {
    await state.store.save(emptyConfigDocument());
    const target = join(state.root, "target.json");
    await writeFile(target, serializeConfigDocument(emptyConfigDocument()), {
      mode: 0o600,
    });
    await rm(state.paths.configFile);
    await symlink(target, state.paths.configFile);
    await assert.rejects(state.store.load(), {
      code: "config_error",
      message: /must be a regular file/,
    });

    const actualDirectory = join(state.root, "actual-config");
    const linkedDirectory = join(state.root, "linked-config");
    await mkdir(actualDirectory, { mode: 0o700 });
    await symlink(actualDirectory, linkedDirectory, "dir");
    const linkedStore = new ConfigStore(
      join(linkedDirectory, "config.json"),
      state.locks,
      state.security,
    );
    await assert.rejects(linkedStore.load(), {
      code: "config_error",
      message: /must be a regular directory/,
    });
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("Unix config loading enforces exact owner-only modes", async () => {
  if (process.platform === "win32") return;
  const state = await isolatedConfig();
  try {
    await state.store.save(emptyConfigDocument());
    await chmod(state.paths.configFile, 0o644);
    await assert.rejects(state.store.load(), { code: "config_error" });

    await chmod(state.paths.configFile, 0o600);
    await chmod(dirname(state.paths.configFile), 0o755);
    await assert.rejects(state.store.load(), { code: "config_error" });
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

// The name pattern accepts every `Object.prototype` member, so a bare
// `record[name]` lookup would hand back an inherited function and be mistaken
// for an existing entry: `requireHostingProfile("toString")` would resolve, and
// `removeHostingProfile("toString")` would report a successful removal.
test("names that collide with Object.prototype members are not found", async () => {
  const state = await isolatedConfig();
  const inherited = [
    "toString",
    "constructor",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ];
  try {
    await state.store.upsertHostingProfile(
      "production",
      DOCUMENT.hostingProfiles.production,
    );
    for (const name of inherited) {
      assert.equal(await state.store.getHostingProfile(name), undefined);
      assert.equal(await state.store.getDeployPath(name), undefined);
      await assert.rejects(state.store.requireHostingProfile(name), {
        code: "profile_not_found",
      });
      await assert.rejects(state.store.selectHostingProfile(name), {
        code: "profile_not_found",
      });
      await assert.rejects(state.store.requireDeployPath(name), {
        code: "profile_not_found",
      });
      await assert.rejects(state.store.removeHostingProfile(name), {
        code: "profile_not_found",
      });
      await assert.rejects(state.store.removeDeployPath(name), {
        code: "profile_not_found",
      });
    }
    // The real profile is still the only one on disk.
    assert.deepEqual(
      (await state.store.listHostingProfiles()).map(({ name }) => name),
      ["production"],
    );
    assertNameMapsAreProtoless(await state.store.load());
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("profiles and deploy paths round-trip through the store on owner-only files", async () => {
  const state = await isolatedConfig();
  try {
    await state.store.upsertHostingProfile(
      "production",
      DOCUMENT.hostingProfiles.production,
    );
    await state.store.upsertHostingProfile(
      "staging",
      DOCUMENT.hostingProfiles.staging,
    );
    await state.store.upsertDeployPath(
      DOCUMENT.deployPaths["staging-to-production"],
    );

    assert.deepEqual(
      (await state.store.listHostingProfiles()).map(({ name }) => name),
      ["production", "staging"],
    );
    assert.deepEqual(plainDocument(await state.store.load()), DOCUMENT);
    assert.deepEqual(
      await state.store.requireDeployPath("staging-to-production"),
      DOCUMENT.deployPaths["staging-to-production"],
    );

    const onDisk = JSON.parse(await readFile(state.paths.configFile, "utf8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.siteProfiles, undefined);
    assert.deepEqual(onDisk.hostingProfiles.staging.credential, {
      type: "stored",
      id: STORED_ID,
    });

    if (process.platform !== "win32") {
      assert.equal((await stat(state.paths.configFile)).mode & 0o777, 0o600);
      assert.equal(
        (await stat(dirname(state.paths.configFile))).mode & 0o077,
        0,
      );
    }

    assert.deepEqual(
      await state.store.removeHostingProfile("staging"),
      DOCUMENT.hostingProfiles.staging,
    );
    await assert.rejects(state.store.removeHostingProfile("staging"), {
      code: "profile_not_found",
    });
    assert.deepEqual(
      await state.store.removeDeployPath("staging-to-production"),
      DOCUMENT.deployPaths["staging-to-production"],
    );
    await assert.rejects(
      state.store.requireDeployPath("staging-to-production"),
      {
        code: "profile_not_found",
      },
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("unknown fields load and are dropped on the next save", async () => {
  const state = await isolatedConfig();
  try {
    await state.store.save(emptyConfigDocument());
    await writeFile(
      state.paths.configFile,
      `${JSON.stringify({
        version: 1,
        hostingProfiles: {
          production: {
            provider: "kinsta",
            credential: { type: "env", name: "KINSTA_API_KEY" },
            legacyField: "ignored",
          },
        },
        // Left over from a hand-migrated `config.toml`; HQ has no such concept.
        siteProfiles: { example: { siteUrl: "https://example.test" } },
      })}\n`,
      { mode: 0o600 },
    );

    const loaded = await state.store.load();
    assert.deepEqual(Object.keys(loaded), [
      "version",
      "hostingProfiles",
      "deployPaths",
    ]);
    assert.equal(loaded.hostingProfiles.production.legacyField, undefined);

    await state.store.save(loaded);
    const rewritten = JSON.parse(
      await readFile(state.paths.configFile, "utf8"),
    );
    assert.equal(rewritten.siteProfiles, undefined);
    assert.deepEqual(Object.keys(rewritten.hostingProfiles.production), [
      "provider",
      "credential",
    ]);

    await writeFile(state.paths.configFile, "{ not json", { mode: 0o600 });
    await assert.rejects(state.store.load(), { code: "config_error" });
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});
