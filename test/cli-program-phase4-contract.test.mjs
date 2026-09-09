// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The assembled program: the seven hosting command groups, the local commands
 * and the globals, exercised through the REAL `createProgram` / `main` rather
 * than through a throwaway parent. Each group verified itself in isolation;
 * this suite is the only place that can catch what only exists once they are
 * attached to the same tree — a missing branch, a shadowed global, a subcommand
 * that never reaches its handler.
 *
 * Fully offline: the provider registry is a fake, so no invocation can reach a
 * provider API, and no test writes outside its temporary `NOVAMIRA_HQ_HOME`.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";
import { createProgram } from "../dist/cli/program.js";
import { CliError } from "../dist/errors.js";
import { main } from "../dist/main.js";

const PROFILE = "main";
const CREDENTIAL_ENV = "KINSTA_API_KEY";

/**
 * Every leaf command the assembled program exposes, with the flags it declares
 * in registration order. This is the shipped command surface: a group that
 * silently loses a subcommand, or gains one, fails here first.
 */
const COMMAND_SURFACE = {
  history: [],
  // The local dashboard. A top-level command, like Go's, and deliberately
  // without a `--timeout`: the name is reserved tree-wide and a server that
  // runs until the operator stops it has no operation deadline to set.
  dashboard: ["--listen", "--open"],

  // Phase 7's local surface. `doctor`'s two options and `update`'s one are
  // command-local and free against the reserved globals; the `skills`
  // subcommands declare no options at all, which is what makes them incapable
  // of shadowing one. `update` has no `upgrade` alias: Go carried one and a
  // second name for one command is a second thing the contract has to describe.
  doctor: ["--offline", "--fix"],
  update: ["--check"],
  "skills list": [],
  "skills get": [],
  "skills path": [],

  "config path": [],
  "config add": [
    "--company",
    "--api-base-url",
    "--force",
    "--credential-env",
    "--credential-stdin",
    "--credential-file",
  ],
  "config list": [],
  "config show": [],
  "config remove": [],

  "hosting providers validate": [],
  "hosting providers capabilities": [],
  "hosting regions list": ["--company"],
  "hosting activity list": [
    "--limit",
    "--offset",
    "--category",
    "--site",
    "--initiated-by",
    "--api-key",
    "--language",
    "--company",
  ],
  "hosting ops get": [],
  "hosting ops wait": ["--interval-seconds", "--timeout-seconds"],

  "hosting sites list": ["--include-envs"],
  "hosting sites get": [],
  "hosting sites create": [
    "--from-json",
    "--display-name",
    "--site-name",
    "--template-slug",
    "--reserved",
    "--shared",
    "--email",
    "--region",
    "--site-title",
    "--admin-email",
    "--admin-user",
    "--admin-password-env",
    "--admin-password-stdin",
    "--admin-password-file",
    "--wp-language",
    "--is-multisite",
    "--is-subdomain-multisite",
    "--woocommerce",
    "--wordpressseo",
  ],
  "hosting sites create-plain": ["--from-json", "--display-name", "--region"],
  "hosting sites clone": ["--from-json", "--display-name", "--source-env"],
  "hosting envs list": ["--site"],
  "hosting envs get": ["--site"],
  "hosting envs create": [
    "--site",
    "--from-json",
    "--display-name",
    "--site-title",
    "--admin-email",
    "--admin-user",
    "--admin-password-env",
    "--admin-password-stdin",
    "--admin-password-file",
    "--wp-language",
    "--is-premium",
    "--is-multisite",
    "--is-subdomain-multisite",
    "--woocommerce",
    "--wordpress-plugin-edd",
    "--wordpressseo",
  ],
  "hosting envs create-plain": [
    "--site",
    "--from-json",
    "--display-name",
    "--is-premium",
  ],
  "hosting envs clone": [
    "--site",
    "--from-json",
    "--display-name",
    "--source-env",
    "--is-premium",
  ],
  "hosting envs push": [
    "--site",
    "--source-env",
    "--target-env",
    "--db",
    "--all-files",
    "--search-replace",
    "--file",
  ],
  "hosting domains list": ["--env"],
  "hosting domains add": [
    "--env",
    "--domain-name",
    "--is-wildcardless",
    "--add-with-www-subdomain",
    "--setup-type",
    "--custom-ssl-key-file",
    "--custom-ssl-cert-file",
    "--from-json",
  ],
  "hosting domains verify": [],
  "hosting domains primary": [
    "--env",
    "--domain-id",
    "--search-replace",
    "--from-json",
  ],
  "hosting dns domains list": ["--company"],
  "hosting dns records list": ["--domain"],

  "hosting backups list": ["--env"],
  "hosting backups downloadable": ["--env"],
  "hosting backups create": ["--env", "--from-json", "--tag"],
  "hosting backups restore": [
    "--env",
    "--backup-id",
    "--all-content",
    "--notified-user-id",
  ],
  "hosting cache clear": [
    "--from-json",
    "--env",
    "--kind",
    "--cdn-cache-id",
    "--clear-subdirectories",
    "--url",
  ],
  "hosting php restart": ["--env"],
  "hosting php set-version": [
    "--from-json",
    "--env",
    "--php-version",
    "--opt-out-auto-updates",
  ],
  "hosting redirects list": [
    "--env",
    "--limit",
    "--offset",
    "--key",
    "--order",
    "--search",
    "--regex-search",
  ],
  "hosting redirects apply": ["--env", "--from-json"],
  "hosting denied-ips list": ["--env"],
  "hosting denied-ips set": ["--from-json", "--env", "--ip"],

  "hosting wp plugins list": ["--env", "--company"],
  "hosting wp plugins install": [
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
  ],
  "hosting wp plugins update": [
    "--env",
    "--name",
    "--update-version",
    "--from-json",
  ],
  "hosting wp plugins update-all": ["--env", "--name", "--from-json"],
  "hosting wp themes list": ["--env", "--company"],
  "hosting wp themes update": [
    "--env",
    "--name",
    "--update-version",
    "--from-json",
  ],
  "hosting wp themes update-all": ["--env", "--name", "--from-json"],
  "hosting wp-cli run": [
    "--env",
    "--command",
    "--command-stdin",
    "--from-json",
  ],
  "hosting logs get": ["--env", "--file", "--lines"],
  "hosting analytics usage": ["--site", "--metric"],
  "hosting analytics env": [
    "--env",
    "--metric",
    "--time-span",
    "--company",
    "--from",
    "--to",
    "--time-zone",
  ],

  "hosting novamira setup": [
    "--env",
    "--url",
    "--source",
    "--plugin-version",
    "--force",
    "--activate",
    "--no-activate",
    "--activate-network",
    "--ignore-requirements",
    "--preflight",
    "--no-preflight",
    "--validate-source",
    "--no-validate-source",
    "--wait",
    "--no-wait",
    "--ai-abilities",
    "--no-ai-abilities",
    "--compat-check",
    "--no-compat-check",
    "--interval-seconds",
    "--timeout-seconds",
  ],
};

