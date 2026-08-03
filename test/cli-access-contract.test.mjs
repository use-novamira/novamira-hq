// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command, CommanderError } from "commander";
import {
  createAccessHandlers,
  registerAccessCommands,
} from "../dist/cli/hosting/access.js";
import { createCommandIo } from "../dist/cli/inputs.js";
import { CliError, asCliError, exitCodeFor } from "../dist/errors.js";
import { createRenderer } from "../dist/output/render.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** An offline `CommandIo`: no real stdin, no real filesystem, no real env. */
function fakeIo({ env = {}, stdin = "", files = {} } = {}) {
  const writes = [];
  return {
    env,
    writes,
    async readStdin() {
      return stdin;
    },
    async readFile(path) {
      if (!Object.hasOwn(files, path)) {
        const error = new Error(`ENOENT: no such file or directory ${path}`);
        error.code = "ENOENT";
        throw error;
      }
      return files[path];
    },
    async writePrivateFile(path, content) {
      writes.push({ path, content });
    },
  };
}

/**
 * A `ProviderClient` that records every request and never speaks HTTP. Nothing
 * in this suite can reach a provider: there is no fetch, no socket and no
 * registry entry anywhere in the graph.
 */
function fakeClient({
  provider = "kinsta",
  readResult = { environment: { id: "env-1" } },
  actionResult = {},
  readError,
  actionError,
} = {}) {
  const reads = [];
  const actions = [];
  return {
    provider,
    reads,
    actions,
    async read(request) {
      reads.push(request);
      if (readError !== undefined) throw readError;
      return readResult;
    },
    async action(request) {
      actions.push(request);
      if (actionError !== undefined) throw actionError;
      return {
        provider,
        action: "access.test",
        status: 200,
        raw: null,
        ...actionResult,
      };
    },
    async operationStatus() {
      throw new Error("no access command polls an operation");
    },
  };
}

/**
 * Register the group onto a throwaway program, exactly as the integration step
 * will onto the real one: the same `optionsFor` shape as `program.ts`, the same
 * `--profile` global, and the same failure funnel as `main.ts`.
 */
function harness({
  client = fakeClient(),
  io = fakeIo(),
  profiles = { prod: { provider: "kinsta" } },
  json = true,
} = {}) {
  const out = [];
  const err = [];
  const renderer = createRenderer(
    { json, requestId: "req-1" },
    {
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => err.push(chunk) },
    },
  );

  const dependencies = {
    store: {
      async selectHostingProfile(requested) {
        if (requested === undefined || requested === "") {
          throw new CliError(
            "usage_error",
            "Select a hosting profile with --profile.",
            { details: { profiles: Object.keys(profiles) } },
          );
        }
        const profile = profiles[requested];
        if (profile === undefined) {
          throw new CliError("profile_not_found", `No profile ${requested}.`);
        }
        return { name: requested, profile };
      },
    },
    hosting: {
      async clientFromEntry() {
        return client;
      },
    },
    io,
    rendererFor: () => renderer,
  };

  const program = new Command()
    .name("novamira-hq")
    .exitOverride()
    .option("--json", "emit exactly one JSON value on stdout", false)
    .option("--profile <name>", "hosting profile");
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });

  const optionsFor = (values) => {
    const active =
      values.findLast((value) => value instanceof Command) ?? program;
    return { ...active.optsWithGlobals(), timeoutExplicit: false };
  };

  registerAccessCommands(
    program,
    createAccessHandlers(dependencies),
    optionsFor,
  );

  /** Mirrors `main.ts`: never rejects, returns the process exit code. */
  const run = async (argv) => {
    try {
      await program.parseAsync(["--profile", "prod", ...argv], {
        from: "user",
      });
      return 0;
    } catch (error) {
      const cliError =
        error instanceof CommanderError
          ? new CliError("usage_error", "Invalid command usage.")
          : asCliError(error);
      return renderer.failure(cliError);
    }
  };

  const runBare = async (argv) => {
    try {
      await program.parseAsync(argv, { from: "user" });
      return 0;
    } catch (error) {
      const cliError =
        error instanceof CommanderError
          ? new CliError("usage_error", "Invalid command usage.")
          : asCliError(error);
      return renderer.failure(cliError);
    }
  };

  return {
    client,
    io,
    program,
    out,
    err,
    run,
    runBare,
    envelope: () => JSON.parse(out.join("")),
    stdout: () => out.join(""),
  };
}

