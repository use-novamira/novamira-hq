// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract test for the `hosting providers` / `regions` / `activity` / `ops`
 * command group (`src/cli/hosting/inventory.ts`).
 *
 * Fully offline: the provider is a hand-written fake `ProviderClient` that
 * records every request it is handed, and the renderer writes into arrays. The
 * group is exercised through its own `registerHostingInventoryCommands` on a
 * throwaway `Command`, because `program.ts` does not wire it up until the Phase
 * 4 integration step.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Command, CommanderError } from "commander";
import {
  createHostingInventoryHandlers,
  registerHostingInventoryCommands,
} from "../dist/cli/hosting/inventory.js";
import { createRenderer } from "../dist/output/render.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

const GLOBALS = {
  json: true,
  quiet: false,
  verbose: false,
  color: false,
  yes: false,
  timeout: 30_000,
  timeoutExplicit: false,
};

/**
 * A fake `ProviderClient`. Every method records its request and returns a
 * canned response; nothing here can reach a network.
 */
function fakeClient({
  validation,
  read,
  operationStatuses = [],
  provider = "kinsta",
} = {}) {
  const calls = { read: [], validate: 0, operationStatus: [] };
  let statusIndex = 0;
  return {
    calls,
    client: {
      provider,
      async validate() {
        calls.validate += 1;
        return (
          validation ?? {
            provider,
            status: "ok",
            companyId: null,
            credential: "env:KINSTA_API_KEY",
          }
        );
      },
      async read(request) {
        calls.read.push(request);
        return typeof read === "function" ? read(request) : read;
      },
      async operationStatus(operationId) {
        calls.operationStatus.push(operationId);
        const canned =
          operationStatuses[
            Math.min(statusIndex, operationStatuses.length - 1)
          ];
        statusIndex += 1;
        return {
          provider,
          operationId,
          status: 200,
          done: true,
          failed: false,
          raw: null,
          ...canned,
        };
      },
      async action() {
        throw new Error("this group must never dispatch a mutating action");
      },
    },
  };
}

/**
 * Build the program fragment plus the dependencies its handlers run against.
 * `profiles` maps a `--profile` name onto a stored hosting profile; `profile`
 * is the name every invocation passes, or `null` to omit `--profile` entirely.
 */
function harness({
  client,
  profiles = { prod: { provider: "kinsta" } },
  profile = "prod",
} = {}) {
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
        if (requested === undefined || requested === "") {
          throw new CliError(
            "usage_error",
            "Select a hosting profile with --profile.",
            { details: { profiles: Object.keys(profiles) } },
          );
        }
        const found = profiles[requested];
        if (found === undefined) {
          throw new CliError("profile_not_found", `No profile ${requested}.`);
        }
        return { name: requested, profile: found };
      },
    },
    hosting: {
      async clientFromEntry() {
        return client;
      },
    },
    io: {
      env: {},
      async readStdin() {
        throw new Error("this group never reads stdin");
      },
      async readFile() {
        throw new Error("this group never reads files");
      },
      async writePrivateFile() {
        throw new Error("this group never writes files");
      },
    },
    rendererFor: () => renderer,
  };

  const handlers = createHostingInventoryHandlers(dependencies);
  const program = new Command();
  program
    .name("novamira-hq")
    .exitOverride()
    // Commander still writes its own usage text before throwing; swallow it so
    // the test output stays readable.
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const hosting = program.command("hosting").description("hosting operations");

  // `--profile` is a global in the real program; the throwaway root carries it
  // so `optionsFor` can find it through `optsWithGlobals`.
  program.option("--profile <name>", "hosting profile");

  const optionsFor = (values) => {
    const active =
      values.findLast((value) => value instanceof Command) ?? program;
    return { ...GLOBALS, ...active.optsWithGlobals() };
  };

  registerHostingInventoryCommands(hosting, handlers, optionsFor);

  return {
    chunks,
    hosting,
    program,
    async run(argv) {
      const args = profile === null ? argv : ["--profile", profile, ...argv];
      chunks.out.length = 0;
      await program.parseAsync(args, { from: "user" });
      return JSON.parse(chunks.out.join(""));
    },
    async failure(argv) {
      const args = profile === null ? argv : ["--profile", profile, ...argv];
      chunks.out.length = 0;
      let thrown;
      await assert.rejects(
        () => program.parseAsync(args, { from: "user" }),
        (error) => {
          thrown = error;
          return true;
        },
      );
      return thrown;
    },
  };
}

