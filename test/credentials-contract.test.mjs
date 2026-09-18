// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import { UnixFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager, lockFilePath } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore, hostingProfileLockKey } from "../dist/config/profiles.js";
import {
  envCredential,
  fileCredential,
  storedCredential,
} from "../dist/config/schema.js";
import {
  CREDENTIAL_SERVICE,
  LinuxSecretServiceBackend,
  MacOsKeychainBackend,
  MACOS_KEYCHAIN_TIMEOUT_MS,
  SpawnCommandExecutor,
} from "../dist/credentials/keychain-backends.js";
import {
  MAX_SECRET_BYTES,
  SECRET_PLACEHOLDER,
  readSecretFromStdin,
  resolveCredential,
} from "../dist/credentials/resolve.js";
import {
  createCredentialStore,
  credentialId,
  isCredentialId,
  withCredentialTransaction,
  withLockedCredentialTransaction,
} from "../dist/credentials/store.js";
import { redact } from "../dist/output/redact.js";

// Deliberately not a plausible provider key: nothing in this file may look like
// a secret that could be mistaken for a real one if it ever leaked into a log.
const PLACEHOLDER = "placeholder-not-a-secret";
const REPLACEMENT = "placeholder-not-a-secret-2";
const TARGET = { provider: "kinsta", profile: "production" };

async function isolatedCredentials() {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-credentials-"));
  const paths = platformPaths({ NOVAMIRA_HQ_HOME: root }, "linux", root);
  const security = new UnixFileSecurity();
  // `preference: "file"` keeps the real OS keychain out of the test run.
  const store = await createCredentialStore(paths.credentialsDir, security, {
    preference: "file",
    onWarning: () => undefined,
  });
  return { root, paths, security, store };
}

test("credential ids are deterministic, opaque, and keyed by provider, profile and field", () => {
  const id = credentialId(TARGET);
  assert.equal(id, credentialId({ ...TARGET, field: "apiKey" }));
  assert.ok(isCredentialId(id));
  assert.equal(
    new Set(
      [
        TARGET,
        { ...TARGET, profile: "staging" },
        { ...TARGET, provider: "wpengine" },
        { ...TARGET, field: "clientId" },
      ].map(credentialId),
    ).size,
    4,
  );
  assert.equal(isCredentialId("../../etc/passwd"), false);
  assert.equal(CREDENTIAL_SERVICE, "ai.novamira.hq");
});

test("env references resolve and fail with credential_missing when unset", async () => {
  const secret = await resolveCredential(envCredential("HQ_TEST_API_KEY"), {
    env: { HQ_TEST_API_KEY: PLACEHOLDER },
  });
  assert.equal(secret.reveal(), PLACEHOLDER);
  assert.equal(secret.source, "env");
  assert.equal(secret.description, "env:HQ_TEST_API_KEY");

  await assert.rejects(
    resolveCredential(envCredential("HQ_TEST_API_KEY"), { env: {} }),
    (error) => {
      assert.equal(error.code, "credential_missing");
      assert.match(error.message, /HQ_TEST_API_KEY/);
      return true;
    },
  );
  await assert.rejects(
    resolveCredential(envCredential("HQ_TEST_API_KEY"), {
      env: { HQ_TEST_API_KEY: "   " },
    }),
    { code: "credential_missing" },
  );
});