/** Build the real program over a handler double that records every call. */
function recordingProgram(calls) {
  const handlers = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        (...args) => {
          calls.push({ name, args });
        },
    },
  );
  const program = createProgram("test", handlers);
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  for (const child of walk(program)) {
    child.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  }
  return program;
}

function* walk(command) {
  for (const child of command.commands) {
    yield child;
    yield* walk(child);
  }
}

/** Every leaf command, keyed by its space-separated path below the program. */
function leafCommands(program) {
  const leaves = new Map();
  const visit = (command, path) => {
    if (command.commands.length === 0) {
      leaves.set(path.join(" "), command);
      return;
    }
    for (const child of command.commands) visit(child, [...path, child.name()]);
  };
  for (const child of program.commands) visit(child, [child.name()]);
  return leaves;
}

function longFlags(command) {
  return command.options.map((option) => option.long ?? option.short);
}

/** A recording `ProviderClient` over the provider-neutral interface. */
function fakeClient(overrides = {}) {
  const requests = [];
  return {
    requests,
    provider: "kinsta",
    validate: async () => ({
      provider: "kinsta",
      status: "ok",
      companyId: null,
      credential: `env:${CREDENTIAL_ENV}`,
    }),
    read: async (request) => {
      requests.push(request);
      if (overrides.read !== undefined) return overrides.read(request);
      return { requested: request.kind };
    },
    action: async (request) => {
      requests.push(request);
      return { provider: "kinsta", status: 202 };
    },
    operationStatus: async (operationId) => ({
      provider: "kinsta",
      operationId,
      status: "done",
      done: true,
      failed: false,
    }),
    listSites: async () => [],
    getSite: async () => ({ id: "s1", name: "s1", displayName: "s1" }),
    listEnvironments: async () => [],
  };
}