/** Run an invocation that must succeed, and return the parsed envelope. */
async function succeeds(context, argv) {
  const code = await context.run(argv);
  assert.equal(code, 0, context.stdout());
  const envelope = context.envelope();
  assert.equal(envelope.ok, true, context.stdout());
  return envelope;
}

/** Run an invocation that must fail, and return the failure envelope body. */
async function fails(context, argv, code, exit) {
  const status = await context.run(argv);
  const envelope = context.envelope();
  assert.equal(envelope.ok, false, context.stdout());
  assert.equal(envelope.error.code, code, envelope.error.message);
  assert.equal(status, exit ?? exitCodeFor(new CliError(code, "")));
  return envelope.error;
}

function subcommand(program, path) {
  return path.reduce((command, name) => {
    const child = command.commands.find((entry) => entry.name() === name);
    assert.ok(child, `missing subcommand ${path.join(" ")}`);
    return child;
  }, program);
}

function longFlags(command) {
  return command.options.map((option) => option.long);
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

test("access registers Go's ssh and sftp trees under the given parent", () => {
  const { program } = harness();
  const access = subcommand(program, ["access"]);
  assert.deepEqual(
    access.commands.map((command) => command.name()),
    ["ssh", "sftp"],
  );
  assert.deepEqual(
    subcommand(program, ["access", "ssh"]).commands.map((c) => c.name()),
    [
      "status",
      "set-status",
      "allowlist",
      "set-allowlist",
      "config",
      "generate-password",
      "password",
      "set-password-status",
      "change-expiration",
    ],
  );
  assert.deepEqual(
    subcommand(program, ["access", "sftp"]).commands.map((c) => c.name()),
    ["list", "toggle", "add", "remove"],
  );
});

test("every access subcommand declares exactly Go's flags", () => {
  const { program } = harness();
  const flagsOf = (path) => longFlags(subcommand(program, path));

  assert.deepEqual(flagsOf(["access", "ssh", "status"]), ["--env"]);
  assert.deepEqual(flagsOf(["access", "ssh", "set-status"]), [
    "--env",
    "--enabled",
    "--no-enabled",
  ]);
  assert.deepEqual(flagsOf(["access", "ssh", "allowlist"]), ["--env"]);
  assert.deepEqual(flagsOf(["access", "ssh", "set-allowlist"]), [
    "--env",
    "--from-json",
    "--ip",
  ]);
  assert.deepEqual(flagsOf(["access", "ssh", "config"]), ["--env", "--site"]);
  assert.deepEqual(flagsOf(["access", "ssh", "generate-password"]), ["--env"]);
  assert.deepEqual(flagsOf(["access", "ssh", "password"]), [
    "--env",
    "--secret-out",
  ]);
  assert.deepEqual(flagsOf(["access", "ssh", "set-password-status"]), [
    "--env",
    "--enabled",
    "--no-enabled",
  ]);
  assert.deepEqual(flagsOf(["access", "ssh", "change-expiration"]), [
    "--env",
    "--interval",
  ]);
  assert.deepEqual(flagsOf(["access", "sftp", "list"]), ["--env"]);
  assert.deepEqual(flagsOf(["access", "sftp", "toggle"]), [
    "--env",
    "--enabled",
    "--no-enabled",
  ]);
  assert.deepEqual(flagsOf(["access", "sftp", "add"]), [
    "--env",
    "--from-json",
    "--username",
    "--password-env",
    "--password-stdin",
    "--password-file",
    "--root-directory",
    "--permission",
  ]);
  assert.deepEqual(flagsOf(["access", "sftp", "remove"]), []);
  // `remove` keeps cobra's ExactArgs(1).
  assert.equal(
    subcommand(program, ["access", "sftp", "remove"]).registeredArguments
      .length,
    1,
  );
});

test("no access command ever takes a secret value on argv", () => {
  const { program } = harness();
  const add = subcommand(program, ["access", "sftp", "add"]);
  assert.equal(longFlags(add).includes("--password"), false);
  for (const path of [
    ["access", "ssh", "password"],
    ["access", "ssh", "generate-password"],
    ["access", "ssh", "set-password-status"],
  ]) {
    assert.equal(
      longFlags(subcommand(program, path)).some(
        (flag) => flag === "--password" || flag === "--secret",
      ),
      false,
    );
  }
});

test("sftp add defaults match Go's root directory and permission", async () => {
  const context = harness({ io: fakeIo({ env: { SFTP_PW: "s3cr3t" } }) });
  await succeeds(context, [
    "access",
    "sftp",
    "add",
    "--env",
    "env-1",
    "--username",
    "deploy",
    "--password-env",
    "SFTP_PW",
  ]);
  assert.deepEqual(context.client.actions[0].body, {
    username: "deploy",
    password: "s3cr3t",
    root_directory: "/",
    permission: "read",
  });
});

/* -------------------------------------------------------------------------- */
/* Provider requests                                                          */
/* -------------------------------------------------------------------------- */

test("the ssh read commands dispatch Go's read requests", async () => {
  const cases = [
    [
      ["access", "ssh", "status", "--env", "env-1"],
      { kind: "ssh-status", envId: "env-1" },
    ],
    [
      ["access", "ssh", "allowlist", "--env", "env-1"],
      { kind: "ssh-allowlist", envId: "env-1" },
    ],
    [
      ["access", "ssh", "config", "--site", "site-1", "--env", "env-1"],
      { kind: "ssh-config", siteId: "site-1", envId: "env-1" },
    ],
    [
      ["access", "sftp", "list", "--env", "env-1"],
      { kind: "sftp-accounts", envId: "env-1" },
    ],
  ];
  for (const [argv, expected] of cases) {
    const context = harness();
    const envelope = await succeeds(context, argv);
    assert.deepEqual(context.client.reads, [expected]);
    assert.equal(context.client.actions.length, 0);
    // A read renders the provider response verbatim (Go's printValue).
    assert.deepEqual(envelope.data, { environment: { id: "env-1" } });
    assert.deepEqual(envelope.meta, {
      requestId: "req-1",
      profile: "prod",
      provider: "kinsta",
    });
  }
});

test("the ssh toggles send Go's is_enabled body in both directions", async () => {
  for (const [argv, kind, expected] of [
    [
      ["access", "ssh", "set-status", "--env", "env-1", "--enabled"],
      "set-ssh-status",
      true,
    ],
    [
      ["access", "ssh", "set-status", "--env", "env-1"],
      "set-ssh-status",
      false,
    ],
    [
      ["access", "ssh", "set-status", "--env", "env-1", "--no-enabled"],
      "set-ssh-status",
      false,
    ],
    [
      ["access", "ssh", "set-password-status", "--env", "env-1", "--enabled"],
      "set-ssh-password-status",
      true,
    ],
    [
      ["access", "ssh", "set-password-status", "--env", "env-1"],
      "set-ssh-password-status",
      false,
    ],
  ]) {
    const context = harness();
    await succeeds(context, argv);
    assert.deepEqual(context.client.actions, [
      { kind, envId: "env-1", body: { is_enabled: expected } },
    ]);
  }
});

test("sftp toggle sends Go's enabled body", async () => {
  const context = harness();
  await succeeds(context, [
    "access",
    "sftp",
    "toggle",
    "--env",
    "env-1",
    "--enabled",
  ]);
  assert.deepEqual(context.client.actions, [
    { kind: "toggle-sftp-accounts", envId: "env-1", body: { enabled: true } },
  ]);

  const off = harness();
  await succeeds(off, ["access", "sftp", "toggle", "--env", "env-1"]);
  assert.deepEqual(off.client.actions[0].body, { enabled: false });
});

test("set-allowlist collects repeated --ip and honours --from-json", async () => {
  const context = harness();
  await succeeds(context, [
    "access",
    "ssh",
    "set-allowlist",
    "--env",
    "env-1",
    "--ip",
    "198.51.100.7",
    "--ip",
    "203.0.113.9",
  ]);
  assert.deepEqual(context.client.actions, [
    {
      kind: "set-ssh-allowlist",
      envId: "env-1",
      body: { ip_allowlist: ["198.51.100.7", "203.0.113.9"] },
    },
  ]);

  // No --ip at all is an explicit empty allowlist, as in Go.
  const empty = harness();
  await succeeds(empty, ["access", "ssh", "set-allowlist", "--env", "env-1"]);
  assert.deepEqual(empty.client.actions[0].body, { ip_allowlist: [] });

  // --from-json replaces the built body entirely, including from stdin.
  const fromFile = harness({
    io: fakeIo({ files: { "/allow.json": '{"ip_allowlist":["10.0.0.1"]}' } }),
  });
  await succeeds(fromFile, [
    "access",
    "ssh",
    "set-allowlist",
    "--env",
    "env-1",
    "--ip",
    "ignored",
    "--from-json",
    "/allow.json",
  ]);
  assert.deepEqual(fromFile.client.actions[0].body, {
    ip_allowlist: ["10.0.0.1"],
  });

  const fromStdin = harness({
    io: fakeIo({ stdin: '{"ip_allowlist":["10.0.0.2"]}' }),
  });
  await succeeds(fromStdin, [
    "access",
    "ssh",
    "set-allowlist",
    "--env",
    "env-1",
    "--from-json",
    "-",
  ]);
  assert.deepEqual(fromStdin.client.actions[0].body, {
    ip_allowlist: ["10.0.0.2"],
  });
});

test("generate-password, change-expiration and sftp remove dispatch their actions", async () => {
  const generate = harness();
  await succeeds(generate, [
    "access",
    "ssh",
    "generate-password",
    "--env",
    "env-1",
  ]);
  assert.deepEqual(generate.client.actions, [
    { kind: "generate-ssh-password", envId: "env-1" },
  ]);

  const expiration = harness();
  await succeeds(expiration, [
    "access",
    "ssh",
    "change-expiration",
    "--env",
    "env-1",
    "--interval",
    "one_day",
  ]);
  assert.deepEqual(expiration.client.actions, [
    {
      kind: "change-ssh-password-expiration",
      envId: "env-1",
      body: { exp_interval: "one_day" },
    },
  ]);

  const remove = harness();
  await succeeds(remove, ["access", "sftp", "remove", "sftp-42"]);
  assert.deepEqual(remove.client.actions, [
    { kind: "remove-sftp-account", sftpAccountId: "sftp-42" },
  ]);
});

test("sftp add builds the account body and takes the password by reference", async () => {
  const fromEnv = harness({ io: fakeIo({ env: { SFTP_PW: "s3cr3t" } }) });
  await succeeds(fromEnv, [
    "access",
    "sftp",
    "add",
    "--env",
    "env-1",
    "--username",
    "deploy",
    "--password-env",
    "SFTP_PW",
    "--root-directory",
    "/www",
    "--permission",
    "write",
  ]);
  assert.deepEqual(fromEnv.client.actions, [
    {
      kind: "add-sftp-account",
      envId: "env-1",
      body: {
        username: "deploy",
        password: "s3cr3t",
        root_directory: "/www",
        permission: "write",
      },
    },
  ]);

  const fromStdin = harness({ io: fakeIo({ stdin: "s3cr3t\n" }) });
  await succeeds(fromStdin, [
    "access",
    "sftp",
    "add",
    "--env",
    "env-1",
    "--username",
    "deploy",
    "--password-stdin",
  ]);
  assert.equal(fromStdin.client.actions[0].body.password, "s3cr3t");

  const fromFile = harness({ io: fakeIo({ files: { "/pw": "s3cr3t" } }) });
  await succeeds(fromFile, [
    "access",
    "sftp",
    "add",
    "--env",
    "env-1",
    "--username",
    "deploy",
    "--password-file",
    "/pw",
  ]);
  assert.equal(fromFile.client.actions[0].body.password, "s3cr3t");

  const fromJson = harness({
    io: fakeIo({ files: { "/acct.json": '{"username":"x","password":"y"}' } }),
  });
  await succeeds(fromJson, [
    "access",
    "sftp",
    "add",
    "--env",
    "env-1",
    "--from-json",
    "/acct.json",
  ]);
  assert.deepEqual(fromJson.client.actions[0].body, {
    username: "x",
    password: "y",
  });
});

/* -------------------------------------------------------------------------- */
/* Argument validation                                                        */
/* -------------------------------------------------------------------------- */

test("every command that names an environment requires --env", async () => {
  const argvs = [
    ["access", "ssh", "status"],
    ["access", "ssh", "set-status", "--enabled"],
    ["access", "ssh", "allowlist"],
    ["access", "ssh", "set-allowlist", "--ip", "10.0.0.1"],
    ["access", "ssh", "config", "--site", "site-1"],
    ["access", "ssh", "generate-password"],
    ["access", "ssh", "password", "--secret-out", "/tmp/pw"],
    ["access", "ssh", "set-password-status"],
    ["access", "ssh", "change-expiration", "--interval", "one_day"],
    ["access", "sftp", "list"],
    ["access", "sftp", "toggle"],
    ["access", "sftp", "add", "--username", "deploy", "--password-stdin"],
  ];
  for (const argv of argvs) {
    const context = harness({ io: fakeIo({ stdin: "s3cr3t" }) });
    const error = await fails(context, argv, "usage_error", 2);
    assert.equal(
      error.message,
      "--env is required unless --from-json is used.",
    );
    assert.equal(error.details.flag, "--env");
    assert.equal(context.client.reads.length, 0);
    assert.equal(context.client.actions.length, 0);
  }
});

test("ssh config requires --site, change-expiration requires --interval", async () => {
  const config = harness();
  const site = await fails(
    config,
    ["access", "ssh", "config", "--env", "env-1"],
    "usage_error",
    2,
  );
  assert.equal(site.details.flag, "--site");

  const expiration = harness();
  const interval = await fails(
    expiration,
    ["access", "ssh", "change-expiration", "--env", "env-1"],
    "usage_error",
    2,
  );
  assert.equal(interval.details.flag, "--interval");
  assert.equal(expiration.client.actions.length, 0);
});

test("sftp add requires --username, and rejects an empty account id", async () => {
  const add = harness({ io: fakeIo({ env: { SFTP_PW: "s3cr3t" } }) });
  const username = await fails(
    add,
    ["access", "sftp", "add", "--env", "env-1", "--password-env", "SFTP_PW"],
    "usage_error",
    2,
  );
  assert.equal(username.details.flag, "--username");

  const remove = harness();
  const argument = await fails(
    remove,
    ["access", "sftp", "remove", ""],
    "usage_error",
    2,
  );
  assert.equal(argument.message, "<sftp_account_id> is required.");
  assert.equal(remove.client.actions.length, 0);

  // A missing positional is commander's own usage failure, still exit 2.
  const missing = harness();
  assert.equal(await missing.run(["access", "sftp", "remove"]), 2);
});

test("an unknown or absent profile fails before any provider request", async () => {
  const context = harness();
  const missing = await context.runBare([
    "access",
    "ssh",
    "status",
    "--env",
    "e",
  ]);
  assert.equal(missing, 2);
  const envelope = context.envelope();
  assert.equal(envelope.error.code, "usage_error");
  assert.deepEqual(envelope.error.details.profiles, ["prod"]);
  assert.equal(context.client.reads.length, 0);

  const unknown = harness();
  assert.equal(
    await unknown.runBare([
      "--profile",
      "nope",
      "access",
      "sftp",
      "list",
      "--env",
      "e",
    ]),
    2,
  );
  assert.equal(unknown.envelope().error.code, "profile_not_found");
});

/* -------------------------------------------------------------------------- */
/* Secret handling                                                            */
/* -------------------------------------------------------------------------- */

test("sftp add demands exactly one password source", async () => {
  const none = harness();
  const error = await fails(
    none,
    ["access", "sftp", "add", "--env", "env-1", "--username", "deploy"],
    "usage_error",
    2,
  );
  assert.equal(
    error.message,
    "The SFTP password requires exactly one of --password-env, --password-stdin, or --password-file.",
  );

  const both = harness({
    io: fakeIo({ env: { SFTP_PW: "s3cr3t" }, stdin: "x" }),
  });
  await fails(
    both,
    [
      "access",
      "sftp",
      "add",
      "--env",
      "env-1",
      "--username",
      "deploy",
      "--password-env",
      "SFTP_PW",
      "--password-stdin",
    ],
    "usage_error",
    2,
  );
});

test("an absent sftp password is credential_missing and never echoed", async () => {
  const context = harness({ io: fakeIo({ env: {} }) });
  const error = await fails(
    context,
    [
      "access",
      "sftp",
      "add",
      "--env",
      "env-1",
      "--username",
      "deploy",
      "--password-env",
      "SFTP_PW",
    ],
    "credential_missing",
    3,
  );
  assert.equal(error.details.source, "env:SFTP_PW");
  assert.equal(context.client.actions.length, 0);
});

test("ssh password writes the secret to an owner-only file and masks it", async () => {
  const io = fakeIo();
  const context = harness({
    io,
    client: fakeClient({
      readResult: { environment: { sftp_password: "hunter2", id: "env-1" } },
    }),
  });
  const envelope = await succeeds(context, [
    "access",
    "ssh",
    "password",
    "--env",
    "env-1",
    "--secret-out",
    "/secrets/env-1.txt",
  ]);
  assert.deepEqual(context.client.reads, [
    { kind: "ssh-password", envId: "env-1" },
  ]);
  assert.deepEqual(io.writes, [
    { path: "/secrets/env-1.txt", content: "hunter2" },
  ]);
  assert.deepEqual(envelope.data, {
    path: "/secrets/env-1.txt",
    value: "********",
  });
  assert.equal(context.stdout().includes("hunter2"), false);
});

test("ssh password requires --secret-out and reports a missing field", async () => {
  const noPath = harness({
    client: fakeClient({
      readResult: { environment: { sftp_password: "hunter2" } },
    }),
  });
  const error = await fails(
    noPath,
    ["access", "ssh", "password", "--env", "env-1"],
    "usage_error",
    2,
  );
  assert.equal(error.details.flag, "--secret-out");

  const io = fakeIo();
  const wrongShape = harness({
    io,
    client: fakeClient({ readResult: { environment: { id: "env-1" } } }),
  });
  const missing = await fails(
    wrongShape,
    [
      "access",
      "ssh",
      "password",
      "--env",
      "env-1",
      "--secret-out",
      "/secrets/pw",
    ],
    "provider_error",
    4,
  );
  assert.match(missing.message, /environment\.sftp_password/);
  assert.deepEqual(io.writes, []);
});

test("ssh password writes real bytes at mode 0600 in human mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-access-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "nested", "env-1.txt");

  const context = harness({
    json: false,
    io: createCommandIo({ env: {}, readStdin: async () => "" }),
    client: fakeClient({
      readResult: { environment: { sftp_password: "hunter2" } },
    }),
  });
  assert.equal(
    await context.run([
      "access",
      "ssh",
      "password",
      "--env",
      "env-1",
      "--secret-out",
      path,
    ]),
    0,
  );
  assert.equal(await readFile(path, "utf8"), "hunter2");
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  assert.equal(context.stdout(), `wrote redacted secret to ${path}\n`);
});

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                  */
/* -------------------------------------------------------------------------- */

