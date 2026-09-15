// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract test for `hosting wp`, `hosting wp-cli`, `hosting logs` and
 * `hosting analytics` (`src/cli/hosting/wp.ts`).
 *
 * Everything runs offline: the provider is a recording fake implementing
 * `ProviderClient`; remote source validation goes through the handlers'
 * injected `fetch` seam or to a loopback `node:http` server.
 *
 * `program.ts` is not ours to edit during Phase 4, so the grammar is exercised
 * by registering it onto a throwaway program that carries the same globals the
 * assembled program will.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Command } from "commander";

import {
  createWpHandlers,
  registerWpCommands,
} from "../dist/cli/hosting/wp.js";
import { createRenderer } from "../dist/output/render.js";
import { NOVAMIRA_DOWNLOAD_URL } from "../dist/provisioning/plugin.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** An offline `CommandIo`: no real stdin, no real filesystem, no env. */
function fakeIo({ env = {}, stdin = "", files = {} } = {}) {
  return {
    env,
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
    async writePrivateFile() {
      throw new Error("no command in this group writes a file");
    },
  };
}

/**
 * A recording `ProviderClient`. `read`/`action` answers come from queues keyed
 * by request kind (or, for WP-CLI, by the exact command line) so a test can
 * script a multi-step install without any ordering guesswork.
 */
function fakeClient({
  reads = {},
  actions = {},
  wpCli = {},
  operations = {},
  observable,
} = {}) {
  const client = {
    provider: "kinsta",
    readRequests: [],
    actionRequests: [],
    operationIds: [],

    async validate() {
      throw new Error("not used");
    },
    async listSites() {
      throw new Error("not used");
    },
    async getSite() {
      throw new Error("not used");
    },
    async listEnvironments() {
      throw new Error("not used");
    },

    async read(request) {
      client.readRequests.push(request);
      if (!Object.hasOwn(reads, request.kind))
        throw new Error(`unexpected read ${request.kind}`);
      return reads[request.kind];
    },

    async action(request) {
      client.actionRequests.push(request);
      if (request.kind === "run-wp-cli") {
        const command = request.body?.wp_command;
        if (Object.hasOwn(wpCli, command)) return wpCli[command];
        if (Object.hasOwn(actions, request.kind)) return actions[request.kind];
        throw new Error(`unexpected wp-cli command ${JSON.stringify(command)}`);
      }
      if (!Object.hasOwn(actions, request.kind))
        throw new Error(`unexpected action ${request.kind}`);
      return actions[request.kind];
    },

    async operationStatus(operationId) {
      client.operationIds.push(operationId);
      if (!Object.hasOwn(operations, operationId))
        throw new Error(`unknown operation ${operationId}`);
      return operations[operationId];
    },
  };
  if (observable !== undefined)
    client.wpCliResultsObservable = () => observable;
  return client;
}

function actionResult(overrides = {}) {
  return {
    provider: "kinsta",
    action: "wp-cli.run",
    status: 202,
    raw: null,
    ...overrides,
  };
}

function operationStatus(operationId, overrides = {}) {
  return {
    provider: "kinsta",
    operationId,
    status: 200,
    done: true,
    failed: false,
    raw: null,
    ...overrides,
  };
}

/**
 * Build a throwaway program carrying the globals `program.ts` will carry, with
 * this group registered under `hosting`. Returns a `run(argv)` that renders the
 * failure envelope the same way `main.ts` does, so both branches are covered.
 */
