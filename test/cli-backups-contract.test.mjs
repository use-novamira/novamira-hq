// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract test for the `hosting backups | cache | php | redirects |
 * denied-ips` command group (`src/cli/hosting/maintenance.ts`).
 *
 * Offline by construction: the provider registry holds exactly one fake
 * constructor, which returns a recording `ProviderClient`. No socket is opened,
 * no provider module is loaded, and every assertion about "what the provider
 * was asked to do" is made against the recorded request objects.
 *
 * The group is exercised through its own `registerMaintenanceCommands` on a
 * throwaway root command, because `program.ts` is wired up by the Phase 4
 * integration step and not by this file. The throwaway root registers the same
 * globals the real program does (`--json`, `--profile`, ...) and resolves them
 * with the same `optsWithGlobals` rule.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command, CommanderError } from "commander";
import {
  createMaintenanceHandlers,
  registerMaintenanceCommands,
} from "../dist/cli/hosting/maintenance.js";
import { defaultFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import { envCredential } from "../dist/config/schema.js";
import { CliError } from "../dist/errors.js";
import { createHostingClientFactory } from "../dist/hosting/factory.js";
import { serializeActionResult } from "../dist/hosting/types.js";
import { createRenderer } from "../dist/output/render.js";

/** An obvious fake. Nothing in this suite ever contacts a real provider. */
const PLACEHOLDER = "maintenance-fake-credential-not-a-real-secret";
const PROFILE = "prod";
const REQUEST_ID = "00000000-0000-4000-8000-000000000000";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

function defaultActionResult(request) {
  return {
    provider: "kinsta",
    action: `fake.${request.kind}`,
    status: 202,
    operationId: "op-1",
    raw: { accepted: true },
  };
}

/**
 * A recording `ProviderClient` behind a real `HostingClientFactory` and a real
 * `ConfigStore`, so profile selection and client construction are the product's
 * and only the provider itself is fake.
 */
async function harness(root, options = {}) {
  const paths = platformPaths({ NOVAMIRA_HQ_HOME: root });
  const security = defaultFileSecurity();
  const locks = new ProfileLockManager(paths.stateDir, security);
  const store = new ConfigStore(paths.configFile, locks, security);
  await store.upsertHostingProfile(PROFILE, {
    provider: "kinsta",
    credential: envCredential("KINSTA_API_KEY"),
    companyId: "company-1234",
  });

  const state = {
    paths,
    store,
    requests: [],
    out: [],
    err: [],
    renderer: undefined,
  };

  const client = {
    provider: "kinsta",
    async validate() {
      throw new Error("unused");
    },
    async listSites() {
      throw new Error("unused");
    },
    async getSite() {
      throw new Error("unused");
    },
    async listEnvironments() {
      throw new Error("unused");
    },
    async read(request) {
      state.requests.push(request);
      if (options.readFails !== undefined) throw options.readFails;
      return options.read === undefined ? { ok: true } : options.read(request);
    },
    async action(request) {
      state.requests.push(request);
      if (options.actionFails !== undefined) throw options.actionFails;
      return options.action === undefined
        ? defaultActionResult(request)
        : options.action(request);
    },
    async operationStatus() {
      throw new Error("unused");
    },
  };

  const streams = {
    stdout: { write: (chunk) => state.out.push(chunk) },
    stderr: { write: (chunk) => state.err.push(chunk) },
  };

  state.dependencies = {
    version: "test",
    paths,
    store,
    hosting: createHostingClientFactory({
      store,
      registry: { kinsta: () => client },
      env: { KINSTA_API_KEY: PLACEHOLDER },
    }),
    io: options.io,
    rendererFor(globals) {
      state.renderer ??= createRenderer(
        {
          json: globals.json,
          quiet: globals.quiet,
          verbose: globals.verbose,
          color: false,
          requestId: REQUEST_ID,
        },
        streams,
      );
      return state.renderer;
    },
  };
  state.streams = streams;
  return state;
}

/** The throwaway stand-in for `program.ts`, with the same global grammar. */
function buildRoot(state) {
  const root = new Command();
  root
    .name("novamira-hq")
    .exitOverride()
    .configureOutput({
      writeOut: (value) => state.streams.stdout.write(value),
      writeErr: () => undefined,
    })
    .option("--json", "emit exactly one JSON value on stdout", false)
    .option("--quiet", "suppress nonessential diagnostics", false)
    .option("--verbose", "emit redacted diagnostics", false)
    .option("--no-color", "disable ANSI color")
    .option("--yes", "approve destructive operations", false)
    .option("--profile <name>", "the hosting profile to operate through");

  const optionsFor = (values) => {
    const active = values.findLast((value) => value instanceof Command) ?? root;
    return { ...active.optsWithGlobals(), timeoutExplicit: false };
  };

  const hosting = root.command("hosting").description("hosting operations");
  registerMaintenanceCommands(
    hosting,
    createMaintenanceHandlers(state.dependencies),
    optionsFor,
  );
  return { root, hosting };
}

/** `main.ts`'s run/failure loop, reduced to what this group needs. */
async function run(state, argv) {
  state.out.length = 0;
  state.err.length = 0;
  state.requests.length = 0;
  state.renderer = undefined;

  const { root } = buildRoot(state);
  let code = 0;
  let commanderCode;
  try {
    await root.parseAsync(argv, { from: "user" });
  } catch (error) {
    const failure =
      error instanceof CommanderError
        ? new CliError("usage_error", "Invalid command usage.")
        : error;
    if (error instanceof CommanderError) commanderCode = error.code;
    const renderer =
      state.renderer ??
      state.dependencies.rendererFor({
        json: argv.includes("--json"),
        quiet: false,
        verbose: false,
      });
    code = renderer.failure(failure);
  }
  return {
    code,
    commanderCode,
    stdout: state.out.join(""),
    stderr: state.err.join(""),
    requests: [...state.requests],
  };
}

async function isolated(body) {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-maintenance-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

/** Parse a `--json` invocation and return its envelope. */
async function envelopeOf(state, argv) {
  const result = await run(state, [...argv, "--json", "--profile", PROFILE]);
  assert.equal(result.stdout.trimEnd().includes("\n"), false, argv.join(" "));
  return { ...result, envelope: JSON.parse(result.stdout) };
}

function commandNamed(parent, path) {
  return path.reduce(
    (command, name) =>
      command.commands.find((child) => child.name() === name) ??
      assert.fail(`missing command ${path.join(" ")}`),
    parent,
  );
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

test("the group registers exactly the Go command tree", async () => {
  await isolated(async (root) => {
    const state = await harness(root);
    const { hosting } = buildRoot(state);

    assert.deepEqual(
      hosting.commands.map((command) => command.name()),
      ["backups", "cache", "php", "redirects", "denied-ips"],
    );

    const tree = {
      backups: ["list", "downloadable", "create", "restore", "delete"],
      cache: ["clear"],
      php: ["restart", "set-version"],
      redirects: ["list", "apply"],
      "denied-ips": ["list", "set"],
    };
    for (const [group, subcommands] of Object.entries(tree)) {
      assert.deepEqual(
        commandNamed(hosting, [group]).commands.map((child) => child.name()),
        subcommands,
        group,
      );
    }

    // `backups delete <backup_id>` is the group's only positional argument.
    for (const [group, subcommands] of Object.entries(tree)) {
      for (const name of subcommands) {
        const command = commandNamed(hosting, [group, name]);
        assert.deepEqual(
          command.registeredArguments.map((argument) => argument.name()),
          group === "backups" && name === "delete" ? ["backup_id"] : [],
          `${group} ${name}`,
        );
      }
    }
  });
});

test("every subcommand exposes exactly its Go flags", async () => {
  await isolated(async (root) => {
    const state = await harness(root);
    const { hosting } = buildRoot(state);

    const expected = {
      "backups list": ["--env"],
      "backups downloadable": ["--env"],
      "backups create": ["--env", "--from-json", "--tag"],
      "backups restore": [
        "--target-env",
        "--from-json",
        "--backup-id",
        "--notified-user-id",
      ],
      "backups delete": [],
      "cache clear": [
        "--from-json",
        "--env",
        "--kind",
        "--cdn-cache-id",
        "--clear-subdirectories",
        "--url",
      ],
      "php restart": ["--env"],
      "php set-version": [
        "--from-json",
        "--env",
        "--php-version",
        "--opt-out-auto-updates",
      ],
      "redirects list": [
        "--env",
        "--limit",
        "--offset",
        "--key",
        "--order",
        "--search",
        "--regex-search",
      ],
      "redirects apply": ["--env", "--from-json"],
      "denied-ips list": ["--env"],
      "denied-ips set": ["--from-json", "--env", "--ip"],
    };

    for (const [path, flags] of Object.entries(expected)) {
      const command = commandNamed(hosting, path.split(" "));
      assert.deepEqual(
        command.options.map((option) => option.long),
        flags,
        path,
      );
      // No short forms in the Go source, and none invented here.
      assert.deepEqual(
        command.options.flatMap((option) =>
          option.short === undefined ? [] : [option.short],
        ),
        [],
        path,
      );
      // Boundary rule and secret hygiene: this group never takes a credential,
      // so no option may look like one.
      for (const flag of flags)
        assert.doesNotMatch(flag, /password|secret|token|application/i, path);
    }
  });
});

test("flag defaults match the Go flag declarations", async () => {
  await isolated(async (root) => {
    const state = await harness(root);
    const { hosting } = buildRoot(state);

    const optionNamed = (path, long) =>
      commandNamed(hosting, path).options.find(
        (option) => option.long === long,
      ) ?? assert.fail(`missing ${long} on ${path.join(" ")}`);

    assert.equal(
      optionNamed(["cache", "clear"], "--kind").defaultValue,
      "site",
    );
    assert.equal(
      optionNamed(["cache", "clear"], "--clear-subdirectories").defaultValue,
      false,
    );
    assert.equal(
      optionNamed(["cache", "clear"], "--url").defaultValue,
      undefined,
    );
    assert.equal(
      optionNamed(["php", "set-version"], "--opt-out-auto-updates")
        .defaultValue,
      false,
    );
    assert.equal(
      optionNamed(["redirects", "list"], "--regex-search").defaultValue,
      false,
    );
    // Unset, not zero: Go used `Changed("limit")` to decide whether to send it,
    // so an omitted flag must stay out of the query string entirely.
    for (const long of ["--limit", "--offset"]) {
      const option = optionNamed(["redirects", "list"], long);
      assert.equal(option.defaultValue, undefined, long);
      assert.equal(typeof option.parseArg, "function", long);
    }
    assert.equal(
      typeof optionNamed(["backups", "restore"], "--backup-id").parseArg,
      "function",
    );
    // Repeatable, and empty rather than undefined when never given.
    const ip = optionNamed(["denied-ips", "set"], "--ip");
    assert.deepEqual(ip.defaultValue, []);
    assert.equal(typeof ip.parseArg, "function");
  });
});

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

test("each subcommand dispatches exactly the Go provider request", async () => {
  await isolated(async (root) => {
    const state = await harness(root);

    const cases = [
      {
        argv: ["hosting", "backups", "list", "--env", "env-1"],
        request: { kind: "backups", envId: "env-1" },
      },
      {
        argv: ["hosting", "backups", "downloadable", "--env", "env-1"],
        request: { kind: "downloadable-backups", envId: "env-1" },
      },
      {
        argv: ["hosting", "backups", "create", "--env", "env-1"],
        request: { kind: "create-backup", envId: "env-1", body: {} },
      },
      {
        argv: [
          "hosting",
          "backups",
          "create",
          "--env",
          "env-1",
          "--tag",
          "nightly",
        ],
        request: {
          kind: "create-backup",
          envId: "env-1",
          body: { tag: "nightly" },
        },
      },
      {
        argv: [
          "hosting",
          "backups",
          "restore",
          "--target-env",
          "env-2",
          "--backup-id",
          "42",
          "--notified-user-id",
          "user-9",
        ],
        request: {
          kind: "restore-backup",
          targetEnvId: "env-2",
          body: { backup_id: 42, notified_user_id: "user-9" },
        },
      },
      {
        argv: ["hosting", "backups", "delete", "42"],
        request: { kind: "delete-backup", backupId: 42 },
      },
      {
        argv: ["hosting", "cache", "clear", "--env", "env-1"],
        request: {
          kind: "clear-cache",
          cache: "site",
          body: { environment_id: "env-1" },
        },
      },
      {
        argv: [
          "hosting",
          "cache",
          "clear",
          "--kind",
          "edge",
          "--env",
          "env-1",
          "--clear-subdirectories",
          "--url",
          "https://example.com/a",
        ],
        request: {
          kind: "clear-cache",
          cache: "edge",
          body: {
            environment_id: "env-1",
            clear_subdirectories: true,
            url: "https://example.com/a",
          },
        },
      },
      {
        argv: [
          "hosting",
          "cache",
          "clear",
          "--kind",
          "cdn",
          "--env",
          "env-1",
          "--cdn-cache-id",
          "cdn-7",
        ],
        request: {
          kind: "clear-cache",
          cache: "cdn",
          body: { environment_id: "env-1", cdn_cache_id: "cdn-7" },
        },
      },
      {
        argv: ["hosting", "php", "restart", "--env", "env-1"],
        request: { kind: "restart-php", envId: "env-1" },
      },
      {
        argv: [
          "hosting",
          "php",
          "set-version",
          "--env",
          "env-1",
          "--php-version",
          "8.3",
        ],
        request: {
          kind: "set-php-version",
          body: { environment_id: "env-1", php_version: "8.3" },
        },
      },
      {
        argv: [
          "hosting",
          "php",
          "set-version",
          "--env",
          "env-1",
          "--php-version",
          "8.3",
          "--opt-out-auto-updates",
        ],
        request: {
          kind: "set-php-version",
          body: {
            environment_id: "env-1",
            php_version: "8.3",
            is_opt_out_from_automatic_php_update: true,
          },
        },
      },
      {
        argv: ["hosting", "redirects", "list", "--env", "env-1"],
        request: { kind: "redirects", envId: "env-1", query: [] },
      },
      {
        argv: [
          "hosting",
          "denied-ips",
          "set",
          "--env",
          "env-1",
          "--ip",
          "1.2.3.4",
          "--ip",
          "5.6.7.8",
        ],
        request: {
          kind: "set-denied-ips",
          body: { environment_id: "env-1", ip_list: ["1.2.3.4", "5.6.7.8"] },
        },
      },
      {
        argv: ["hosting", "denied-ips", "list", "--env", "env-1"],
        request: { kind: "denied-ips", envId: "env-1" },
      },
    ];

    for (const entry of cases) {
      const label = entry.argv.join(" ");
      const result = await run(state, [...entry.argv, "--profile", PROFILE]);
      assert.equal(result.code, 0, `${label}: ${result.stderr}`);
      assert.equal(result.requests.length, 1, label);
      assert.deepEqual(result.requests[0], entry.request, label);
    }
  });
});

test("denied-ips set sends an empty list when no --ip was given", async () => {
  await isolated(async (root) => {
    const state = await harness(root);
    const result = await run(state, [
      "hosting",
      "denied-ips",
      "set",
      "--env",
      "env-1",
      "--profile",
      PROFILE,
    ]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.requests[0].body, {
      environment_id: "env-1",
      ip_list: [],
    });
  });
});

test("redirects list keeps Go's query order and drops unset parameters", async () => {
  await isolated(async (root) => {
    const state = await harness(root);

    const full = await run(state, [
      "hosting",
      "redirects",
      "list",
      "--env",
      "env-1",
      "--limit",
      "25",
      "--offset",
      "0",
      "--key",
      "source",
      "--order",
      "asc",
      "--search",
      "blog",
      "--regex-search",
      "--profile",
      PROFILE,
    ]);
    assert.equal(full.code, 0);
    assert.deepEqual(full.requests[0].query, [
      ["limit", "25"],
      ["offset", "0"],
      ["key", "source"],
      ["order", "asc"],
      ["search_query", "blog"],
      ["regex_search", "true"],
    ]);

    // `--regex-search` is only ever sent when set; a provider must not receive
    // `regex_search=false` and treat the parameter's presence as truthy.
    const partial = await run(state, [
      "hosting",
      "redirects",
      "list",
      "--env",
      "env-1",
      "--search",
      "blog",
      "--profile",
      PROFILE,
    ]);
    assert.deepEqual(partial.requests[0].query, [["search_query", "blog"]]);
  });
});

test("--from-json replaces the built body, from a file or from stdin", async () => {
  await isolated(async (root) => {
    const payloadFile = join(root, "payload.json");
    await writeFile(payloadFile, '{"from":"file"}', "utf8");

    const state = await harness(root, {
      io: {
        env: {},
        async readStdin() {
          return '{"from":"stdin"}\n';
        },
        async readFile(path) {
          const { readFile } = await import("node:fs/promises");
          return readFile(path, "utf8");
        },
        async writePrivateFile() {
          assert.fail("this group never writes a file");
        },
      },
    });

    const cases = [
      ["hosting", "backups", "create", "--env", "env-1"],
      [
        "hosting",
        "backups",
        "restore",
        "--target-env",
        "env-2",
        // Deliberately omitted: --from-json must win before the required
        // --backup-id / --notified-user-id are ever consulted.
      ],
      ["hosting", "cache", "clear", "--kind", "cdn"],
      ["hosting", "php", "set-version"],
      ["hosting", "redirects", "apply", "--env", "env-1"],
      ["hosting", "denied-ips", "set"],
    ];

    for (const argv of cases) {
      const label = argv.join(" ");
      const fromFile = await run(state, [
        ...argv,
        "--from-json",
        payloadFile,
        "--profile",
        PROFILE,
      ]);
      assert.equal(fromFile.code, 0, `${label}: ${fromFile.stderr}`);
      assert.deepEqual(fromFile.requests[0].body, { from: "file" }, label);

      const fromStdin = await run(state, [
        ...argv,
        "--from-json",
        "-",
        "--profile",
        PROFILE,
      ]);
      assert.equal(fromStdin.code, 0, `${label}: ${fromStdin.stderr}`);
      assert.deepEqual(fromStdin.requests[0].body, { from: "stdin" }, label);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

test("a missing required option is a usage_error naming the flag", async () => {
  await isolated(async (root) => {
    const state = await harness(root);

    const cases = [
      { argv: ["hosting", "backups", "list"], flag: "--env" },
      { argv: ["hosting", "backups", "downloadable"], flag: "--env" },
      { argv: ["hosting", "backups", "create"], flag: "--env" },
      { argv: ["hosting", "backups", "restore"], flag: "--target-env" },
      {
        argv: [
          "hosting",
          "backups",
          "restore",
          "--target-env",
          "env-2",
          "--notified-user-id",
          "user-9",
        ],
        flag: "--backup-id",
      },
      {
        argv: [
          "hosting",
          "backups",
          "restore",
          "--target-env",
          "env-2",
          "--backup-id",
          "1",
        ],
        flag: "--notified-user-id",
      },
      { argv: ["hosting", "cache", "clear"], flag: "--env" },
      {
        argv: ["hosting", "cache", "clear", "--kind", "cdn", "--env", "env-1"],
        flag: "--cdn-cache-id",
      },
      { argv: ["hosting", "php", "restart"], flag: "--env" },
      { argv: ["hosting", "php", "set-version"], flag: "--env" },
      {
        argv: ["hosting", "php", "set-version", "--env", "env-1"],
        flag: "--php-version",
      },
      { argv: ["hosting", "redirects", "list"], flag: "--env" },
      { argv: ["hosting", "redirects", "apply"], flag: "--env" },
      { argv: ["hosting", "denied-ips", "list"], flag: "--env" },
      { argv: ["hosting", "denied-ips", "set"], flag: "--env" },
    ];

    for (const entry of cases) {
      const label = entry.argv.join(" ");
      const { code, envelope, requests } = await envelopeOf(state, entry.argv);
      assert.equal(code, 2, label);
      assert.equal(envelope.ok, false, label);
      assert.equal(envelope.error.code, "usage_error", label);
      assert.equal(envelope.error.retryable, false, label);
      assert.equal(envelope.error.details.flag, entry.flag, label);
      // Nothing reached the provider: validation happens before dispatch.
      assert.deepEqual(requests, [], label);
    }
  });
});

test("redirects apply has no option-driven form and demands --from-json", async () => {
  await isolated(async (root) => {
    const state = await harness(root);
    const { code, envelope, requests } = await envelopeOf(state, [
      "hosting",
      "redirects",
      "apply",
      "--env",
      "env-1",
    ]);
    assert.equal(code, 2);
    assert.equal(envelope.error.code, "usage_error");
    assert.equal(
      envelope.error.message,
      "redirects apply requires --from-json.",
    );
    assert.equal(envelope.error.details.command, "redirects apply");
    assert.deepEqual(requests, []);
  });
});

test("an unparseable option or argument fails during commander's parse", async () => {
  await isolated(async (root) => {
    const state = await harness(root);

    const cases = [
      ["hosting", "cache", "clear", "--kind", "disk", "--env", "env-1"],
      ["hosting", "redirects", "list", "--env", "env-1", "--limit", "many"],
      ["hosting", "redirects", "list", "--env", "env-1", "--offset", "1.5"],
      ["hosting", "backups", "restore", "--backup-id", "-1"],
      ["hosting", "backups", "delete", "not-a-number"],
      ["hosting", "backups", "delete"],
      ["hosting", "backups", "nope"],
    ];

    for (const argv of cases) {
      const label = argv.join(" ");
      const result = await run(state, [
        ...argv,
        "--json",
        "--profile",
        PROFILE,
      ]);
      assert.equal(result.code, 2, label);
      assert.notEqual(result.commanderCode, undefined, label);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, false, label);
      assert.equal(envelope.error.code, "usage_error", label);
      assert.deepEqual(result.requests, [], label);
    }
  });
});

test("a hosting profile is never inferred", async () => {
  await isolated(async (root) => {
    const state = await harness(root);
    const result = await run(state, [
      "hosting",
      "backups",
      "list",
      "--env",
      "env-1",
      "--json",
    ]);
    assert.equal(result.code, 2);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.error.code, "usage_error");
    assert.deepEqual(envelope.error.details.profiles, [PROFILE]);
    assert.deepEqual(result.requests, []);

    const missing = await run(state, [
      "hosting",
      "backups",
      "list",
      "--env",
      "env-1",
      "--json",
      "--profile",
      "absent",
    ]);
    assert.equal(missing.code, 2);
    assert.equal(JSON.parse(missing.stdout).error.code, "profile_not_found");
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

test("a read renders the provider response verbatim inside the envelope", async () => {
  await isolated(async (root) => {
    const payload = [{ id: "backup-1", tag: "nightly" }];
    const state = await harness(root, { read: () => payload });

    const { code, envelope } = await envelopeOf(state, [
      "hosting",
      "backups",
      "list",
      "--env",
      "env-1",
    ]);
    assert.equal(code, 0);
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data, payload);
    assert.equal(envelope.meta.requestId, REQUEST_ID);
    assert.equal(envelope.meta.profile, PROFILE);
    assert.equal(envelope.meta.provider, "kinsta");

    // An empty provider body is `null`, as Go's parseJSONBody produced.
    const empty = await harness(root, { read: () => undefined });
    const emptyResult = await envelopeOf(empty, [
      "hosting",
      "denied-ips",
      "list",
      "--env",
      "env-1",
    ]);
    assert.equal(emptyResult.envelope.data, null);

    // Human mode pretty-prints the same value and writes nothing to stderr.
    const human = await run(state, [
      "hosting",
      "backups",
      "list",
      "--env",
      "env-1",
      "--profile",
      PROFILE,
    ]);
    assert.equal(human.code, 0);
    assert.equal(human.stdout, `${JSON.stringify(payload, null, 2)}\n`);
    assert.equal(human.stderr, "");
  });
});

test("an action renders the serialized ActionResult", async () => {
  await isolated(async (root) => {
    const result = {
      provider: "kinsta",
      action: "backups.create",
      status: 202,
      message: "queued",
      operationId: "op-42",
      raw: { id: 7 },
    };
    const state = await harness(root, { action: () => result });

    const json = await envelopeOf(state, [
      "hosting",
      "backups",
      "create",
      "--env",
      "env-1",
    ]);
    assert.equal(json.code, 0);
    assert.deepEqual(json.envelope.data, serializeActionResult(result));
    assert.deepEqual(json.envelope.data, {
      provider: "kinsta",
      action: "backups.create",
      status: 202,
      message: "queued",
      operation_id: "op-42",
      raw: { id: 7 },
    });

    const human = await run(state, [
      "hosting",
      "backups",
      "create",
      "--env",
      "env-1",
      "--profile",
      PROFILE,
    ]);
    assert.equal(
      human.stdout,
      "backups.create status=202 operation=op-42 queued\n",
    );
  });
});

test("a provider failure renders the failure envelope and its exit code", async () => {
  await isolated(async (root) => {
    const state = await harness(root, {
      actionFails: new CliError(
        "provider_error",
        "Kinsta rejected the backup.",
        {
          remoteCode: "backup_limit",
          details: { provider: "kinsta", status: 409 },
        },
      ),
    });

    const { code, envelope } = await envelopeOf(state, [
      "hosting",
      "backups",
      "create",
      "--env",
      "env-1",
    ]);
    assert.equal(code, 4);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "provider_error");
    assert.equal(envelope.error.message, "Kinsta rejected the backup.");
    assert.equal(envelope.error.remoteCode, "backup_limit");
    assert.equal(envelope.error.retryable, false);
    assert.equal(envelope.error.details.status, 409);

    const unsupported = await harness(root, {
      readFails: new CliError(
        "provider_unsupported",
        'Kinsta does not support the "redirects" read request.',
      ),
    });
    const readResult = await envelopeOf(unsupported, [
      "hosting",
      "redirects",
      "list",
      "--env",
      "env-1",
    ]);
    assert.equal(readResult.code, 4);
    assert.equal(readResult.envelope.error.code, "provider_unsupported");

    // Human mode: one line on stderr, nothing on stdout.
    const human = await run(state, [
      "hosting",
      "backups",
      "create",
      "--env",
      "env-1",
      "--profile",
      PROFILE,
    ]);
    assert.equal(human.code, 4);
    assert.equal(human.stdout, "");
    assert.equal(
      human.stderr,
      "Error [provider_error]: Kinsta rejected the backup.\n",
    );
  });
});