function commandNames(command) {
  return command.commands.map((child) => child.name()).sort();
}

function longFlags(command) {
  return command.options.map((option) => option.long);
}

function subcommand(parent, ...path) {
  let current = parent;
  for (const name of path) {
    const found = current.commands.find((child) => child.name() === name);
    assert.ok(found, `missing subcommand ${name}`);
    current = found;
  }
  return current;
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

test("the group registers exactly its four command trees", () => {
  const { hosting } = harness({ client: fakeClient().client });
  assert.deepEqual(commandNames(hosting), [
    "activity",
    "ops",
    "providers",
    "regions",
  ]);
  assert.deepEqual(commandNames(subcommand(hosting, "providers")), [
    "capabilities",
    "validate",
  ]);
  assert.deepEqual(commandNames(subcommand(hosting, "regions")), ["list"]);
  assert.deepEqual(commandNames(subcommand(hosting, "activity")), ["list"]);
  assert.deepEqual(commandNames(subcommand(hosting, "ops")), ["get", "wait"]);
});

test("each subcommand registers exactly the Go flags, and no secret option", () => {
  const { hosting } = harness({ client: fakeClient().client });

  assert.deepEqual(longFlags(subcommand(hosting, "providers", "validate")), []);
  assert.deepEqual(
    longFlags(subcommand(hosting, "providers", "capabilities")),
    [],
  );
  assert.deepEqual(longFlags(subcommand(hosting, "regions", "list")), [
    "--company",
  ]);
  assert.deepEqual(longFlags(subcommand(hosting, "activity", "list")), [
    "--limit",
    "--offset",
    "--category",
    "--site",
    "--initiated-by",
    "--api-key",
    "--language",
    "--company",
  ]);
  assert.deepEqual(longFlags(subcommand(hosting, "ops", "get")), []);
  assert.deepEqual(longFlags(subcommand(hosting, "ops", "wait")), [
    "--interval-seconds",
    "--timeout-seconds",
  ]);

  // `--profile` is a global, never a per-command option (v1 contract).
  for (const path of [
    ["providers", "validate"],
    ["providers", "capabilities"],
    ["regions", "list"],
    ["activity", "list"],
    ["ops", "get"],
    ["ops", "wait"],
  ]) {
    assert.equal(
      longFlags(subcommand(hosting, ...path)).includes("--profile"),
      false,
    );
  }
});

test("both ops subcommands take exactly one required operation id", () => {
  const { hosting } = harness({ client: fakeClient().client });
  for (const name of ["get", "wait"]) {
    const command = subcommand(hosting, "ops", name);
    assert.equal(command.registeredArguments.length, 1);
    assert.equal(command.registeredArguments[0].name(), "operation_id");
    assert.equal(command.registeredArguments[0].required, true);
  }
});

/* -------------------------------------------------------------------------- */
/* providers                                                                  */
/* -------------------------------------------------------------------------- */

test("providers validate renders the validation envelope", async () => {
  const fake = fakeClient({
    validation: {
      provider: "kinsta",
      status: "ok",
      companyId: "co-1",
      credential: "env:KINSTA_API_KEY",
    },
  });
  const run = harness({ client: fake.client });
  const envelope = await run.run(["hosting", "providers", "validate"]);

  assert.equal(fake.calls.validate, 1);
  assert.deepEqual(fake.calls.read, [], "validate must not issue a read");
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data, {
    provider: "kinsta",
    status: "ok",
    company_id: "co-1",
    credential: "env:KINSTA_API_KEY",
  });
  assert.deepEqual(envelope.meta, {
    requestId: "req-1",
    profile: "prod",
    provider: "kinsta",
  });
});

// Ported from TestSiteDeleteCapabilityIsDisabledForCLI, through the command.
test("providers capabilities reads capabilities and disables sites.delete", async () => {
  const fake = fakeClient({
    read: [
      { name: "sites.list", supported: true },
      { name: "sites.delete", supported: true },
    ],
  });
  const envelope = await harness({ client: fake.client }).run([
    "hosting",
    "providers",
    "capabilities",
  ]);

  assert.deepEqual(fake.calls.read, [{ kind: "capabilities" }]);
  assert.equal(envelope.data[0].name, "sites.list");
  assert.equal(envelope.data[0].supported, true);
  assert.equal(envelope.data[1].name, "sites.delete");
  assert.equal(envelope.data[1].supported, false);
  assert.equal(typeof envelope.data[1].notes, "string");
  assert.notEqual(envelope.data[1].notes, "");
});