function harness({ client, io = fakeIo(), overrides = {} } = {}) {
  const chunks = { out: [], err: [] };
  const renderer = createRenderer(
    { json: true, requestId: "req-1" },
    {
      stdout: { write: (chunk) => chunks.out.push(chunk) },
      stderr: { write: (chunk) => chunks.err.push(chunk) },
    },
  );

  const dependencies = {
    version: "0.0.0-test",
    paths: {},
    store: {
      async selectHostingProfile(requested) {
        const { CliError } = await import("../dist/errors.js");
        if (requested === undefined || requested === "")
          throw new CliError(
            "usage_error",
            "Select a hosting profile with --profile.",
            { details: { profiles: ["prod"] } },
          );
        if (requested !== "prod")
          throw new CliError("profile_not_found", `No profile ${requested}.`);
        return { name: "prod", profile: { provider: "kinsta" } };
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

  const program = new Command();
  program
    .name("novamira-hq")
    .exitOverride()
    .option("--json", "emit exactly one JSON value on stdout", false)
    .option("--quiet", "suppress nonessential diagnostics", false)
    .option("--verbose", "emit redacted diagnostics", false)
    .option("--no-color", "disable ANSI color")
    .option("--yes", "approve destructive operations", false)
    .option("--profile <name>", "hosting profile");

  const optionsFor = (values) => {
    const active =
      values.findLast((value) => value instanceof Command) ?? program;
    return { ...active.optsWithGlobals(), timeoutExplicit: false };
  };

  const hosting = program.command("hosting").description("hosting operations");
  registerWpCommands(
    hosting,
    createWpHandlers(dependencies, overrides),
    optionsFor,
  );

  return {
    program,
    hosting,
    chunks,
    /** Parse and run, returning the parsed envelope plus the raised error. */
    async run(argv) {
      chunks.out.length = 0;
      chunks.err.length = 0;
      let error;
      try {
        await program.parseAsync(
          ["--json", "--profile", "prod", "hosting", ...argv],
          { from: "user" },
        );
      } catch (caught) {
        error = caught;
        // `main.ts` renders exactly one envelope for a failed invocation.
        renderer.failure(caught);
      }
      const envelope = JSON.parse(chunks.out.join(""));
      return { envelope, error };
    },
  };
}

/**
 * The grammar alone: handlers that record what commander handed them, so option
 * defaults can be asserted where they matter — at the handler boundary — without
 * running a command body.
 */
function grammarHarness() {
  const calls = [];
  const handlers = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        async (...args) => {
          calls.push({ name, args });
        },
    },
  );

  const program = new Command();
  program
    .name("novamira-hq")
    .exitOverride()
    .option("--json", "emit exactly one JSON value on stdout", false)
    .option("--profile <name>", "hosting profile");

  const optionsFor = (values) => {
    const active =
      values.findLast((value) => value instanceof Command) ?? program;
    return { ...active.optsWithGlobals(), timeoutExplicit: false };
  };

  registerWpCommands(program.command("hosting"), handlers, optionsFor);

  return {
    calls,
    async parse(argv, globals = []) {
      await program.parseAsync([...globals, "hosting", ...argv], {
        from: "user",
      });
    },
  };
}

/** Find a registered command by its space-separated path below `hosting`. */
function findCommand(hosting, path) {
  let current = hosting;
  for (const name of path.split(" ")) {
    current = current.commands.find((command) => command.name() === name);
    assert.ok(current, `missing command: ${path}`);
  }
  return current;
}

function longFlags(command) {
  return command.options.map((option) => option.long);
}

/** Serve one loopback response per request, recording what was asked for. */
async function withServer(handler, body) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await body({ base, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

test("the group registers exactly the Go command tree", () => {
  const { hosting } = harness({ client: fakeClient() });

  assert.deepEqual(
    hosting.commands.map((command) => command.name()),
    ["wp", "wp-cli", "logs", "analytics"],
  );
  assert.deepEqual(
    findCommand(hosting, "wp").commands.map((command) => command.name()),
    ["plugins", "themes"],
  );
  // Go only builds `install` for the plugins asset.
  assert.deepEqual(
    findCommand(hosting, "wp plugins").commands.map((command) =>
      command.name(),
    ),
    ["list", "install", "update", "update-all"],
  );
  assert.deepEqual(
    findCommand(hosting, "wp themes").commands.map((command) => command.name()),
    ["list", "update", "update-all"],
  );
  assert.deepEqual(
    findCommand(hosting, "wp-cli").commands.map((command) => command.name()),
    ["run"],
  );
  assert.deepEqual(
    findCommand(hosting, "logs").commands.map((command) => command.name()),
    ["get"],
  );
  assert.deepEqual(
    findCommand(hosting, "analytics").commands.map((command) => command.name()),
    ["usage", "env"],
  );
});

test("every command declares the flags and defaults cobra declared", () => {
  const { hosting } = harness({ client: fakeClient() });

  assert.deepEqual(longFlags(findCommand(hosting, "wp plugins list")), [
    "--env",
    "--company",
  ]);
  assert.deepEqual(longFlags(findCommand(hosting, "wp themes update")), [
    "--env",
    "--name",
    "--update-version",
    "--from-json",
  ]);
  assert.deepEqual(longFlags(findCommand(hosting, "wp themes update-all")), [
    "--env",
    "--name",
    "--from-json",
  ]);
  assert.deepEqual(longFlags(findCommand(hosting, "wp plugins install")), [
    "--env",
    "--source",
    "--plugin-version",
    "--force",
    "--activate",
    "--no-activate",
    "--activate-network",
    "--ignore-requirements",
    "--command-id",
    "--preflight",
    "--no-preflight",
    "--validate-source",
    "--no-validate-source",
    "--wait",
    "--no-wait",
    "--from-json",
    "--interval-seconds",
    "--timeout-seconds",
  ]);
  assert.deepEqual(longFlags(findCommand(hosting, "wp-cli run")), [
    "--env",
    "--command",
    "--command-stdin",
    "--from-json",
  ]);
  assert.deepEqual(longFlags(findCommand(hosting, "logs get")), [
    "--env",
    "--file",
    "--lines",
  ]);
  assert.deepEqual(longFlags(findCommand(hosting, "analytics usage")), [
    "--site",
    "--metric",
  ]);
  assert.deepEqual(longFlags(findCommand(hosting, "analytics env")), [
    "--env",
    "--metric",
    "--time-span",
    "--company",
    "--from",
    "--to",
    "--time-zone",
  ]);

  // No command in this group accepts a secret-valued option.
  for (const path of [
    "wp plugins list",
    "wp plugins install",
    "wp plugins update",
    "wp plugins update-all",
    "wp themes list",
    "wp themes update",
    "wp themes update-all",
    "wp-cli run",
    "logs get",
    "analytics usage",
    "analytics env",
  ]) {
    for (const flag of longFlags(findCommand(hosting, path))) {
      assert.equal(/password|token|secret|key$/i.test(flag), false, flag);
    }
  }
});

test("the options that reach a handler carry cobra's defaults", async () => {
  const { calls, parse } = grammarHarness();

  await parse(["wp", "plugins", "install"]);
  assert.equal(calls.at(-1).name, "wpPluginInstall");
  assert.deepEqual(calls.at(-1).args[0], {
    force: false,
    activate: true,
    activateNetwork: false,
    ignoreRequirements: false,
    commandId: 0,
    preflight: true,
    validateSource: true,
    wait: true,
    intervalSeconds: 5,
    timeoutSeconds: 300,
  });

  await parse([
    "wp",
    "plugins",
    "install",
    "--no-activate",
    "--no-wait",
    "--no-preflight",
    "--no-validate-source",
    "--interval-seconds",
    "2",
    "--timeout-seconds",
    "9",
  ]);
  assert.deepEqual(calls.at(-1).args[0], {
    force: false,
    activate: false,
    activateNetwork: false,
    ignoreRequirements: false,
    commandId: 0,
    preflight: false,
    validateSource: false,
    wait: false,
    intervalSeconds: 2,
    timeoutSeconds: 9,
  });

  await parse(["logs", "get"]);
  assert.deepEqual(calls.at(-1).args[0], { file: "error", lines: 1000 });
  await parse(["logs", "get", "--lines", "25"]);
  assert.equal(calls.at(-1).args[0].lines, 25);

  await parse(["analytics", "env"]);
  assert.deepEqual(calls.at(-1).args[0], { timeSpan: "7_days" });

  await parse(["wp-cli", "run"]);
  assert.deepEqual(calls.at(-1).args[0], { commandStdin: false });

  // A repeatable --name accumulates rather than replacing, as StringArrayVar did.
  await parse(["wp", "themes", "update-all", "--name", "a", "--name", "b"]);
  assert.equal(calls.at(-1).name, "wpAssetUpdateAll");
  assert.equal(calls.at(-1).args[0], "themes");
  assert.deepEqual(calls.at(-1).args[1].name, ["a", "b"]);

  // The asset argument reaches the shared handler for both families.
  await parse(["wp", "plugins", "list", "--company"]);
  assert.equal(calls.at(-1).name, "wpAssetList");
  assert.deepEqual(calls.at(-1).args.slice(0, 2), [
    "plugins",
    { company: true },
  ]);

  // The globals still resolve through the program, not the subcommand.
  await parse(["logs", "get"], ["--json", "--profile", "prod"]);
  assert.equal(calls.at(-1).args.at(-1).json, true);
  assert.equal(calls.at(-1).args.at(-1).profile, "prod");
});

test("an unsigned flag rejects a non-integer at parse time", async () => {
  const client = fakeClient();
  const { run } = harness({ client });
  const { error } = await run([
    "logs",
    "get",
    "--env",
    "env-1",
    "--lines",
    "many",
  ]);
  // Commander raises before any handler runs; `main.ts` maps this onto
  // usage_error and exit 2.
  assert.equal(error.code, "commander.invalidArgument");
  assert.match(error.message, /non-negative integer/);
  assert.deepEqual(client.readRequests, []);
});

/* -------------------------------------------------------------------------- */
/* wp plugins|themes list                                                     */
/* -------------------------------------------------------------------------- */

test("wp list dispatches the environment or company read per asset", async () => {
  for (const [asset, envKind, companyKind] of [
    ["plugins", "plugins", "company-plugins"],
    ["themes", "themes", "company-themes"],
  ]) {
    const client = fakeClient({
      reads: { [envKind]: [{ name: "hello" }], [companyKind]: [] },
    });
    const { run } = harness({ client });

    const first = await run(["wp", asset, "list", "--env", "env-1"]);
    assert.deepEqual(client.readRequests.at(-1), {
      kind: envKind,
      envId: "env-1",
    });
    assert.equal(first.envelope.ok, true);
    assert.deepEqual(first.envelope.data, [{ name: "hello" }]);
    assert.deepEqual(first.envelope.meta, {
      requestId: "req-1",
      profile: "prod",
      provider: "kinsta",
    });

    await run(["wp", asset, "list", "--company"]);
    // Go passes CompanyID: nil, so the profile's company is left to the client.
    assert.deepEqual(client.readRequests.at(-1), { kind: companyKind });
  }
});

test("wp list without --env is a usage_error naming the flag", async () => {
  const client = fakeClient();
  const { run } = harness({ client });
  const { envelope, error } = await run(["wp", "plugins", "list"]);

  assert.equal(error.code, "usage_error");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "usage_error");
  assert.match(envelope.error.message, /--env is required/);
  assert.deepEqual(envelope.error.details, { flag: "--env" });
  assert.deepEqual(client.readRequests, []);
});

/* -------------------------------------------------------------------------- */
/* wp plugins|themes update / update-all                                      */
/* -------------------------------------------------------------------------- */

test("wp update dispatches the per-asset action with the Go body", async () => {
  for (const [asset, kind] of [
    ["plugins", "update-plugin"],
    ["themes", "update-theme"],
  ]) {
    const client = fakeClient({
      actions: { [kind]: actionResult({ action: `${asset}.update` }) },
    });
    const { run } = harness({ client });
    const { envelope } = await run([
      "wp",
      asset,
      "update",
      "--env",
      "env-1",
      "--name",
      "hello-dolly",
      "--update-version",
      "1.7.2",
    ]);

    assert.deepEqual(client.actionRequests.at(-1), {
      kind,
      envId: "env-1",
      body: { name: "hello-dolly", update_version: "1.7.2" },
    });
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.action, `${asset}.update`);
    assert.equal(envelope.data.status, 202);
  }
});

test("wp update-all dispatches the bulk action keyed by asset", async () => {
  for (const [asset, kind] of [
    ["plugins", "bulk-update-plugins"],
    ["themes", "bulk-update-themes"],
  ]) {
    const client = fakeClient({ actions: { [kind]: actionResult() } });
    const { run } = harness({ client });
    await run([
      "wp",
      asset,
      "update-all",
      "--env",
      "env-1",
      "--name",
      "one",
      "--name",
      "two",
    ]);

    assert.deepEqual(client.actionRequests.at(-1), {
      kind,
      envId: "env-1",
      body: { [asset]: [{ name: "one" }, { name: "two" }] },
    });
  }
});

test("wp update reports a missing --name as usage_error and --from-json wins", async () => {
  const client = fakeClient({ actions: { "update-plugin": actionResult() } });
  const io = fakeIo({ files: { "/body.json": '{"name":"from-file"}' } });
  const { run } = harness({ client, io });

  const failure = await run(["wp", "plugins", "update", "--env", "env-1"]);
  assert.equal(failure.envelope.error.code, "usage_error");
  assert.deepEqual(failure.envelope.error.details, { flag: "--name" });
  assert.deepEqual(client.actionRequests, []);

  await run([
    "wp",
    "plugins",
    "update",
    "--env",
    "env-1",
    "--from-json",
    "/body.json",
  ]);
  assert.deepEqual(client.actionRequests.at(-1).body, { name: "from-file" });
});

/* -------------------------------------------------------------------------- */
/* wp plugins install                                                         */
/* -------------------------------------------------------------------------- */

test("install builds a quoted wp-cli command and waits for the operation", async () => {
  const client = fakeClient({
    wpCli: {
      "wp option get siteurl": actionResult({ operationId: "op-preflight" }),
      "wp plugin install hello-dolly --version=1.7.2 --force": actionResult({
        operationId: "op-install",
      }),
      "wp plugin status hello-dolly": actionResult({
        operationId: "op-status",
      }),
    },
    operations: {
      "op-preflight": operationStatus("op-preflight"),
      "op-install": operationStatus("op-install", { status: 201 }),
      "op-status": operationStatus("op-status", {
        raw: { data: { result: "Status: Active" } },
      }),
    },
  });
  const { run } = harness({ client });
  const { envelope } = await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--source",
    "hello-dolly",
    "--plugin-version",
    "1.7.2",
    "--force",
  ]);

  const commands = client.actionRequests.map(
    (request) => request.body.wp_command,
  );
  // Preflight first, then the install with activation deferred out of it, then
  // the status probe that finds the plugin already active.
  assert.deepEqual(commands, [
    "wp option get siteurl",
    "wp plugin install hello-dolly --version=1.7.2 --force",
    "wp plugin status hello-dolly",
  ]);
  assert.deepEqual(
    client.actionRequests.map((request) => request.kind),
    ["run-wp-cli", "run-wp-cli", "run-wp-cli"],
  );
  assert.equal(client.actionRequests[1].envId, "env-1");
  // The install operation is what gets reported: no activation was needed.
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.operation_id, "op-install");
  assert.equal(envelope.data.done, true);
});

