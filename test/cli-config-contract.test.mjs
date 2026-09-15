// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";
import {
  createHostingConfigHandlers,
  registerHostingConfigCommands,
} from "../dist/cli/hosting/config.js";
import {
  DEFAULT_OPERATION_TIMEOUT_MS,
  isCommanderUsageError,
  isHelpExit,
} from "../dist/cli/program.js";
import { defaultFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import { credentialId } from "../dist/credentials/store.js";
import { CliError } from "../dist/errors.js";
import { createRenderer } from "../dist/output/render.js";

/**
 * The one value in this file that stands in for a provider secret. It is only
 * ever fed to stdin and asserted to have reached the credential store and
 * nothing else — in particular never `config.json`, never the envelope.
 */
const STDIN_SECRET = "not-a-real-secret-0000";

const REQUEST_ID = "00000000-0000-4000-8000-000000000000";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** An offline `CommandIo`: no real stdin, no real filesystem, no real env. */
function fakeIo({ env = {}, stdin = "" } = {}) {
  return {
    env,
    async readStdin() {
      return stdin;
    },
    async readFile(path) {
      const error = new Error(`ENOENT: no such file or directory ${path}`);
      error.code = "ENOENT";
      throw error;
    },
    async writePrivateFile() {
      throw new Error("writePrivateFile must not be called by config commands");
    },
  };
}

/** An in-memory `CredentialStore`; nothing here touches an OS keychain. */
function fakeCredentials({ warning, failDelete = false } = {}) {
  const records = new Map();
  const calls = [];
  return {
    records,
    calls,
    async read(id) {
      calls.push({ name: "read", id });
      return records.get(id);
    },
    async require(id) {
      const value = records.get(id);
      if (value === undefined) throw new Error(`missing credential ${id}`);
      return value;
    },
    async replace(id, secret) {
      calls.push({ name: "replace", id });
      const previous = records.has(id)
        ? { state: "present", record: records.get(id) }
        : { state: "absent" };
      records.set(id, secret);
      return { id, previous };
    },
    async delete(id) {
      calls.push({ name: "delete", id });
      if (failDelete) throw new Error("keychain unavailable");
      const previous = records.has(id)
        ? { state: "present", record: records.get(id) }
        : { state: "absent" };
      records.delete(id);
      return { id, previous };
    },
    async restore(snapshot) {
      calls.push({ name: "restore", id: snapshot.id });
      if (snapshot.previous.state === "absent") records.delete(snapshot.id);
      else records.set(snapshot.id, snapshot.previous.record);
    },
    diagnostic() {
      return {
        backend: "file",
        osBackedEncryption: false,
        ...(warning === undefined ? {} : { warning }),
      };
    },
  };
}

/**
 * A `HostingClientFactory` over a fake `ProviderClient`. No provider module is
 * constructed and no network call is possible.
 */
function fakeHosting({ companyId = "company-42", validate } = {}) {
  const entries = [];
  const client = {
    provider: "kinsta",
    async validate() {
      if (validate !== undefined) return validate();
      return {
        provider: "kinsta",
        status: "ok",
        companyId,
        credential: "env:KINSTA_API_KEY",
      };
    },
    async listSites() {
      throw new Error("listSites must not be called by config commands");
    },
    async getSite() {
      throw new Error("getSite must not be called by config commands");
    },
    async listEnvironments() {
      throw new Error("listEnvironments must not be called");
    },
    async read() {
      throw new Error("read must not be called by config commands");
    },
    async action() {
      throw new Error("action must not be called by config commands");
    },
    async operationStatus() {
      throw new Error("operationStatus must not be called");
    },
  };
  return {
    entries,
    client,
    registry: {},
    async clientFromEntry(entry) {
      entries.push(entry);
      return { ...client, provider: entry.profile.provider };
    },
    async clientFromProfile() {
      throw new Error("clientFromProfile must not be called");
    },
    async contextFromEntry() {
      throw new Error("contextFromEntry must not be called");
    },
  };
}

/**
 * Build the group against a real `ConfigStore` in a throwaway HQ root, plus a
 * throwaway commander program carrying the globals `program.ts` owns. The
 * group is exercised through its own `register...Commands`, because
 * `program.ts` is not this agent's file to edit.
 */
async function harness(root, options = {}) {
  const stdout = [];
  const stderr = [];
  const paths = platformPaths({ NOVAMIRA_HQ_HOME: root });
  const security = defaultFileSecurity();
  const store = new ConfigStore(
    paths.configFile,
    new ProfileLockManager(paths.stateDir, security),
    security,
  );
  const hosting = options.hosting ?? fakeHosting();
  const credentials = options.credentials ?? fakeCredentials();
  const io = options.io ?? fakeIo();
  const renderer = createRenderer(
    { json: options.json ?? true, requestId: REQUEST_ID },
    {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
  );

  const handlers = createHostingConfigHandlers({
    version: "0.0.0-test",
    paths,
    store,
    hosting,
    // Phase 6 moved the credential store onto `CommandDependencies` as the
    // lazy getter the dashboard server also takes, so the group now receives a
    // function rather than a store.
    credentials: async () => credentials,
    io,
    rendererFor: () => renderer,
  });

  const program = new Command();
  program
    .name("novamira-hq")
    .exitOverride()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined })
    .option("--json", "emit exactly one JSON value on stdout", false)
    .option("--profile <name>", "hosting profile to operate through")
    .option("--yes", "approve destructive operations", false)
    .option("--quiet", "suppress nonessential diagnostics", false)
    .option("--verbose", "emit redacted diagnostics", false)
    .option("--no-color", "disable ANSI color");

  // The same `optionsFor` shape `program.ts` passes in: the innermost active
  // command's options win, merged over the program's globals.
  const optionsFor = (values) => {
    const active =
      values.findLast((value) => value instanceof Command) ?? program;
    return {
      ...active.optsWithGlobals(),
      timeout: DEFAULT_OPERATION_TIMEOUT_MS,
      timeoutExplicit: false,
    };
  };

  // `program.ts` already owns `config path`; the group must extend that tree.
  const configPathCalls = [];
  program
    .command("config")
    .description("inspect HQ configuration")
    .command("path")
    .description("print the resolved HQ configuration and state paths")
    .action((...values) => {
      configPathCalls.push(optionsFor(values));
    });

  registerHostingConfigCommands(program, handlers, optionsFor);

  /**
   * Run argv exactly the way `main.ts` does, including its mapping of a
   * commander parse failure onto `usage_error`, so the exit codes asserted
   * here are the ones the real binary returns.
   */
  const run = async (argv) => {
    stdout.length = 0;
    stderr.length = 0;
    try {
      await program.parseAsync(argv, { from: "user" });
      return { code: 0, stdout: stdout.join(""), stderr: stderr.join("") };
    } catch (error) {
      if (isHelpExit(error))
        return { code: 0, stdout: stdout.join(""), stderr: stderr.join("") };
      const code = renderer.failure(
        isCommanderUsageError(error)
          ? new CliError("usage_error", "Invalid command usage.")
          : error,
      );
      return { code, stdout: stdout.join(""), stderr: stderr.join(""), error };
    }
  };

  const envelope = async (argv) => {
    const result = await run(argv);
    return { ...result, body: JSON.parse(result.stdout) };
  };

  const document = async () =>
    JSON.parse(await readFile(paths.configFile, "utf8"));

  const rawConfig = async () => readFile(paths.configFile, "utf8");

  return {
    configPathCalls,
    credentials,
    document,
    envelope,
    handlers,
    hosting,
    io,
    paths,
    program,
    rawConfig,
    run,
    store,
  };
}