test("a capabilities response that is not a capability list passes through", async () => {
  const fake = fakeClient({ read: { message: "not a list" } });
  const envelope = await harness({ client: fake.client }).run([
    "hosting",
    "providers",
    "capabilities",
  ]);
  assert.deepEqual(envelope.data, { message: "not a list" });
});

/* -------------------------------------------------------------------------- */
/* regions                                                                    */
/* -------------------------------------------------------------------------- */

test("regions list dispatches a regions read, with and without --company", async () => {
  const fake = fakeClient({ read: [{ id: "eu-west" }] });
  const run = harness({ client: fake.client });

  const envelope = await run.run(["hosting", "regions", "list"]);
  assert.deepEqual(fake.calls.read, [{ kind: "regions" }]);
  assert.equal(
    Object.hasOwn(fake.calls.read[0], "companyId"),
    false,
    "an absent --company must not become an explicit companyId",
  );
  assert.deepEqual(envelope.data, [{ id: "eu-west" }]);

  await run.run(["hosting", "regions", "list", "--company", "co-9"]);
  assert.deepEqual(fake.calls.read[1], { kind: "regions", companyId: "co-9" });

  // Go's optStr: an empty value means "omit", not "send an empty company".
  await run.run(["hosting", "regions", "list", "--company", ""]);
  assert.deepEqual(fake.calls.read[2], { kind: "regions" });
});

/* -------------------------------------------------------------------------- */
/* activity                                                                   */
/* -------------------------------------------------------------------------- */

test("activity list always sends limit and offset, in Go's order", async () => {
  const fake = fakeClient({ read: { entries: [] } });
  const run = harness({ client: fake.client });

  await run.run(["hosting", "activity", "list"]);
  assert.deepEqual(fake.calls.read[0], {
    kind: "activity",
    query: [
      ["limit", "10"],
      ["offset", "0"],
    ],
  });

  await run.run([
    "hosting",
    "activity",
    "list",
    "--limit",
    "50",
    "--offset",
    "25",
    "--category",
    "deployment",
    "--site",
    "site-1",
    "--initiated-by",
    "user-1",
    "--api-key",
    "key-1",
    "--language",
    "en",
    "--company",
    "co-1",
  ]);
  assert.deepEqual(fake.calls.read[1], {
    kind: "activity",
    companyId: "co-1",
    query: [
      ["limit", "50"],
      ["offset", "25"],
      ["category", "deployment"],
      ["site_id", "site-1"],
      ["id_initiated_by", "user-1"],
      ["id_api_key", "key-1"],
      ["language", "en"],
    ],
  });
});

test("activity list rejects a non-integer limit as a usage error", async () => {
  const fake = fakeClient({ read: null });
  const run = harness({ client: fake.client });

  for (const argv of [["--limit=-1"], ["--limit=1.5"], ["--offset=seven"]]) {
    const error = await run.failure(["hosting", "activity", "list", ...argv]);
    // commander's own parse failure; main.ts maps it onto usage_error (exit 2).
    assert.ok(error instanceof CommanderError, error.message);
    assert.equal(error.code, "commander.invalidArgument");
  }
  assert.deepEqual(
    fake.calls.read,
    [],
    "a rejected flag must reach no provider",
  );
});

/* -------------------------------------------------------------------------- */
/* ops                                                                        */
/* -------------------------------------------------------------------------- */

test("ops get reports a single operation status", async () => {
  const fake = fakeClient({
    operationStatuses: [
      { status: 200, done: true, failed: false, message: "finished" },
    ],
  });
  const envelope = await harness({ client: fake.client }).run([
    "hosting",
    "ops",
    "get",
    "op-1",
  ]);
  assert.deepEqual(fake.calls.operationStatus, ["op-1"]);
  assert.deepEqual(envelope.data, {
    provider: "kinsta",
    operation_id: "op-1",
    status: 200,
    done: true,
    failed: false,
    message: "finished",
    raw: null,
  });
});