test("install activates in a second command when the plugin is not active yet", async () => {
  const client = fakeClient({
    wpCli: {
      "wp option get siteurl": actionResult({ operationId: "op-preflight" }),
      "wp plugin install novamira": actionResult({ operationId: "op-install" }),
      "wp plugin status novamira": actionResult({ operationId: "op-status" }),
      "wp plugin activate novamira": actionResult({
        operationId: "op-activate",
      }),
    },
    operations: {
      "op-preflight": operationStatus("op-preflight"),
      "op-install": operationStatus("op-install"),
      "op-status": operationStatus("op-status", {
        raw: { data: { result: "Status: Inactive" } },
      }),
      "op-activate": operationStatus("op-activate", {
        message: "Plugin activated.",
      }),
    },
  });
  const { run } = harness({ client });
  const { envelope } = await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.deepEqual(
    client.actionRequests.map((request) => request.body.wp_command),
    [
      "wp option get siteurl",
      // --activate is stripped from the install because HQ will do it itself.
      "wp plugin install novamira",
      "wp plugin status novamira",
      "wp plugin activate novamira",
    ],
  );
  // The activation operation replaces the install's in the reported envelope.
  assert.equal(envelope.data.operation_id, "op-activate");
  assert.equal(envelope.data.message, "Plugin activated.");
});