async function isolated(body, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-config-"));
  try {
    return await body(await harness(root, options), root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function commandNames(program) {
  const config = program.commands.find(
    (command) => command.name() === "config",
  );
  return config.commands.map((command) => command.name()).sort();
}

function optionFlags(program, name) {
  const config = program.commands.find(
    (command) => command.name() === "config",
  );
  const command = config.commands.find((child) => child.name() === name);
  return command.options.map((option) => option.long).sort();
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

test("the group extends the existing config tree instead of replacing it", async () => {
  await isolated(async (cli) => {
    assert.deepEqual(commandNames(cli.program), [
      "add",
      "list",
      "path",
      "remove",
      "show",
    ]);
    // `config path` keeps working, and still sees the globals.
    const result = await cli.run(["--json", "config", "path"]);
    assert.equal(result.code, 0);
    assert.equal(cli.configPathCalls.length, 1);
    assert.equal(cli.configPathCalls[0].json, true);
  });
});

test("registering onto the config command itself does not nest a second one", async () => {
  await isolated(async (cli) => {
    const standalone = new Command("config");
    registerHostingConfigCommands(standalone, cli.handlers, () => ({}));
    assert.deepEqual(
      standalone.commands.map((command) => command.name()).sort(),
      ["add", "list", "remove", "show"],
    );
  });
});

test("config add exposes the ported flags and never a secret-valued option", async () => {
  await isolated(async (cli) => {
    assert.deepEqual(optionFlags(cli.program, "add"), [
      "--api-base-url",
      "--company",
      "--credential-env",
      "--credential-file",
      "--credential-stdin",
      "--force",
    ]);
    // A bare `--credential <value>` would put the secret in argv.
    assert.ok(!optionFlags(cli.program, "add").includes("--credential"));
  });
});

test("config add requires exactly one provider argument", async () => {
  await isolated(async (cli) => {
    const missing = await cli.run(["config", "add"]);
    assert.equal(missing.code, 2);
    const extra = await cli.run(["config", "add", "kinsta", "extra"]);
    assert.equal(extra.code, 2);
  });
});

test("config remove requires a profile argument", async () => {
  await isolated(async (cli) => {
    const result = await cli.run(["config", "remove"]);
    assert.equal(result.code, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* config add                                                                 */
/* -------------------------------------------------------------------------- */

test("config add defaults to an env reference naming the provider variable", async () => {
  await isolated(async (cli) => {
    const { code, body } = await cli.envelope([
      "config",
      "add",
      "kinsta",
      "--company",
      "none",
    ]);
    assert.equal(code, 0);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data, {
      profile: "kinsta",
      provider: "kinsta",
      credential: "env:KINSTA_API_KEY",
      companyId: null,
      configFile: cli.store.configFile,
    });
    assert.equal(body.meta.requestId, REQUEST_ID);
    assert.equal(body.meta.profile, "kinsta");
    assert.equal(body.meta.provider, "kinsta");

    const document = await cli.document();
    assert.deepEqual(document.hostingProfiles.kinsta, {
      provider: "kinsta",
      credential: { type: "env", name: "KINSTA_API_KEY" },
    });
    // `--company none` must not reach the provider at all.
    assert.equal(cli.hosting.entries.length, 0);
  });
});

test("config add --company auto validates and adopts the reported company", async () => {
  await isolated(async (cli) => {
    const { body } = await cli.envelope(["config", "add", "kinsta"]);
    assert.equal(body.data.companyId, "company-42");
    assert.equal(cli.hosting.entries.length, 1);
    // The client is built from the profile about to be saved, which carries no
    // company id yet.
    assert.deepEqual(cli.hosting.entries[0], {
      name: "kinsta",
      profile: {
        provider: "kinsta",
        credential: { type: "env", name: "KINSTA_API_KEY" },
      },
    });
    assert.equal(
      (await cli.document()).hostingProfiles.kinsta.companyId,
      "company-42",
    );
  });
});

test("config add --company auto keeps no company for InstaWP and Pressable", async () => {
  for (const provider of ["instawp", "pressable"]) {
    await isolated(async (cli) => {
      const { body } = await cli.envelope(["config", "add", provider]);
      assert.equal(body.data.companyId, null);
      // The credential is still validated, exactly as in Go.
      assert.equal(cli.hosting.entries.length, 1);
      assert.equal(
        (await cli.document()).hostingProfiles[provider].companyId,
        undefined,
      );
    });
  }
});

test("config add --company accepts an explicit id without calling the provider", async () => {
  await isolated(async (cli) => {
    const { body } = await cli.envelope([
      "config",
      "add",
      "kinsta",
      "--company",
      "acme-1",
    ]);
    assert.equal(body.data.companyId, "acme-1");
    assert.equal(cli.hosting.entries.length, 0);
  });
});

test("config add --company auto reports the provider failure", async () => {
  const hosting = fakeHosting({
    validate: () => {
      throw new CliError("credential_invalid", "The credential was rejected.");
    },
  });
  await isolated(
    async (cli) => {
      const { code, body } = await cli.envelope(["config", "add", "kinsta"]);
      assert.equal(code, 3);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "credential_invalid");
      // Nothing was written: validation runs before the save.
      await assert.rejects(cli.document());
    },
    { hosting },
  );
});

test("config add --profile names the created profile", async () => {
  await isolated(async (cli) => {
    const { body } = await cli.envelope([
      "--profile",
      "production",
      "config",
      "add",
      "kinsta",
      "--company",
      "none",
    ]);
    assert.equal(body.data.profile, "production");
    const document = await cli.document();
    assert.deepEqual(Object.keys(document.hostingProfiles), ["production"]);
  });
});

test("config add rejects an invalid profile name with usage_error", async () => {
  await isolated(async (cli) => {
    const { code, body } = await cli.envelope([
      "--profile",
      "not a name",
      "config",
      "add",
      "kinsta",
      "--company",
      "none",
    ]);
    assert.equal(code, 2);
    assert.equal(body.error.code, "usage_error");
  });
});

test("config add rejects an unknown provider with usage_error and the allowed set", async () => {
  await isolated(async (cli) => {
    const { code, body } = await cli.envelope(["config", "add", "bluehost"]);
    assert.equal(code, 2);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "usage_error");
    assert.equal(body.error.details.flag, "provider");
    assert.deepEqual(body.error.details.allowed, [
      "kinsta",
      "instawp",
      "pantheon",
      "pressable",
      "wpengine",
      "rocketnet",
      "hostinger",
      "cloudways",
    ]);
    assert.equal(cli.hosting.entries.length, 0);
  });
});

test("config add --credential-env stores the variable name, never its value", async () => {
  await isolated(
    async (cli) => {
      const { body } = await cli.envelope([
        "config",
        "add",
        "kinsta",
        "--credential-env",
        "MY_KINSTA_KEY",
        "--company",
        "none",
      ]);
      assert.equal(body.data.credential, "env:MY_KINSTA_KEY");
      const raw = await cli.rawConfig();
      assert.deepEqual(JSON.parse(raw).hostingProfiles.kinsta.credential, {
        type: "env",
        name: "MY_KINSTA_KEY",
      });
      assert.ok(!raw.includes(STDIN_SECRET));
      // The reference is not resolved at profile-creation time.
      assert.equal(cli.credentials.calls.length, 0);
    },
    { io: fakeIo({ env: { MY_KINSTA_KEY: STDIN_SECRET } }) },
  );
});

test("config add --credential-file stores the path only", async () => {
  await isolated(async (cli) => {
    const { body } = await cli.envelope([
      "config",
      "add",
      "wpengine",
      "--credential-file",
      "/keys/wpengine.txt",
      "--company",
      "none",
    ]);
    assert.equal(body.data.credential, "file:/keys/wpengine.txt");
    assert.deepEqual(
      (await cli.document()).hostingProfiles.wpengine.credential,
      { type: "file", path: "/keys/wpengine.txt" },
    );
  });
});

test("config add --credential-stdin stores the secret in the credential store, not in config.json", async () => {
  const credentials = fakeCredentials();
  await isolated(
    async (cli) => {
      const { code, body } = await cli.envelope([
        "config",
        "add",
        "kinsta",
        "--credential-stdin",
        "--company",
        "none",
      ]);
      assert.equal(code, 0);
      const id = credentialId({ provider: "kinsta", profile: "kinsta" });
      assert.equal(body.data.credential, `stored:${id}`);
      assert.equal(credentials.records.get(id), STDIN_SECRET);

      const raw = await cli.rawConfig();
      assert.ok(!raw.includes(STDIN_SECRET));
      assert.deepEqual(JSON.parse(raw).hostingProfiles.kinsta.credential, {
        type: "stored",
        id,
      });
      // The secret never reaches the envelope either.
      assert.ok(!JSON.stringify(body).includes(STDIN_SECRET));
    },
    { credentials, io: fakeIo({ stdin: `${STDIN_SECRET}\n` }) },
  );
});

test("config add surfaces the credential backend warning when a secret is written", async () => {
  const credentials = fakeCredentials({
    warning: "Provider secrets use an owner-only file fallback.",
  });
  await isolated(
    async (cli) => {
      const { body } = await cli.envelope([
        "config",
        "add",
        "kinsta",
        "--credential-stdin",
        "--company",
        "none",
      ]);
      assert.deepEqual(body.meta.warnings, [
        {
          code: "credential_backend",
          message: "Provider secrets use an owner-only file fallback.",
          details: { backend: "file" },
        },
      ]);
    },
    { credentials, io: fakeIo({ stdin: STDIN_SECRET }) },
  );
});

test("config add --credential-stdin with an empty stdin is credential_missing", async () => {
  await isolated(
    async (cli) => {
      const { code, body } = await cli.envelope([
        "config",
        "add",
        "kinsta",
        "--credential-stdin",
      ]);
      assert.equal(code, 3);
      assert.equal(body.error.code, "credential_missing");
      await assert.rejects(cli.document());
    },
    { io: fakeIo({ stdin: "\n" }) },
  );
});

test("config add rejects two credential sources", async () => {
  await isolated(
    async (cli) => {
      const { code, body } = await cli.envelope([
        "config",
        "add",
        "kinsta",
        "--credential-env",
        "KINSTA_API_KEY",
        "--credential-stdin",
      ]);
      assert.equal(code, 2);
      assert.equal(body.error.code, "usage_error");
      assert.match(body.error.message, /at most one of --credential-env/);
    },
    { io: fakeIo({ stdin: STDIN_SECRET }) },
  );
});

test("config add refuses to replace an existing profile without --force", async () => {
  await isolated(async (cli) => {
    await cli.run(["config", "add", "kinsta", "--company", "none"]);
    const { code, body } = await cli.envelope([
      "config",
      "add",
      "kinsta",
      "--company",
      "none",
    ]);
    assert.equal(code, 2);
    assert.equal(body.error.code, "usage_error");
    assert.equal(body.error.details.profile, "kinsta");
    assert.match(body.error.message, /rerun with --force/);
  });
});

test("config add --force replaces the profile and forgets the secret it owned", async () => {
  const credentials = fakeCredentials();
  await isolated(
    async (cli) => {
      await cli.run([
        "config",
        "add",
        "kinsta",
        "--credential-stdin",
        "--company",
        "none",
      ]);
      const id = credentialId({ provider: "kinsta", profile: "kinsta" });
      assert.equal(credentials.records.get(id), STDIN_SECRET);

      const { code, body } = await cli.envelope([
        "config",
        "add",
        "kinsta",
        "--force",
        "--credential-env",
        "KINSTA_API_KEY",
        "--company",
        "none",
      ]);
      assert.equal(code, 0);
      assert.equal(body.data.credential, "env:KINSTA_API_KEY");
      // The stored secret has no owner left and is removed.
      assert.equal(credentials.records.has(id), false);
    },
    { credentials, io: fakeIo({ stdin: STDIN_SECRET }) },
  );
});

test("config add --force keeps a re-stored secret under the same id", async () => {
  const credentials = fakeCredentials();
  await isolated(
    async (cli) => {
      await cli.run([
        "config",
        "add",
        "kinsta",
        "--credential-stdin",
        "--company",
        "none",
      ]);
      await cli.run([
        "config",
        "add",
        "kinsta",
        "--force",
        "--credential-stdin",
        "--company",
        "none",
      ]);
      const id = credentialId({ provider: "kinsta", profile: "kinsta" });
      assert.equal(credentials.records.get(id), STDIN_SECRET);
      assert.deepEqual(
        credentials.calls.filter((call) => call.name === "delete"),
        [],
      );
    },
    { credentials, io: fakeIo({ stdin: STDIN_SECRET }) },
  );
});

test("config add rolls the credential write back when the save fails", async () => {
  const credentials = fakeCredentials();
  await isolated(
    async (cli) => {
      const { code, body } = await cli.envelope([
        "config",
        "add",
        "kinsta",
        "--credential-stdin",
        "--api-base-url",
        "not-a-url",
        "--company",
        "none",
      ]);
      assert.equal(code, 5);
      assert.equal(body.error.code, "schema_validation_failed");
      assert.equal(credentials.records.size, 0);
      assert.deepEqual(
        credentials.calls.map((call) => call.name),
        ["replace", "restore"],
      );
    },
    { credentials, io: fakeIo({ stdin: STDIN_SECRET }) },
  );
});

test("config add --api-base-url is persisted; the default stays implicit", async () => {
  await isolated(async (cli) => {
    await cli.run([
      "config",
      "add",
      "kinsta",
      "--api-base-url",
      "https://api.kinsta.test/v2",
      "--company",
      "none",
    ]);
    assert.equal(
      (await cli.document()).hostingProfiles.kinsta.apiBaseUrl,
      "https://api.kinsta.test/v2",
    );
    await cli.run([
      "--profile",
      "plain",
      "config",
      "add",
      "kinsta",
      "--company",
      "none",
    ]);
    assert.equal(
      (await cli.document()).hostingProfiles.plain.apiBaseUrl,
      undefined,
    );
  });
});

test("config add renders the Go human line", async () => {
  await isolated(
    async (cli) => {
      const result = await cli.run(["config", "add", "kinsta"]);
      assert.equal(
        result.stdout,
        "added profile kinsta [kinsta], credential=env:KINSTA_API_KEY, company=company-42\n",
      );
    },
    { json: false },
  );
});

/* -------------------------------------------------------------------------- */
/* config list                                                                */
/* -------------------------------------------------------------------------- */

test("config list reports an empty configuration", async () => {
  await isolated(async (cli) => {
    const { code, body } = await cli.envelope(["config", "list"]);
    assert.equal(code, 0);
    assert.deepEqual(body.data, {
      configFile: cli.store.configFile,
      profiles: [],
    });
  });
});

test("config list summarises every profile in name order", async () => {
  await isolated(async (cli) => {
    await cli.run([
      "--profile",
      "staging",
      "config",
      "add",
      "wpengine",
      "--credential-env",
      "WPE_API_PASSWORD",
      "--company",
      "none",
    ]);
    await cli.run([
      "--profile",
      "production",
      "config",
      "add",
      "kinsta",
      "--company",
      "acme-1",
    ]);
    const { body } = await cli.envelope(["config", "list"]);
    assert.deepEqual(body.data.profiles, [
      {
        name: "production",
        provider: "kinsta",
        credential: "env:KINSTA_API_KEY",
        companyId: "acme-1",
      },
      {
        name: "staging",
        provider: "wpengine",
        credential: "env:WPE_API_PASSWORD",
        companyId: null,
      },
    ]);
  });
});

test("config list renders the Go human lines", async () => {
  await isolated(
    async (cli) => {
      const empty = await cli.run(["config", "list"]);
      assert.equal(empty.stdout, "no profiles configured\n");
      await cli.run(["config", "add", "kinsta", "--company", "none"]);
      const listed = await cli.run(["config", "list"]);
      assert.equal(
        listed.stdout,
        "kinsta [kinsta] credential=env:KINSTA_API_KEY company=(not set)\n",
      );
    },
    { json: false },
  );
});

/* -------------------------------------------------------------------------- */
/* config show                                                                */
/* -------------------------------------------------------------------------- */

test("config show --profile reports one profile", async () => {
  await isolated(async (cli) => {
    await cli.run([
      "config",
      "add",
      "kinsta",
      "--api-base-url",
      "https://api.kinsta.test/v2",
      "--company",
      "acme-1",
    ]);
    const { code, body } = await cli.envelope([
      "--profile",
      "kinsta",
      "config",
      "show",
    ]);
    assert.equal(code, 0);
    assert.deepEqual(body.data, {
      configFile: cli.store.configFile,
      profile: "kinsta",
      provider: "kinsta",
      credential: "env:KINSTA_API_KEY",
      companyId: "acme-1",
      apiBaseUrl: "https://api.kinsta.test/v2",
    });
    assert.equal(body.meta.profile, "kinsta");
  });
});

test("config show --profile fails with profile_not_found", async () => {
  await isolated(async (cli) => {
    const { code, body } = await cli.envelope([
      "--profile",
      "missing",
      "config",
      "show",
    ]);
    assert.equal(code, 2);
    assert.equal(body.error.code, "profile_not_found");
    assert.deepEqual(body.error.details.profiles, []);
  });
});

test("config show without a profile emits the whole document", async () => {
  await isolated(async (cli) => {
    await cli.run(["config", "add", "kinsta", "--company", "none"]);
    const { body } = await cli.envelope(["config", "show"]);
    assert.deepEqual(body.data, {
      version: 1,
      hostingProfiles: {
        kinsta: {
          provider: "kinsta",
          credential: { type: "env", name: "KINSTA_API_KEY" },
        },
      },
      pushes: {},
    });
  });
});

test("config show renders the Go human lines", async () => {
  await isolated(
    async (cli) => {
      await cli.run(["config", "add", "kinsta", "--company", "none"]);
      const result = await cli.run(["--profile", "kinsta", "config", "show"]);
      assert.equal(
        result.stdout,
        [
          "profile = kinsta",
          "provider = kinsta",
          "credential = env:KINSTA_API_KEY",
          "company_id = (not set)",
          "api_base_url = (default)",
          "",
        ].join("\n"),
      );
      const document = await cli.run(["config", "show"]);
      assert.equal(document.stdout, `${await cli.rawConfig()}`);
    },
    { json: false },
  );
});

/* -------------------------------------------------------------------------- */
/* config remove                                                              */
/* -------------------------------------------------------------------------- */

test("config remove deletes the profile and the secret it owned", async () => {
  const credentials = fakeCredentials();
  await isolated(
    async (cli) => {
      await cli.run([
        "config",
        "add",
        "kinsta",
        "--credential-stdin",
        "--company",
        "none",
      ]);
      const id = credentialId({ provider: "kinsta", profile: "kinsta" });
      const { code, body } = await cli.envelope(["config", "remove", "kinsta"]);
      assert.equal(code, 0);
      assert.deepEqual(body.data, {
        profile: "kinsta",
        configFile: cli.store.configFile,
      });
      assert.equal(body.meta.provider, "kinsta");
      assert.deepEqual((await cli.document()).hostingProfiles, {});
      assert.equal(credentials.records.has(id), false);
    },
    { credentials, io: fakeIo({ stdin: STDIN_SECRET }) },
  );
});

test("config remove warns instead of failing when the secret cannot be deleted", async () => {
  const credentials = fakeCredentials({ failDelete: true });
  await isolated(
    async (cli) => {
      await cli.run([
        "config",
        "add",
        "kinsta",
        "--credential-stdin",
        "--company",
        "none",
      ]);
      const { code, body } = await cli.envelope(["config", "remove", "kinsta"]);
      assert.equal(code, 0);
      assert.equal(body.meta.warnings[0].code, "credential_orphaned");
      assert.deepEqual((await cli.document()).hostingProfiles, {});
    },
    { credentials, io: fakeIo({ stdin: STDIN_SECRET }) },
  );
});

test("config remove fails with profile_not_found", async () => {
  await isolated(async (cli) => {
    const { code, body } = await cli.envelope(["config", "remove", "missing"]);
    assert.equal(code, 2);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "profile_not_found");
  });
});

test("config remove rejects an invalid profile name", async () => {
  await isolated(async (cli) => {
    const { code, body } = await cli.envelope([
      "config",
      "remove",
      "not a name",
    ]);
    assert.equal(code, 2);
    assert.equal(body.error.code, "usage_error");
  });
});

test("config remove renders the Go human line", async () => {
  await isolated(
    async (cli) => {
      await cli.run(["config", "add", "kinsta", "--company", "none"]);
      const result = await cli.run(["config", "remove", "kinsta"]);
      assert.equal(result.stdout, "removed profile kinsta\n");
    },
    { json: false },
  );
});