test("file references must be owner-only and fail closed otherwise", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX modes are asserted on Unix only");
    return;
  }
  const state = await isolatedCredentials();
  try {
    const path = join(state.root, "provider.key");
    await writeFile(path, `${PLACEHOLDER}\n`, { mode: 0o600 });
    const secret = await resolveCredential(fileCredential(path), {});
    // A trailing newline from `echo` is not part of the secret.
    assert.equal(secret.reveal(), PLACEHOLDER);
    assert.equal(secret.description, `file:${path}`);

    await chmod(path, 0o400);
    assert.equal(
      (await resolveCredential(fileCredential(path), {})).reveal(),
      PLACEHOLDER,
    );

    for (const mode of [0o640, 0o604, 0o644, 0o666]) {
      await chmod(path, mode);
      await assert.rejects(
        resolveCredential(fileCredential(path), {}),
        (error) => {
          assert.equal(error.code, "credential_invalid");
          assert.match(error.message, /not owner-only/);
          assert.doesNotMatch(JSON.stringify(error.message), /placeholder/);
          return true;
        },
        `mode 0${mode.toString(8)} must be refused`,
      );
    }

    await chmod(path, 0o600);
    await writeFile(path, "", { mode: 0o600 });
    await assert.rejects(resolveCredential(fileCredential(path), {}), {
      code: "credential_missing",
    });

    await assert.rejects(
      resolveCredential(fileCredential(join(state.root, "absent.key")), {}),
      { code: "credential_missing" },
    );
    await assert.rejects(resolveCredential(fileCredential(state.root), {}), {
      code: "credential_invalid",
    });
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("stored references resolve through the owner-only file fallback", async () => {
  const state = await isolatedCredentials();
  const id = credentialId(TARGET);
  try {
    assert.equal(await state.store.read(id), undefined);
    await assert.rejects(state.store.require(id), {
      code: "credential_missing",
    });
    await assert.rejects(
      resolveCredential(storedCredential(id), { store: state.store }),
      { code: "credential_missing" },
    );
    // No store injected: a stored reference must never silently resolve.
    await assert.rejects(resolveCredential(storedCredential(id), {}), {
      code: "internal_error",
    });

    await state.store.replace(id, PLACEHOLDER);
    const secret = await resolveCredential(storedCredential(id), {
      store: state.store,
    });
    assert.equal(secret.reveal(), PLACEHOLDER);
    assert.equal(secret.source, "stored");
    assert.equal(state.store.diagnostic().osBackedEncryption, false);

    if (process.platform !== "win32") {
      const file = join(state.paths.credentialsDir, "v1", `${id}.json`);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal(
        (await stat(join(state.paths.credentialsDir, "v1"))).mode & 0o777,
        0o700,
      );
    }

    await state.store.delete(id);
    assert.equal(await state.store.read(id), undefined);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a failed config save rolls the credential write back", async () => {
  const state = await isolatedCredentials();
  const id = credentialId(TARGET);
  try {
    await state.store.replace(id, PLACEHOLDER);
    const failure = new Error("config save failed");
    await assert.rejects(
      withCredentialTransaction(state.store, async (transaction) => {
        await transaction.replace(id, REPLACEMENT);
        throw failure;
      }),
      (error) => {
        assert.equal(error, failure);
        return true;
      },
    );
    assert.equal((await state.store.require(id)).reveal(), PLACEHOLDER);

    await withCredentialTransaction(state.store, async (transaction) => {
      await transaction.replace(id, REPLACEMENT);
    });
    assert.equal((await state.store.require(id)).reveal(), REPLACEMENT);

    await assert.rejects(
      withCredentialTransaction(state.store, async (transaction) => {
        await transaction.delete(id);
        throw failure;
      }),
    );
    assert.equal((await state.store.require(id)).reveal(), REPLACEMENT);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a rollback never deletes a record whose prior state could not be read", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX modes are asserted on Unix only");
    return;
  }
  const state = await isolatedCredentials();
  const id = credentialId(TARGET);
  try {
    await state.store.replace(id, PLACEHOLDER);
    // A restored backup, an over-broad `chmod -R`, or an interrupted write:
    // the pre-mutation read now fails closed instead of reporting an absence.
    await chmod(join(state.paths.credentialsDir, "v1"), 0o755);
    await assert.rejects(state.store.read(id), { code: "credential_invalid" });

    const failure = new Error("config save failed");
    let reported;
    await assert.rejects(
      withCredentialTransaction(
        state.store,
        async (transaction) => {
          await transaction.replace(id, REPLACEMENT);
          throw failure;
        },
        {
          onRollbackFailure: (result) => {
            reported = result;
          },
        },
      ),
      (error) => {
        assert.equal(error, failure);
        return true;
      },
    );

    // "Could not read the prior record" must never be rolled back as "nothing
    // was there": deleting here destroys both the original and its replacement.
    assert.equal(reported.restored, 0);
    assert.equal(reported.failures.length, 1);
    assert.equal(reported.failures[0].id, id);
    assert.equal(reported.failures[0].error.code, "credential_invalid");
    assert.equal((await state.store.require(id)).reveal(), REPLACEMENT);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a corrupt prior record is restored verbatim rather than deleted", async () => {
  const state = await isolatedCredentials();
  const id = credentialId(TARGET);
  try {
    await state.store.replace(id, PLACEHOLDER);
    const file = join(state.paths.credentialsDir, "v1", `${id}.json`);
    await writeFile(file, "{not json", { mode: 0o600 });
    await assert.rejects(state.store.read(id), { code: "credential_invalid" });

    const failure = new Error("config save failed");
    await assert.rejects(
      withCredentialTransaction(state.store, async (transaction) => {
        await transaction.replace(id, REPLACEMENT);
        throw failure;
      }),
    );
    assert.equal((await readFile(file, "utf8")).trim(), "{not json");
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a killed keychain command is an integration failure, never a missing credential", async () => {
  const account = "b".repeat(64);
  const fixed = (result) => ({ execute: async () => result });

  // `secret-tool lookup` exits 1 for "no such secret", and a child killed by
  // the executor's timeout used to be reported as exit 1 too — so a locked
  // keyring read as an absence, and a later rollback would delete a credential
  // that exists.
  assert.equal(
    await new LinuxSecretServiceBackend(
      fixed({ code: 1, signal: null, truncated: false, stdout: "" }),
    ).read(account),
    undefined,
  );
  for (const killed of [
    { code: null, signal: "SIGTERM", truncated: false, stdout: "" },
    { code: 1, signal: "SIGTERM", truncated: false, stdout: "" },
    { code: 0, signal: null, truncated: true, stdout: "x" },
  ]) {
    await assert.rejects(
      new LinuxSecretServiceBackend(fixed(killed)).read(account),
      { code: "integration_unavailable" },
    );
    await assert.rejects(
      new MacOsKeychainBackend(fixed(killed)).read(account),
      { code: "integration_unavailable" },
    );
    // A killed probe means "unusable backend", never "usable".
    assert.equal(
      await new LinuxSecretServiceBackend(fixed(killed)).probe(),
      false,
    );
  }
  assert.equal(
    await new MacOsKeychainBackend(
      fixed({ code: 0, signal: null, truncated: false, stdout: "null\n" }),
    ).read(account),
    undefined,
  );
});

test("macOS keychain replacement sends the secret only through stdin", async () => {
  const calls = [];
  const executor = {
    async execute(command, args, stdin, environment) {
      calls.push({ command, args, stdin, environment });
      return { code: 0, signal: null, truncated: false, stdout: "" };
    },
  };
  const account = "c".repeat(64);
  const serialized = `${PLACEHOLDER}\nwith unicode \u00e0 and ${"x".repeat(512)}`;

  await new MacOsKeychainBackend(executor).replace(account, serialized);

  assert.equal(calls.length, 1);
  assert.ok(calls[0].command.endsWith("/Contents/MacOS/novamira-hq-keychain"));
  assert.deepEqual(calls[0].args, ["write", account]);
  assert.equal(calls[0].stdin, serialized);
  assert.equal(calls[0].environment, undefined);
  assert.equal(
    calls[0].args.some((arg) => arg.includes(serialized)),
    false,
  );
  assert.equal(
    calls[0].args.some((arg) =>
      arg.includes(Buffer.from(serialized, "utf8").toString("hex")),
    ),
    false,
  );
});

test("macOS uses one dedicated helper and never treats a failed read as absence", async () => {
  const calls = [];
  let response = {
    code: 0,
    signal: null,
    truncated: false,
    stdout: JSON.stringify(PLACEHOLDER + "\n"),
  };
  const backend = new MacOsKeychainBackend({
    async execute(command, args) {
      calls.push({ command, args });
      return response;
    },
  });
  const account = "d".repeat(64);
  assert.equal(await backend.read(account), PLACEHOLDER + "\n");
  await backend.replace(account, PLACEHOLDER);
  await backend.delete(account);
  assert.ok(
    calls.every((call) =>
      call.command.endsWith("/Contents/MacOS/novamira-hq-keychain"),
    ),
  );
  assert.equal(calls[0].args[0], "read");
  assert.equal(calls[2].args[0], "delete");
  response = { ...response, code: 1, stdout: "null" };
  await assert.rejects(backend.read(account), {
    code: "integration_unavailable",
  });
  response = { ...response, code: 0, stdout: "invalid sensitive output" };
  await assert.rejects(backend.read(account), (error) => {
    assert.equal(error.code, "integration_unavailable");
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});

test("macOS keychain requests are serialized and recover after a failure", async () => {
  assert.equal(MACOS_KEYCHAIN_TIMEOUT_MS, 120_000);
  const started = [];
  let release;
  const backend = new MacOsKeychainBackend({
    async execute(_command, args) {
      started.push(args);
      if (started.length === 1) {
        await new Promise((resolve) => {
          release = resolve;
        });
        throw new Error("synthetic denial");
      }
      return { code: 0, signal: null, truncated: false, stdout: "null\n" };
    },
  });
  const first = backend.read("a".repeat(64));
  const rejected = assert.rejects(first, { code: "integration_unavailable" });
  const second = backend.read("b".repeat(64));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 1);
  release();
  await rejected;
  assert.equal(await second, undefined);
  assert.equal(started.length, 2);
});

test("the spawning executor reports a killed child distinguishably", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signals are asserted on Unix only");
    return;
  }
  const result = await new SpawnCommandExecutor(150).execute("sleep", ["5"]);
  assert.equal(result.code, null);
  assert.notEqual(result.signal, null);
  assert.equal(result.stdout, "");

  const clean = await new SpawnCommandExecutor(5_000).execute("true", []);
  assert.equal(clean.code, 0);
  assert.equal(clean.signal, null);
  assert.equal(clean.truncated, false);
});

test("a locked credential transaction takes the very lock ConfigStore takes", async () => {
  const state = await isolatedCredentials();
  const id = credentialId(TARGET);
  const profile = { provider: "kinsta", credential: storedCredential(id) };
  const locks = new ProfileLockManager(state.paths.stateDir, state.security);
  const config = new ConfigStore(state.paths.configFile, locks, state.security);
  const profileLock = lockFilePath(
    state.paths.stateDir,
    hostingProfileLockKey(TARGET.profile),
  );
  const bareNameLock = lockFilePath(state.paths.stateDir, TARGET.profile);
  const exists = async (path) =>
    stat(path).then(
      () => true,
      () => false,
    );

  try {
    await withLockedCredentialTransaction(
      config,
      TARGET.profile,
      state.store,
      async (transaction) => {
        await transaction.replace(id, PLACEHOLDER);
        // Held under `hosting-profile:<name>` — the key ConfigStore itself
        // uses — and not under the bare profile name.
        assert.equal(await exists(profileLock), true);
        assert.equal(await exists(bareNameLock), false);
        // Same key, so re-taking it from inside is refused: proof that the
        // credential write and the config write are one critical section.
        await assert.rejects(
          config.upsertHostingProfile(TARGET.profile, profile),
          { code: "internal_error" },
        );
        await config.upsertHostingProfileWithProfileLockHeld(
          TARGET.profile,
          profile,
        );
      },
    );

    assert.equal((await state.store.require(id)).reveal(), PLACEHOLDER);
    assert.equal(
      (await config.requireHostingProfile(TARGET.profile)).profile.credential
        .id,
      id,
    );
    // The same key again through the config entry point.
    await config.withHostingProfileLock(TARGET.profile, async () => {
      assert.equal(await exists(profileLock), true);
    });
    assert.equal(await exists(bareNameLock), false);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a secret never escapes its wrapper through interpolation, JSON, or inspection", async () => {
  const secret = await resolveCredential(envCredential("HQ_TEST_API_KEY"), {
    env: { HQ_TEST_API_KEY: PLACEHOLDER },
  });

  assert.equal(`${secret}`, SECRET_PLACEHOLDER);
  assert.equal(String(secret), SECRET_PLACEHOLDER);
  assert.equal(secret.toString(), SECRET_PLACEHOLDER);
  assert.equal(JSON.stringify(secret), `"${SECRET_PLACEHOLDER}"`);
  assert.equal(
    JSON.stringify({ credential: secret, nested: [secret] }),
    `{"credential":"${SECRET_PLACEHOLDER}","nested":["${SECRET_PLACEHOLDER}"]}`,
  );
  assert.doesNotMatch(inspect(secret), /placeholder/);
  assert.doesNotMatch(inspect({ secret }, { depth: 5 }), /placeholder/);
  assert.equal(secret.length, PLACEHOLDER.length);
  assert.equal(secret.reveal(), PLACEHOLDER);

  // The output layer independently masks anything that looks like a credential.
  assert.equal(
    JSON.stringify(
      redact({ apiKey: PLACEHOLDER, token: PLACEHOLDER }),
    ).includes(PLACEHOLDER),
    false,
  );
});

test("stdin is the only interactive secret input and is bounded", async () => {
  const secret = await readSecretFromStdin(
    (async function* stream() {
      yield Buffer.from(`${PLACEHOLDER}\n`);
    })(),
  );
  assert.equal(secret.reveal(), PLACEHOLDER);
  assert.equal(secret.source, "stdin");

  await assert.rejects(
    readSecretFromStdin(
      (async function* stream() {
        yield Buffer.from("\n");
      })(),
    ),
    { code: "usage_error" },
  );
  await assert.rejects(
    readSecretFromStdin(
      (async function* stream() {
        yield Buffer.alloc(MAX_SECRET_BYTES + 1, 0x61);
      })(),
    ),
    { code: "usage_error" },
  );
});