/** Run the real composition root against captured streams and a fake registry. */
async function run(
  argv,
  { root, client = fakeClient(), env = {}, registry } = {},
) {
  const out = [];
  const err = [];
  const code = await main(
    argv,
    {
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => err.push(chunk) },
    },
    {
      ...(root === undefined ? {} : { NOVAMIRA_HQ_HOME: root }),
      [CREDENTIAL_ENV]: "not-a-real-secret",
      ...env,
    },
    // The only provider constructor this process can reach. No test can make a
    // network request even if a handler tried.
    { registry: registry ?? { kinsta: () => client } },
  );
  return { code, stdout: out.join(""), stderr: err.join(""), client };
}

/** A temporary HQ root carrying one hosting profile, created through the CLI. */
async function isolated(body) {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-phase4-"));
  try {
    const created = await run(
      [
        "config",
        "add",
        "kinsta",
        "--profile",
        PROFILE,
        "--credential-env",
        CREDENTIAL_ENV,
        "--company",
        "none",
        "--json",
      ],
      { root },
    );
    assert.equal(created.code, 0, created.stdout);
    return await body(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("an explicit global timeout bounds provider HTTP end to end", async () => {
  await isolated(async (root) => {
    let requests = 0;
    const registry = {
      kinsta: (context) => {
        const http = context.createHttpClient({
          retry: { maxAttempts: 1 },
          fetch: async (_input, init) => {
            requests += 1;
            return new Promise((_resolve, reject) => {
              const signal = init.signal;
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          },
        });
        return {
          ...fakeClient(),
          async listSites() {
            await http.json({ path: "/sites" });
            return [];
          },
        };
      },
    };

    const result = await run(
      [
        "hosting",
        "sites",
        "list",
        "--profile",
        PROFILE,
        "--timeout",
        "20",
        "--json",
      ],
      { root, registry },
    );
    assert.equal(result.code, 4);
    assert.equal(JSON.parse(result.stdout).error.code, "timeout");
    assert.equal(requests, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* The assembled command surface                                              */
/* -------------------------------------------------------------------------- */

test("the real program exposes exactly the shipped command surface", () => {
  const program = createProgram("test", {});
  const leaves = leafCommands(program);

  assert.deepEqual(
    [...leaves.keys()].sort(),
    Object.keys(COMMAND_SURFACE).sort(),
  );
  for (const [path, flags] of Object.entries(COMMAND_SURFACE)) {
    assert.deepEqual(longFlags(leaves.get(path)), flags, path);
  }
});

test("no ancestor option shadows a descendant option", () => {
  // Commander lets an ancestor consume a matching option anywhere in argv, so
  // a global name is reserved across the whole tree. `--version` is the global
  // that forced `--php-version`, `--update-version` and `--plugin-version`.
  const clashes = [];
  const visit = (command, ancestors, path) => {
    const declared = new Map();
    for (const ancestor of ancestors)
      for (const option of ancestor.command.options)
        for (const flag of [option.short, option.long].filter(Boolean))
          declared.set(flag, ancestor.path);
    for (const option of command.options)
      for (const flag of [option.short, option.long].filter(Boolean))
        if (declared.has(flag))
          clashes.push(`${path} ${flag} is shadowed by ${declared.get(flag)}`);
    for (const child of command.commands)
      visit(
        child,
        [...ancestors, { command, path }],
        `${path} ${child.name()}`,
      );
  };
  visit(createProgram("test", {}), [], "");
  assert.deepEqual(clashes, []);
});

test("the boundary rule holds across the assembled tree", () => {
  const program = createProgram("test", {});
  // No `site` command group, and no command may accept a WordPress site token,
  // an Application Password or an Ability.
  assert.equal(
    program.commands.some((command) => command.name() === "site"),
    false,
  );
  const forbidden = /application[-_ ]?password|ability|site[-_]?token/i;
  for (const [path, command] of leafCommands(program)) {
    assert.doesNotMatch(path, forbidden);
    for (const option of command.options) {
      assert.doesNotMatch(option.flags, forbidden, path);
      assert.doesNotMatch(option.description, forbidden, path);
    }
  }

  // Every secret is taken by reference only: a bare value option would put the
  // secret in argv, where the process table can read it.
  for (const [path, command] of leafCommands(program))
    for (const option of command.options)
      if (/password|secret|credential/i.test(option.long ?? ""))
        assert.match(
          option.long,
          /-(env|stdin|file|out|status)$/,
          `${path} ${option.long}`,
        );

  assert.equal(
    [...leafCommands(program).keys()].some((path) =>
      path.startsWith("hosting access "),
    ),
    false,
  );
});

/* -------------------------------------------------------------------------- */
/* Help                                                                        */
/* -------------------------------------------------------------------------- */

test("--help works at the program, group, subgroup and leaf levels", async () => {
  const cases = [
    [],
    ["config"],
    ["hosting"],
    ["hosting", "sites"],
    ["hosting", "wp"],
    ["hosting", "wp", "plugins"],
    ["hosting", "wp", "plugins", "install"],
    ["hosting", "dns", "records", "list"],
  ];
  for (const path of cases) {
    const result = await run([...path, "--help"]);
    const label = path.join(" ") || "(root)";
    assert.equal(result.code, 0, label);
    assert.match(
      result.stdout,
      new RegExp(`^Usage: novamira-hq${path.length === 0 ? "" : " "}`),
      label,
    );
    assert.equal(result.stderr, "", label);
  }
});

test("the program help lists every global option", async () => {
  const result = await run(["--help"]);
  for (const flag of [
    "--profile",
    "--json",
    "--timeout",
    "--yes",
    "--no-color",
    "--quiet",
    "--verbose",
    "--version",
  ])
    assert.ok(result.stdout.includes(flag), flag);
  // The two top-level groups.
  assert.match(result.stdout, /^\s+config\s/m);
  assert.match(result.stdout, /^\s+hosting\s/m);
});

/* -------------------------------------------------------------------------- */
/* Globals reach every subcommand through optionsFor                          */
/* -------------------------------------------------------------------------- */

test("global options are inherited by subcommands at every depth", async () => {
  const globals = [
    "--json",
    "--quiet",
    "--verbose",
    "--no-color",
    "--yes",
    "--timeout",
    "750",
    "--profile",
    PROFILE,
  ];
  const cases = [
    { argv: ["config", "list"], handler: "configList" },
    {
      argv: ["hosting", "providers", "validate"],
      handler: "providersValidate",
    },
    { argv: ["hosting", "sites", "list"], handler: "sitesList" },
    {
      argv: ["hosting", "wp", "plugins", "list", "--env", "env-1"],
      handler: "wpAssetList",
    },
    {
      argv: ["hosting", "dns", "records", "list", "--domain", "d1"],
      handler: "dnsRecordsList",
    },
    {
      argv: ["hosting", "backups", "list", "--env", "env-1"],
      handler: "backupsList",
    },
  ];

  for (const entry of cases) {
    const label = entry.argv.join(" ");
    for (const argv of [
      [...entry.argv, ...globals],
      [...globals, ...entry.argv],
    ]) {
      const calls = [];
      await recordingProgram(calls).parseAsync(argv, { from: "user" });
      assert.equal(calls.length, 1, label);
      assert.equal(calls[0].name, entry.handler, label);
      const options = calls[0].args.at(-1);
      assert.equal(options.json, true, label);
      assert.equal(options.quiet, true, label);
      assert.equal(options.verbose, true, label);
      assert.equal(options.color, false, label);
      assert.equal(options.yes, true, label);
      assert.equal(options.timeout, 750, label);
      assert.equal(options.timeoutExplicit, true, label);
      assert.equal(options.profile, PROFILE, label);
    }
  }
});

test("unspecified globals keep their documented defaults everywhere", async () => {
  const calls = [];
  await recordingProgram(calls).parseAsync(
    ["hosting", "envs", "list", "--site", "s1"],
    { from: "user" },
  );
  const options = calls[0].args.at(-1);
  assert.equal(options.json, false);
  assert.equal(options.quiet, false);
  assert.equal(options.verbose, false);
  assert.equal(options.color, true);
  assert.equal(options.yes, false);
  assert.equal(options.timeout, 30_000);
  assert.equal(options.timeoutExplicit, false);
  assert.equal(options.profile, undefined);
});

test("subcommand options reach the handler alongside the globals", async () => {
  const calls = [];
  await recordingProgram(calls).parseAsync(
    [
      "hosting",
      "php",
      "set-version",
      "--env",
      "env-1",
      "--php-version",
      "8.3",
      "--json",
    ],
    { from: "user" },
  );
  assert.equal(calls[0].name, "phpSetVersion");
  const [values, options] = calls[0].args;
  // `--php-version` is Go's `--version`, renamed because the global wins.
  assert.deepEqual(values, {
    env: "env-1",
    phpVersion: "8.3",
    optOutAutoUpdates: false,
  });
  assert.equal(options.json, true);
});

test("optionsFor resolves the innermost command, not the program", () => {
  // The action arguments commander appends must be read from the end, or a
  // nested group's own options would be lost behind the program's.
  const program = createProgram("test", {});
  const leaves = leafCommands(program);
  for (const path of ["hosting wp plugins install", "hosting dns records list"])
    assert.ok(leaves.get(path).parent.parent.parent instanceof Command, path);
});

/* -------------------------------------------------------------------------- */
/* Failure envelopes                                                          */
/* -------------------------------------------------------------------------- */

test("an unknown subcommand or a bad flag is a usage_error at exit 2", async () => {
  const cases = [
    ["hosting", "nope"],
    ["hosting", "sites", "nope"],
    ["hosting", "wp", "plugins", "nope"],
    ["hosting", "sites", "list", "--not-a-flag"],
    ["hosting", "ops", "wait", "op-1", "--interval-seconds", "0"],
    ["hosting", "redirects", "list", "--env", "e", "--limit", "many"],
    ["hosting", "cache", "clear", "--env", "e", "--kind", "nope"],
    ["hosting", "ops", "get"],
    ["config", "add"],
  ];
  for (const argv of cases) {
    const label = argv.join(" ");
    const result = await run([...argv, "--json", "--profile", PROFILE]);
    assert.equal(result.code, 2, `${label}: ${result.stdout}`);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false, label);
    assert.equal(envelope.error.code, "usage_error", label);
    assert.equal(envelope.error.retryable, false, label);
    assert.equal(typeof envelope.error.message, "string", label);
  }
});

test("a command that needs a profile refuses to infer one", async () => {
  await isolated(async (root) => {
    const result = await run(["hosting", "sites", "list", "--json"], { root });
    assert.equal(result.code, 2);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.error.code, "usage_error");
    assert.deepEqual(envelope.error.details.profiles, [PROFILE]);

    const missing = await run(
      ["hosting", "sites", "list", "--profile", "absent", "--json"],
      { root },
    );
    assert.equal(missing.code, 2);
    assert.equal(JSON.parse(missing.stdout).error.code, "profile_not_found");
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end envelopes over the fake registry                                */
/* -------------------------------------------------------------------------- */

test("a successful hosting command renders the documented success envelope", async () => {
  await isolated(async (root) => {
    const result = await run(
      ["hosting", "providers", "validate", "--profile", PROFILE, "--json"],
      { root },
    );
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trimEnd().includes("\n"), false);

    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data, {
      provider: "kinsta",
      status: "ok",
      company_id: null,
      credential: `env:${CREDENTIAL_ENV}`,
    });
    assert.match(
      envelope.meta.requestId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.equal(envelope.meta.profile, PROFILE);
    assert.equal(envelope.meta.provider, "kinsta");
    // The secret never reaches stdout, only its non-secret reference.
    assert.equal(result.stdout.includes("not-a-real-secret"), false);

    const human = await run(
      ["hosting", "providers", "validate", "--profile", PROFILE],
      { root },
    );
    assert.equal(human.code, 0);
    assert.equal(
      human.stdout,
      `kinsta credential=env:${CREDENTIAL_ENV} status=ok company=(not set)\n`,
    );
  });
});

test("a failing provider call renders the documented failure envelope", async () => {
  await isolated(async (root) => {
    const client = fakeClient({
      read: () => {
        throw new CliError("provider_error", "The Kinsta API request failed.", {
          retryable: true,
          remoteCode: "KINSTA_500",
          details: { status: 500 },
        });
      },
    });
    const result = await run(
      ["hosting", "regions", "list", "--profile", PROFILE, "--json"],
      { root, client },
    );
    assert.equal(result.code, 4);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      error: {
        code: "provider_error",
        message: "The Kinsta API request failed.",
        retryable: true,
        remoteCode: "KINSTA_500",
        details: { status: 500 },
      },
    });

    const human = await run(
      ["hosting", "regions", "list", "--profile", PROFILE],
      {
        root,
        client: fakeClient({
          read: () => {
            throw new CliError(
              "provider_error",
              "The Kinsta API request failed.",
            );
          },
        }),
      },
    );
    assert.equal(human.code, 4);
    assert.equal(human.stdout, "");
    assert.match(
      human.stderr,
      /^Error \[provider_error\]: The Kinsta API request failed\.$/m,
    );
  });
});

test("each hosting group dispatches its own provider request", async () => {
  const cases = [
    { argv: ["hosting", "regions", "list"], kind: "regions" },
    { argv: ["hosting", "sites", "list"], kind: undefined },
    {
      argv: ["hosting", "domains", "list", "--env", "env-1"],
      kind: "site-domains",
    },
    { argv: ["hosting", "backups", "list", "--env", "env-1"], kind: "backups" },
    {
      argv: ["hosting", "wp", "plugins", "list", "--env", "env-1"],
      kind: "plugins",
    },
  ];
  await isolated(async (root) => {
    for (const entry of cases) {
      const client = fakeClient();
      const result = await run(
        [...entry.argv, "--profile", PROFILE, "--json"],
        { root, client },
      );
      const label = entry.argv.join(" ");
      assert.equal(result.code, 0, `${label}: ${result.stdout}`);
      assert.equal(JSON.parse(result.stdout).ok, true, label);
      if (entry.kind !== undefined)
        assert.equal(client.requests.at(-1).kind, entry.kind, label);
    }
  });
});

test("the local commands are unchanged by the hosting tree", async () => {
  await isolated(async (root) => {
    const version = await run(["--version", "--json"], { root });
    assert.equal(version.code, 0);
    assert.equal(JSON.parse(version.stdout).data.version, "1.0.0-rc1");

    // `config path` keeps its name, its place and its output after the hosting
    // profile subcommands joined the same `config` command.
    const paths = await run(["config", "path", "--json"], { root });
    assert.equal(paths.code, 0);
    const data = JSON.parse(paths.stdout).data;
    assert.deepEqual(Object.keys(data), [
      "configFile",
      "configDir",
      "stateDir",
      "locksDir",
      "lockFile",
      "cacheDir",
      "credentialsDir",
    ]);
    assert.equal(data.configFile, join(root, "config.json"));

    const list = await run(["config", "list", "--json"], { root });
    assert.equal(list.code, 0);
    assert.deepEqual(
      JSON.parse(list.stdout).data.profiles.map((entry) => entry.name),
      [PROFILE],
    );
  });
});