test("install keeps --activate inline when WP-CLI results are not observable", async () => {
  const client = fakeClient({
    observable: false,
    wpCli: {
      "wp plugin install novamira --activate": actionResult({
        operationId: "op-install",
      }),
    },
    operations: { "op-install": operationStatus("op-install") },
  });
  const { run } = harness({ client });
  await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  // No preflight and no follow-up activation: HQ cannot read the results.
  assert.deepEqual(
    client.actionRequests.map((request) => request.body.wp_command),
    ["wp plugin install novamira --activate"],
  );
});

test("--activate-network wins over --activate and drives a network activation", async () => {
  const client = fakeClient({
    observable: false,
    wpCli: {
      "wp plugin install novamira --activate-network": actionResult({
        operationId: "op-install",
      }),
    },
    operations: { "op-install": operationStatus("op-install") },
  });
  const { run } = harness({ client });
  await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--activate-network",
    "--ignore-requirements",
  ]);
  assert.equal(
    client.actionRequests[0].body.wp_command,
    "wp plugin install novamira --ignore-requirements --activate-network",
  );
});

test("--no-activate installs without activating and never probes status", async () => {
  const client = fakeClient({
    wpCli: {
      "wp option get siteurl": actionResult({ operationId: "op-preflight" }),
      "wp plugin install novamira": actionResult({ operationId: "op-install" }),
    },
    operations: {
      "op-preflight": operationStatus("op-preflight"),
      "op-install": operationStatus("op-install"),
    },
  });
  const { run } = harness({ client });
  await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--no-activate",
  ]);
  assert.deepEqual(
    client.actionRequests.map((request) => request.body.wp_command),
    ["wp option get siteurl", "wp plugin install novamira"],
  );
});