test("ops get requires the operation id argument", async () => {
  const fake = fakeClient();
  const error = await harness({ client: fake.client }).failure([
    "hosting",
    "ops",
    "get",
  ]);
  assert.ok(error instanceof CommanderError, error.message);
  assert.equal(error.code, "commander.missingArgument");
  assert.deepEqual(fake.calls.operationStatus, []);
});

test("ops wait polls until the operation is done", async () => {
  const fake = fakeClient({
    operationStatuses: [
      { done: false, failed: false },
      { done: true, failed: false },
    ],
  });
  const envelope = await harness({ client: fake.client }).run([
    "hosting",
    "ops",
    "wait",
    "op-2",
    // A one-second interval keeps the single real sleep short and bounded.
    "--interval-seconds",
    "1",
  ]);
  assert.deepEqual(fake.calls.operationStatus, ["op-2", "op-2"]);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.done, true);
  assert.equal(envelope.data.operation_id, "op-2");
});

test("ops wait turns a failed operation into a provider_error envelope", async () => {
  const fake = fakeClient({
    operationStatuses: [
      { status: 500, done: false, failed: true, message: "provider exploded" },
    ],
  });
  const run = harness({ client: fake.client });
  const error = await run.failure(["hosting", "ops", "wait", "op-3"]);
  assert.equal(error.code, "provider_error");
  assert.equal(error.message, "Operation op-3 failed: provider exploded");

  // The failure envelope the renderer would emit for it.
  const { createRenderer: create } = await import("../dist/output/render.js");
  const out = [];
  const code = create(
    { json: true, requestId: "req-1" },
    {
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: () => {} },
    },
  ).failure(error);
  assert.equal(code, 4);
  const envelope = JSON.parse(out.join(""));
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "provider_error");
  assert.equal(envelope.error.retryable, false);
});

test("ops wait times out with a retryable timeout error", async () => {
  const fake = fakeClient({
    operationStatuses: [{ done: false, failed: false }],
  });
  const run = harness({ client: fake.client });
  // A zero budget expires on the first poll, so the loop never sleeps.
  const error = await run.failure([
    "hosting",
    "ops",
    "wait",
    "op-4",
    "--timeout-seconds",
    "0",
  ]);
  assert.equal(error.code, "timeout");
  assert.equal(error.retryable, true);
  assert.equal(error.details.operationId, "op-4");
  assert.deepEqual(fake.calls.operationStatus, ["op-4"]);
});

test("ops wait refuses a zero polling interval at parse time", async () => {
  const fake = fakeClient();
  const run = harness({ client: fake.client });
  const error = await run.failure([
    "hosting",
    "ops",
    "wait",
    "op-5",
    "--interval-seconds",
    "0",
  ]);
  assert.ok(error instanceof CommanderError, error.message);
  assert.match(error.message, /greater than zero/);
  assert.deepEqual(fake.calls.operationStatus, []);
});

/* -------------------------------------------------------------------------- */
/* Profile resolution                                                         */
/* -------------------------------------------------------------------------- */

test("every subcommand fails closed without --profile and never infers one", async () => {
  const fake = fakeClient({ read: null });
  const run = harness({ client: fake.client, profile: null });

  for (const argv of [
    ["hosting", "providers", "validate"],
    ["hosting", "providers", "capabilities"],
    ["hosting", "regions", "list"],
    ["hosting", "activity", "list"],
    ["hosting", "ops", "get", "op-1"],
    ["hosting", "ops", "wait", "op-1"],
  ]) {
    const error = await run.failure(argv);
    assert.equal(error.code, "usage_error", argv.join(" "));
    assert.deepEqual(error.details.profiles, ["prod"]);
  }
  assert.deepEqual(fake.calls.read, []);
  assert.equal(fake.calls.validate, 0);
  assert.deepEqual(fake.calls.operationStatus, []);
});

test("an unknown profile is profile_not_found, not a provider call", async () => {
  const fake = fakeClient({ read: null });
  const run = harness({ client: fake.client, profile: "nope" });
  const error = await run.failure(["hosting", "regions", "list"]);
  assert.equal(error.code, "profile_not_found");
  assert.deepEqual(fake.calls.read, []);
});