test("an action renders Go's printAction fields inside the v1 envelope", async () => {
  const context = harness({
    client: fakeClient({
      actionResult: {
        action: "access.ssh.set-status",
        status: 202,
        operationId: "op-7",
        message: "queued",
        raw: { data: { id: "op-7" } },
      },
    }),
  });
  const envelope = await succeeds(context, [
    "access",
    "ssh",
    "set-status",
    "--env",
    "env-1",
    "--enabled",
  ]);
  assert.deepEqual(envelope.data, {
    provider: "kinsta",
    action: "access.ssh.set-status",
    status: 202,
    message: "queued",
    operation_id: "op-7",
    raw: { data: { id: "op-7" } },
  });
  assert.deepEqual(envelope.meta, {
    requestId: "req-1",
    profile: "prod",
    provider: "kinsta",
  });
});

test("an action renders its human line when --json is off", async () => {
  const context = harness({
    json: false,
    client: fakeClient({
      actionResult: {
        action: "access.sftp.toggle",
        status: 200,
        operationId: "op-1",
        raw: null,
      },
    }),
  });
  assert.equal(
    await context.run(["access", "sftp", "toggle", "--env", "env-1"]),
    0,
  );
  assert.equal(
    context.stdout(),
    "access.sftp.toggle status=200 operation=op-1\n",
  );
});

test("a provider failure becomes a failure envelope with the taxonomy's exit code", async () => {
  const unsupported = harness({
    client: fakeClient({
      actionError: new CliError(
        "provider_unsupported",
        'WP Engine does not support the "toggle-sftp-accounts" action.',
        { details: { provider: "wpengine", action: "toggle-sftp-accounts" } },
      ),
    }),
  });
  const error = await fails(
    unsupported,
    ["access", "sftp", "toggle", "--env", "env-1"],
    "provider_unsupported",
    4,
  );
  assert.equal(error.details.action, "toggle-sftp-accounts");
  assert.equal(error.retryable, false);

  const readFailure = harness({
    client: fakeClient({
      readError: new CliError("rate_limited", "Too many requests.", {
        retryable: true,
      }),
    }),
  });
  const limited = await fails(
    readFailure,
    ["access", "ssh", "status", "--env", "env-1"],
    "rate_limited",
    4,
  );
  assert.equal(limited.retryable, true);
});