test("--no-wait renders the action instead of an operation", async () => {
  const client = fakeClient({
    observable: false,
    wpCli: {
      "wp plugin install novamira --activate": actionResult({
        operationId: "op-install",
        status: 202,
        message: "queued",
      }),
    },
  });
  const { run } = harness({ client });
  const { envelope } = await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--no-wait",
  ]);

  assert.deepEqual(client.operationIds, []);
  assert.equal(envelope.data.action, "wp-cli.run");
  assert.equal(envelope.data.operation_id, "op-install");
  assert.equal(envelope.data.message, "queued");
});

test("--command-id sends the saved command and skips preflight and activation", async () => {
  const client = fakeClient({
    actions: { "run-wp-cli": actionResult({ operationId: "op-install" }) },
    operations: { "op-install": operationStatus("op-install") },
  });
  const { run } = harness({ client });
  await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--command-id",
    "42",
  ]);

  assert.deepEqual(
    client.actionRequests.map((request) => request.body),
    [{ command_id: 42 }],
  );
});

test("--from-json is sent verbatim and disables the preflight and activation", async () => {
  const io = fakeIo({
    stdin: '{"wp_command":"wp plugin list","command_id":9}',
  });
  const client = fakeClient({
    actions: { "run-wp-cli": actionResult({ operationId: "op-install" }) },
    operations: { "op-install": operationStatus("op-install") },
  });
  const { run } = harness({ client, io });
  await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--from-json",
    "-",
    "--source",
    "novamira",
  ]);

  // A command_id alongside wp_command means the preflight does not apply.
  assert.deepEqual(
    client.actionRequests.map((request) => request.body),
    [{ wp_command: "wp plugin list", command_id: 9 }],
  );
});

test("a failed install operation is a provider_error envelope", async () => {
  const client = fakeClient({
    observable: false,
    wpCli: {
      "wp plugin install novamira --activate": actionResult({
        operationId: "op-install",
      }),
    },
    operations: {
      "op-install": operationStatus("op-install", {
        status: 500,
        done: false,
        failed: true,
        message: "install failed",
      }),
    },
  });
  const { run } = harness({ client });
  const { envelope, error } = await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(error.code, "provider_error");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "provider_error");
  assert.match(envelope.error.message, /op-install failed: install failed/);
});

test("a failed preflight carries the DB_HOST localhost hint", async () => {
  const client = fakeClient({
    wpCli: {
      "wp option get siteurl": actionResult({ operationId: "op-siteurl" }),
      "wp config get DB_HOST": actionResult({ operationId: "op-dbhost" }),
    },
    operations: {
      "op-siteurl": operationStatus("op-siteurl", {
        status: 500,
        done: true,
        failed: true,
        message: "Operation failed",
        raw: { data: { message: "Server Error" } },
      }),
      "op-dbhost": operationStatus("op-dbhost", {
        raw: { data: { result: "localhost\n" } },
      }),
    },
  });
  const { run } = harness({ client });
  const { envelope } = await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "provider_error");
  assert.match(
    envelope.error.message,
    /WP-CLI preflight failed before plugin install: Operation failed; DB_HOST is localhost/,
  );
  // The install itself was never dispatched.
  assert.deepEqual(
    client.actionRequests.map((request) => request.body.wp_command),
    ["wp option get siteurl", "wp config get DB_HOST"],
  );
});

test("install refuses a source that cannot be safely quoted", async () => {
  const client = fakeClient({ observable: false });
  const { run } = harness({ client });
  const { envelope } = await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--source",
    "hello; rm -rf /",
  ]);

  assert.equal(envelope.error.code, "usage_error");
  // The rejected value is never echoed back.
  assert.equal(envelope.error.message.includes("rm -rf"), false);
  assert.deepEqual(client.actionRequests, []);
});

test("install without --env is a usage_error before any provider call", async () => {
  const client = fakeClient();
  const { run } = harness({ client });
  const { envelope } = await run([
    "wp",
    "plugins",
    "install",
    "--source",
    "novamira",
  ]);
  assert.equal(envelope.error.code, "usage_error");
  assert.deepEqual(envelope.error.details, { flag: "--env" });
  assert.deepEqual(client.actionRequests, []);
});

test("an exhausted polling budget is a retryable timeout", async () => {
  const client = fakeClient({
    observable: false,
    wpCli: {
      "wp plugin install novamira --activate": actionResult({
        operationId: "op-install",
      }),
    },
    operations: {
      "op-install": operationStatus("op-install", { done: false }),
    },
  });
  const { run } = harness({ client });
  const { envelope } = await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--timeout-seconds",
    "0",
  ]);

  assert.equal(envelope.error.code, "timeout");
  assert.equal(envelope.error.retryable, true);
  assert.equal(envelope.error.details.operationId, "op-install");
});

/* -------------------------------------------------------------------------- */
/* wp plugins install: --source resolution and validation                     */
/* -------------------------------------------------------------------------- */

test("--source novamira-latest uses only the canonical download endpoint", async () => {
  const requests = [];
  const client = fakeClient({
    observable: false,
    wpCli: {
      [`wp plugin install ${NOVAMIRA_DOWNLOAD_URL} --activate`]: actionResult({
        operationId: "op-install",
      }),
    },
    operations: { "op-install": operationStatus("op-install") },
  });
  const { run } = harness({
    client,
    overrides: {
      fetch: async (url, init = {}) => {
        requests.push({ method: init.method ?? "GET", url });
        return new Response("", { status: 405, headers: { allow: "GET" } });
      },
    },
  });

  const { envelope } = await run([
    "wp",
    "plugins",
    "install",
    "--env",
    "env-1",
    "--source",
    "novamira-latest",
  ]);

  assert.equal(envelope.ok, true);
  assert.equal(
    client.actionRequests[0].body.wp_command,
    `wp plugin install ${NOVAMIRA_DOWNLOAD_URL} --activate`,
  );
  assert.deepEqual(requests, [{ method: "HEAD", url: NOVAMIRA_DOWNLOAD_URL }]);
});

test("--validate-source rejects a remote zip the host will not serve", async () => {
  await withServer(
    (request, response) => {
      response.writeHead(404).end();
    },
    async ({ base, requests }) => {
      const client = fakeClient();
      const { run } = harness({ client });
      const { envelope } = await run([
        "wp",
        "plugins",
        "install",
        "--env",
        "env-1",
        "--source",
        `${base}/missing.zip`,
      ]);

      assert.equal(envelope.error.code, "not_found");
      assert.match(envelope.error.message, /HTTP 404/);
      assert.deepEqual(requests, [{ method: "HEAD", url: "/missing.zip" }]);
      assert.deepEqual(client.actionRequests, []);
    },
  );
});

test("--no-validate-source skips the HEAD check entirely", async () => {
  await withServer(
    (request, response) => {
      response.writeHead(404).end();
    },
    async ({ base, requests }) => {
      const source = `${base}/novamira.zip`;
      const client = fakeClient({
        observable: false,
        wpCli: {
          [`wp plugin install ${source} --activate`]: actionResult({
            operationId: "op-install",
          }),
        },
        operations: { "op-install": operationStatus("op-install") },
      });
      const { run } = harness({ client });
      const { envelope } = await run([
        "wp",
        "plugins",
        "install",
        "--env",
        "env-1",
        "--source",
        source,
        "--no-validate-source",
      ]);

      assert.equal(envelope.ok, true);
      assert.deepEqual(requests, []);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* wp-cli run                                                                 */
/* -------------------------------------------------------------------------- */

test("wp-cli run sends the command from --command, stdin or --from-json", async () => {
  const client = fakeClient({
    actions: { "run-wp-cli": actionResult({ action: "wp-cli.run" }) },
  });
  const io = fakeIo({
    stdin: "wp option get siteurl\n",
    files: { "/body.json": '{"wp_command":"wp core version"}' },
  });
  const { run } = harness({ client, io });

  await run([
    "wp-cli",
    "run",
    "--env",
    "env-1",
    "--command",
    "wp plugin list --format=json",
  ]);
  assert.deepEqual(client.actionRequests.at(-1), {
    kind: "run-wp-cli",
    envId: "env-1",
    body: { wp_command: "wp plugin list --format=json" },
  });

  await run(["wp-cli", "run", "--env", "env-1", "--command-stdin"]);
  assert.deepEqual(client.actionRequests.at(-1).body, {
    wp_command: "wp option get siteurl",
  });

  await run(["wp-cli", "run", "--env", "env-1", "--from-json", "/body.json"]);
  assert.deepEqual(client.actionRequests.at(-1).body, {
    wp_command: "wp core version",
  });
});

test("wp-cli run without a command is a usage_error", async () => {
  const client = fakeClient();
  const { run } = harness({ client });
  const { envelope } = await run(["wp-cli", "run", "--env", "env-1"]);
  assert.equal(envelope.error.code, "usage_error");
  assert.deepEqual(envelope.error.details, { flag: "--command" });
  assert.deepEqual(client.actionRequests, []);
});

/* -------------------------------------------------------------------------- */
/* logs get                                                                   */
/* -------------------------------------------------------------------------- */

test("logs get reads the requested file with the Go defaults", async () => {
  const client = fakeClient({ reads: { logs: { lines: ["boom"] } } });
  const { run } = harness({ client });

  const { envelope } = await run(["logs", "get", "--env", "env-1"]);
  assert.deepEqual(client.readRequests.at(-1), {
    kind: "logs",
    envId: "env-1",
    fileName: "error",
    lines: 1000,
  });
  assert.deepEqual(envelope.data, { lines: ["boom"] });

  for (const file of ["error", "access", "kinsta-cache-perf"]) {
    await run([
      "logs",
      "get",
      "--env",
      "env-1",
      "--file",
      file,
      "--lines",
      "5",
    ]);
    assert.deepEqual(client.readRequests.at(-1), {
      kind: "logs",
      envId: "env-1",
      fileName: file,
      lines: 5,
    });
  }
});

test("logs get rejects an unknown --file with the allowed set", async () => {
  const client = fakeClient();
  const { run } = harness({ client });
  const { envelope } = await run([
    "logs",
    "get",
    "--env",
    "env-1",
    "--file",
    "slowlog",
  ]);

  assert.equal(envelope.error.code, "usage_error");
  assert.match(envelope.error.message, /Invalid value "slowlog" for --file\./);
  assert.deepEqual(envelope.error.details, {
    flag: "--file",
    allowed: ["error", "access", "kinsta-cache-perf"],
  });
  assert.deepEqual(client.readRequests, []);
});

/* -------------------------------------------------------------------------- */
/* analytics                                                                  */
/* -------------------------------------------------------------------------- */

test("analytics usage passes the site and validates a non-empty metric", async () => {
  const client = fakeClient({ reads: { "analytics-usage": { visits: 1 } } });
  const { run } = harness({ client });

  await run(["analytics", "usage", "--site", "site-1"]);
  assert.deepEqual(client.readRequests.at(-1), {
    kind: "analytics-usage",
    siteId: "site-1",
    metric: "",
  });

  await run([
    "analytics",
    "usage",
    "--site",
    "site-1",
    "--metric",
    "cdn-bandwidth",
  ]);
  assert.deepEqual(client.readRequests.at(-1), {
    kind: "analytics-usage",
    siteId: "site-1",
    metric: "cdn-bandwidth",
  });

  const { envelope } = await run([
    "analytics",
    "usage",
    "--site",
    "site-1",
    "--metric",
    "diskspace",
  ]);
  assert.equal(envelope.error.code, "usage_error");
  assert.deepEqual(envelope.error.details, {
    flag: "--metric",
    allowed: ["visits", "bandwidth", "cdn-bandwidth"],
  });
});

test("analytics env builds the ordered query Go's pushQuery built", async () => {
  const client = fakeClient({ reads: { "analytics-env": {} } });
  const { run } = harness({ client });

  await run(["analytics", "env", "--env", "env-1"]);
  assert.deepEqual(client.readRequests.at(-1), {
    kind: "analytics-env",
    envId: "env-1",
    metric: "",
    query: [["time_span", "7_days"]],
  });

  await run([
    "analytics",
    "env",
    "--env",
    "env-1",
    "--metric",
    "visits",
    "--time-span",
    "30_days",
    "--company",
    "co-1",
    "--from",
    "2026-01-01",
    "--to",
    "2026-02-01",
    "--time-zone",
    "+02:00",
  ]);
  assert.deepEqual(client.readRequests.at(-1).query, [
    ["time_span", "30_days"],
    ["company_id", "co-1"],
    ["from", "2026-01-01"],
    ["to", "2026-02-01"],
    ["time_zone", "+02:00"],
  ]);

  // Without --time-zone, only the diskspace metric gets one, and it defaults.
  await run(["analytics", "env", "--env", "env-1", "--metric", "visits"]);
  assert.deepEqual(client.readRequests.at(-1).query, [["time_span", "7_days"]]);

  await run(["analytics", "env", "--env", "env-1", "--metric", "diskspace"]);
  assert.deepEqual(client.readRequests.at(-1).query, [
    ["time_span", "7_days"],
    ["time_zone", "00:00"],
  ]);

  await run([
    "analytics",
    "env",
    "--env",
    "env-1",
    "--metric",
    "diskspace",
    "--time-zone",
    "-05:00",
  ]);
  assert.deepEqual(client.readRequests.at(-1).query, [
    ["time_span", "7_days"],
    ["time_zone", "-05:00"],
  ]);
});

test("analytics env rejects a metric outside the Kinsta set", async () => {
  const client = fakeClient();
  const { run } = harness({ client });
  const { envelope } = await run([
    "analytics",
    "env",
    "--env",
    "env-1",
    "--metric",
    "uptime",
  ]);
  assert.equal(envelope.error.code, "usage_error");
  assert.equal(envelope.error.details.flag, "--metric");
  assert.equal(
    envelope.error.details.allowed.includes("visits-dispersion"),
    true,
  );
  assert.deepEqual(client.readRequests, []);
});

/* -------------------------------------------------------------------------- */
/* Envelope and profile plumbing                                              */
/* -------------------------------------------------------------------------- */

test("a hosting command in this group never infers a profile", async () => {
  const client = fakeClient({ reads: { plugins: [] } });
  const { program, chunks } = harness({ client });
  let thrown;
  try {
    await program.parseAsync(
      ["--json", "hosting", "wp", "plugins", "list", "--env", "env-1"],
      { from: "user" },
    );
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown.code, "usage_error");
  assert.deepEqual(thrown.details.profiles, ["prod"]);
  assert.deepEqual(chunks.out, []);
  assert.deepEqual(client.readRequests, []);
});
