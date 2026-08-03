// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract tests for `hosting sites` and `hosting envs`
 * (`src/cli/hosting/sites.ts`).
 *
 * `program.ts` belongs to the Phase 4 integration step, so these tests attach
 * `registerSitesCommands` to a throwaway `Command` that carries the same global
 * options the real program does, and reproduce `main.ts`'s failure mapping
 * (a `CommanderError` becomes `usage_error`, everything else goes through
 * `asCliError`). Everything is offline: the provider is a recording fake and
 * the `CommandIo` is a literal object, so no test can reach a network, a real
 * stdin, or the real filesystem.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Command, CommanderError } from "commander";
import {
  createSitesHandlers,
  registerSitesCommands,
} from "../dist/cli/hosting/sites.js";
import { DEFAULT_WP_LANGUAGE } from "../dist/cli/payloads.js";
import { CliError, asCliError, exitCodeFor } from "../dist/errors.js";
import { createRenderer } from "../dist/output/render.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SITE = {
  id: "site-1",
  name: "example",
  displayName: "Example Site",
  status: "live",
  primaryDomain: "example.com",
};

const STAGING = {
  id: "env-2",
  name: "staging",
  displayName: "Staging",
  isBlocked: false,
  isPremium: true,
  wordpressVersion: "6.9",
};

const PRODUCTION = {
  id: "env-1",
  name: "production",
  displayName: "Production",
  isBlocked: false,
  isPremium: false,
};

const ACTION = {
  provider: "kinsta",
  action: "sites.create",
  status: 202,
  operationId: "op-1",
  raw: null,
};

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** An offline `CommandIo`: no real stdin, no real filesystem, no real env. */
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
      throw new Error("this group never writes a file");
    },
  };
}

/** A `ProviderClient` that records every request instead of making one. */
function fakeClient({ sites = [], site = SITE, environments = [] } = {}) {
  const calls = [];
  return {
    calls,
    provider: "kinsta",
    async validate() {
      throw new Error("validate is not part of this group");
    },
    async listSites(options) {
      calls.push({ method: "listSites", options });
      return sites;
    },
    async getSite(siteId) {
      calls.push({ method: "getSite", siteId });
      return site;
    },
    async listEnvironments(siteId) {
      calls.push({ method: "listEnvironments", siteId });
      return environments;
    },
    async action(request) {
      calls.push({ method: "action", request });
      return ACTION;
    },
    async operationStatus() {
      throw new Error("this group never polls an operation");
    },
  };
}

/**
 * Build the group's grammar over a throwaway program that mirrors the real
 * global options, including the `--profile` the v1 contract makes global.
 */
function harness({ client = fakeClient(), io = fakeIo(), profiles } = {}) {
  const known = profiles ?? { prod: { provider: "kinsta" } };
  const out = [];
  const err = [];
  const renderer = createRenderer(
    { json: true, requestId: "req-1" },
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
            { details: { profiles: Object.keys(known) } },
          );
        }
        const profile = known[requested];
        if (profile === undefined) {
          throw new CliError(
            "profile_not_found",
            `No hosting profile named ${requested}.`,
          );
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

  const program = new Command();
  program
    .exitOverride()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined })
    .option("--json", "emit one JSON envelope", false)
    .option("--quiet", "suppress diagnostics", false)
    .option("--verbose", "emit diagnostics", false)
    .option("--no-color", "disable colour")
    .option("--yes", "approve destructive operations", false)
    .option("--timeout <ms>", "operation timeout", Number, 30_000)
    .option("--profile <name>", "hosting profile");

  // The same shape program.ts uses: the innermost subcommand's options win
  // while the program's globals still apply.
  const optionsFor = (values) => {
    const active =
      values.findLast((value) => value instanceof Command) ?? program;
    return {
      ...active.optsWithGlobals(),
      timeoutExplicit:
        active.getOptionValueSourceWithGlobals("timeout") !== "default",
    };
  };

  const handlers = createSitesHandlers(dependencies);
  registerSitesCommands(program, handlers, optionsFor);
  // configureOutput only reaches commands that already exist, so re-apply it.
  for (const child of program.commands) {
    child.configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    });
    for (const grandchild of child.commands) {
      grandchild.configureOutput({
        writeOut: () => undefined,
        writeErr: () => undefined,
      });
    }
  }

  /** `main.ts` in miniature: parse, run, and funnel failures into one shape. */
  const run = async (...argv) => {
    try {
      await program.parseAsync(["--profile", "prod", ...argv], {
        from: "user",
      });
      return { code: 0, stdout: out.join(""), stderr: err.join("") };
    } catch (error) {
      const cliError =
        error instanceof CommanderError
          ? new CliError("usage_error", "Invalid command usage.")
          : asCliError(error);
      const code = renderer.failure(cliError);
      return {
        code,
        stdout: out.join(""),
        stderr: err.join(""),
        error: cliError,
      };
    }
  };

  return { program, client, run, envelope: () => JSON.parse(out.join("")) };
}

function commandNamed(parent, name) {
  const found = parent.commands.find((child) => child.name() === name);
  assert.ok(found, `no ${name} subcommand was registered`);
  return found;
}

function longFlags(command) {
  return command.options.map((option) => option.long);
}

/** The single provider request a successful invocation dispatched. */
async function dispatched(harnessed, ...argv) {
  const result = await harnessed.run(...argv);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(
    harnessed.client.calls.length,
    1,
    "a subcommand must dispatch exactly one provider request",
  );
  return harnessed.client.calls[0];
}

/** Run an invocation expected to fail, and return its failure envelope. */
async function failing(harnessed, ...argv) {
  const result = await harnessed.run(...argv);
  assert.notEqual(result.code, 0, "the invocation was expected to fail");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  return { ...result, envelope };
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

test("the sites and envs trees register exactly the ported subcommands", () => {
  const { program } = harness();
  const sites = commandNamed(program, "sites");
  const envs = commandNamed(program, "envs");

  assert.deepEqual(
    sites.commands.map((child) => child.name()),
    ["list", "get", "create", "create-plain", "clone", "reset"],
  );
  assert.deepEqual(
    envs.commands.map((child) => child.name()),
    ["list", "get", "create", "create-plain", "clone", "push", "delete"],
  );
});

// Ported from TestSitesDeleteCommandIsNotRegistered.
test("hosting sites delete is not registered", async () => {
  const { program } = harness();
  const sites = commandNamed(program, "sites");
  assert.equal(
    sites.commands.some((child) => child.name() === "delete"),
    false,
    "hosting sites delete must not be registered",
  );

  // And it is genuinely unreachable from argv, not merely hidden from help.
  const harnessed = harness();
  const { code, envelope } = await failing(harnessed, "sites", "delete", "s1");
  assert.equal(code, 2);
  assert.equal(envelope.error.code, "usage_error");
  assert.equal(harnessed.client.calls.length, 0);
});

test("the retained sitesDelete handler still dispatches delete-site", async () => {
  // Go kept `newSitesDeleteCommand` so the provider action wiring would survive
  // if the command were ever restored. The handler is kept for the same reason
  // and must stay callable — but only from code, never from argv.
  const client = fakeClient();
  const out = [];
  const renderer = createRenderer(
    { json: true, requestId: "req-1" },
    {
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: () => undefined },
    },
  );
  const handlers = createSitesHandlers({
    store: {
      async selectHostingProfile(name) {
        return { name, profile: { provider: "kinsta" } };
      },
    },
    hosting: {
      async clientFromEntry() {
        return client;
      },
    },
    io: fakeIo(),
    rendererFor: () => renderer,
  });

  await handlers.sitesDelete("site-1", { json: true, profile: "prod" });
  assert.deepEqual(client.calls, [
    { method: "action", request: { kind: "delete-site", siteId: "site-1" } },
  ]);
  assert.equal(JSON.parse(out.join("")).ok, true);
});

test("sites create registers every Go flag, in order, and no bare secret", () => {
  const { program } = harness();
  const create = commandNamed(commandNamed(program, "sites"), "create");
  assert.deepEqual(longFlags(create), [
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
  ]);
  // A secret is never a command-line value: there is no bare --admin-password.
  assert.equal(longFlags(create).includes("--admin-password"), false);
  // No short forms: the Go CLI declared none, and adding one would be new API.
  assert.deepEqual(
    create.options.filter((option) => option.short !== undefined),
    [],
  );
});

test("the remaining sites subcommands register their Go flags", () => {
  const { program } = harness();
  const sites = commandNamed(program, "sites");

  assert.deepEqual(longFlags(commandNamed(sites, "list")), ["--include-envs"]);
  assert.deepEqual(longFlags(commandNamed(sites, "get")), []);
  assert.deepEqual(longFlags(commandNamed(sites, "create-plain")), [
    "--from-json",
    "--display-name",
    "--region",
  ]);
  assert.deepEqual(longFlags(commandNamed(sites, "clone")), [
    "--from-json",
    "--display-name",
    "--source-env",
  ]);
  assert.deepEqual(longFlags(commandNamed(sites, "reset")), [
    "--from-json",
    "--admin-password-env",
    "--admin-password-stdin",
    "--admin-password-file",
  ]);
});

test("the envs subcommands register their Go flags", () => {
  const { program } = harness();
  const envs = commandNamed(program, "envs");

  assert.deepEqual(longFlags(commandNamed(envs, "list")), ["--site"]);
  assert.deepEqual(longFlags(commandNamed(envs, "get")), ["--site"]);
  assert.deepEqual(longFlags(commandNamed(envs, "delete")), []);
  assert.deepEqual(longFlags(commandNamed(envs, "create")), [
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
  ]);
  assert.deepEqual(longFlags(commandNamed(envs, "create-plain")), [
    "--site",
    "--from-json",
    "--display-name",
    "--is-premium",
  ]);
  assert.deepEqual(longFlags(commandNamed(envs, "clone")), [
    "--site",
    "--from-json",
    "--display-name",
    "--source-env",
    "--is-premium",
  ]);
  assert.deepEqual(longFlags(commandNamed(envs, "push")), [
    "--site",
    "--from-json",
    "--source-env",
    "--target-env",
    "--no-db",
    "--no-files",
    "--no-search-replace",
    "--file",
  ]);
});

/* -------------------------------------------------------------------------- */
/* Reads: sites list / get, envs list / get                                   */
/* -------------------------------------------------------------------------- */

test("sites list asks for environments only with --include-envs", async () => {
  assert.deepEqual(await dispatched(harness(), "sites", "list"), {
    method: "listSites",
    options: { includeEnvironments: false },
  });
  assert.deepEqual(
    await dispatched(harness(), "sites", "list", "--include-envs"),
    { method: "listSites", options: { includeEnvironments: true } },
  );
});

test("sites list renders the serialized site array", async () => {
  const harnessed = harness({
    client: fakeClient({ sites: [{ ...SITE, environments: [STAGING] }] }),
  });
  const result = await harnessed.run("sites", "list", "--include-envs");
  assert.equal(result.code, 0);
  const envelope = harnessed.envelope();
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data, [
    {
      id: "site-1",
      name: "example",
      display_name: "Example Site",
      status: "live",
      primary_domain: "example.com",
      environments: [
        {
          id: "env-2",
          name: "staging",
          display_name: "Staging",
          is_blocked: false,
          is_premium: true,
          wordpress_version: "6.9",
        },
      ],
    },
  ]);
  assert.deepEqual(envelope.meta, {
    requestId: "req-1",
    profile: "prod",
    provider: "kinsta",
  });
});

test("sites get passes the positional site id through", async () => {
  const harnessed = harness();
  assert.deepEqual(await dispatched(harnessed, "sites", "get", "site-1"), {
    method: "getSite",
    siteId: "site-1",
  });
  assert.equal(harnessed.envelope().data.id, "site-1");
});

test("envs list scopes to --site, defaulting to the empty Go scope", async () => {
  assert.deepEqual(await dispatched(harness(), "envs", "list"), {
    method: "listEnvironments",
    siteId: "",
  });
  assert.deepEqual(
    await dispatched(harness(), "envs", "list", "--site", "site-1"),
    { method: "listEnvironments", siteId: "site-1" },
  );
});

test("envs get matches an id inside the listed environments", async () => {
  const harnessed = harness({
    client: fakeClient({ environments: [PRODUCTION, STAGING] }),
  });
  assert.deepEqual(
    await dispatched(harnessed, "envs", "get", "env-2", "--site", "site-1"),
    { method: "listEnvironments", siteId: "site-1" },
  );
  assert.deepEqual(harnessed.envelope().data, {
    id: "env-2",
    name: "staging",
    display_name: "Staging",
    is_blocked: false,
    is_premium: true,
    wordpress_version: "6.9",
  });
});

test("envs get reports an unmatched id as not_found, not as an empty result", async () => {
  const harnessed = harness({
    client: fakeClient({ environments: [STAGING] }),
  });
  const { code, envelope } = await failing(
    harnessed,
    "envs",
    "get",
    "env-9",
    "--site",
    "site-1",
  );
  assert.equal(envelope.error.code, "not_found");
  assert.equal(code, 4);
  assert.equal(
    envelope.error.message,
    'Environment "env-9" was not found for site "site-1".',
  );
  assert.deepEqual(envelope.error.details, {
    environment: "env-9",
    site: "site-1",
  });
});

/* -------------------------------------------------------------------------- */
/* Actions: the three site create modes                                       */
/* -------------------------------------------------------------------------- */

test("sites create dispatches the WordPress mode with the full install body", async () => {
  const harnessed = harness({ io: fakeIo({ env: { ADMIN_PW: "s3cr3t" } }) });
  const call = await dispatched(
    harnessed,
    "sites",
    "create",
    "--display-name",
    "Example",
    "--region",
    "europe-west1",
    "--site-title",
    "Example Site",
    "--admin-email",
    "admin@example.com",
    "--admin-user",
    "admin",
    "--admin-password-env",
    "ADMIN_PW",
    "--is-multisite",
    "--woocommerce",
  );
  assert.deepEqual(call.request, {
    kind: "create-site",
    mode: "wordpress",
    body: {
      display_name: "Example",
      region: "europe-west1",
      install_mode: "new",
      admin_email: "admin@example.com",
      admin_password: "s3cr3t",
      admin_user: "admin",
      site_title: "Example Site",
      // The commander default must be the payload default.
      wp_language: DEFAULT_WP_LANGUAGE,
      is_multisite: true,
      is_subdomain_multisite: false,
      woocommerce: true,
      wordpressseo: false,
    },
  });
  // The action envelope reports the provider result, never the request body.
  const envelope = harnessed.envelope();
  assert.deepEqual(envelope.data, {
    provider: "kinsta",
    action: "sites.create",
    status: 202,
    operation_id: "op-1",
    raw: null,
  });
  assert.equal(JSON.stringify(envelope).includes("s3cr3t"), false);
});

test("sites create honours --wp-language over the default", async () => {
  const harnessed = harness({ io: fakeIo({ env: { ADMIN_PW: "s3cr3t" } }) });
  const call = await dispatched(
    harnessed,
    "sites",
    "create",
    "--display-name",
    "Example",
    "--region",
    "eu",
    "--site-title",
    "Example",
    "--admin-email",
    "a@b.c",
    "--admin-user",
    "admin",
    "--admin-password-env",
    "ADMIN_PW",
    "--wp-language",
    "it_IT",
  );
  assert.equal(call.request.body.wp_language, "it_IT");
});

test("sites create switches to the InstaWP template body", async () => {
  const call = await dispatched(
    harness(),
    "sites",
    "create",
    "--site-name",
    "demo",
    "--template-slug",
    "starter",
    "--shared",
    "--email",
    "guest@example.com",
  );
  assert.deepEqual(call.request, {
    kind: "create-site",
    mode: "wordpress",
    body: {
      site_name: "demo",
      template_slug: "starter",
      is_shared: true,
      email: "guest@example.com",
    },
  });

  // --reserved alone is enough, and no install option is then required.
  const reserved = await dispatched(harness(), "sites", "create", "--reserved");
  assert.deepEqual(reserved.request.body, { is_reserved: true });
});

test("sites create-plain and clone dispatch their own create modes", async () => {
  assert.deepEqual(
    (
      await dispatched(
        harness(),
        "sites",
        "create-plain",
        "--display-name",
        "Plain",
        "--region",
        "eu",
      )
    ).request,
    {
      kind: "create-site",
      mode: "plain",
      body: { display_name: "Plain", region: "eu" },
    },
  );

  assert.deepEqual(
    (
      await dispatched(
        harness(),
        "sites",
        "clone",
        "--display-name",
        "Copy",
        "--source-env",
        "env-1",
      )
    ).request,
    {
      kind: "create-site",
      mode: "clone",
      body: { display_name: "Copy", source_env_id: "env-1" },
    },
  );
});

test("sites reset carries the positional id and the admin password", async () => {
  const harnessed = harness({ io: fakeIo({ env: { ADMIN_PW: "s3cr3t" } }) });
  const call = await dispatched(
    harnessed,
    "sites",
    "reset",
    "site-1",
    "--admin-password-env",
    "ADMIN_PW",
  );
  assert.deepEqual(call.request, {
    kind: "reset-site",
    siteId: "site-1",
    body: { admin_password: "s3cr3t" },
  });
  assert.equal(JSON.stringify(harnessed.envelope()).includes("s3cr3t"), false);
});

/* -------------------------------------------------------------------------- */
/* Actions: environments                                                      */
/* -------------------------------------------------------------------------- */

test("envs create dispatches the WordPress mode against its parent site", async () => {
  const harnessed = harness({
    io: fakeIo({ files: { "/pw": "s3cr3t" } }),
  });
  const call = await dispatched(
    harnessed,
    "envs",
    "create",
    "--site",
    "site-1",
    "--display-name",
    "staging",
    "--site-title",
    "Staging",
    "--admin-email",
    "a@b.c",
    "--admin-user",
    "admin",
    "--admin-password-file",
    "/pw",
    "--is-premium",
    "--wordpress-plugin-edd",
  );
  assert.deepEqual(call.request, {
    kind: "create-environment",
    siteId: "site-1",
    mode: "wordpress",
    body: {
      display_name: "staging",
      site_title: "Staging",
      is_premium: true,
      admin_email: "a@b.c",
      admin_password: "s3cr3t",
      admin_user: "admin",
      wp_language: DEFAULT_WP_LANGUAGE,
      is_multisite: false,
      is_subdomain_multisite: false,
      woocommerce: false,
      wordpress_plugin_edd: true,
      wordpressseo: false,
    },
  });
  // `--site` is a request field, never a payload field.
  assert.equal(Object.hasOwn(call.request.body, "site"), false);
});

test("envs create-plain, clone and delete keep their Go requests", async () => {
  assert.deepEqual(
    (
      await dispatched(
        harness(),
        "envs",
        "create-plain",
        "--site",
        "site-1",
        "--display-name",
        "staging",
      )
    ).request,
    {
      kind: "create-environment",
      siteId: "site-1",
      mode: "plain",
      body: { display_name: "staging", is_premium: false },
    },
  );

  assert.deepEqual(
    (
      await dispatched(
        harness(),
        "envs",
        "clone",
        "--site",
        "site-1",
        "--display-name",
        "copy",
        "--source-env",
        "env-1",
        "--is-premium",
      )
    ).request,
    {
      kind: "create-environment",
      siteId: "site-1",
      mode: "clone",
      body: {
        display_name: "copy",
        source_env_id: "env-1",
        is_premium: true,
      },
    },
  );

  assert.deepEqual(
    (await dispatched(harness(), "envs", "delete", "env-1")).request,
    { kind: "delete-environment", envId: "env-1" },
  );
});

test("envs push defaults to pushing everything", async () => {
  const call = await dispatched(
    harness(),
    "envs",
    "push",
    "--site",
    "site-1",
    "--source-env",
    "env-1",
    "--target-env",
    "env-2",
  );
  assert.deepEqual(call.request, {
    kind: "push-environment",
    siteId: "site-1",
    body: {
      source_env_id: "env-1",
      target_env_id: "env-2",
      push_db: true,
      push_files: true,
      run_search_and_replace: true,
      push_files_option: "ALL_FILES",
    },
  });
});

test("envs push inverts the --no-* flags and collects repeated --file", async () => {
  const call = await dispatched(
    harness(),
    "envs",
    "push",
    "--source-env",
    "env-1",
    "--target-env",
    "env-2",
    "--no-db",
    "--no-search-replace",
    "--file",
    "wp-content/uploads",
    "--file",
    "wp-content/themes",
  );
  assert.deepEqual(call.request, {
    kind: "push-environment",
    // Go passed the zero value when --site was omitted.
    siteId: "",
    body: {
      source_env_id: "env-1",
      target_env_id: "env-2",
      push_db: false,
      push_files: true,
      run_search_and_replace: false,
      push_files_option: "SPECIFIC_FILES",
      file_list: ["wp-content/uploads", "wp-content/themes"],
    },
  });
});

test("envs push --no-files still pushes the database", async () => {
  const call = await dispatched(
    harness(),
    "envs",
    "push",
    "--source-env",
    "env-1",
    "--target-env",
    "env-2",
    "--no-files",
  );
  assert.equal(call.request.body.push_files, false);
  assert.equal(call.request.body.push_db, true);
});

/* -------------------------------------------------------------------------- */
/* --from-json                                                                */
/* -------------------------------------------------------------------------- */

test("--from-json replaces the built body on every payload subcommand", async () => {
  const io = fakeIo({
    files: { "/body.json": '{"display_name":"From File","extra":[1,2]}' },
    stdin: '{"display_name":"From Stdin"}',
  });

  const fromFile = await dispatched(
    harness({ io }),
    "sites",
    "create",
    "--from-json",
    "/body.json",
  );
  assert.deepEqual(fromFile.request.body, {
    display_name: "From File",
    extra: [1, 2],
  });

  const fromStdin = await dispatched(
    harness({ io }),
    "envs",
    "push",
    "--site",
    "site-1",
    "--from-json",
    "-",
  );
  assert.deepEqual(fromStdin.request.body, { display_name: "From Stdin" });

  // A malformed payload is a usage error, not a provider call.
  const broken = harness({ io: fakeIo({ files: { "/bad.json": "{oops" } }) });
  const { envelope } = await failing(
    broken,
    "sites",
    "clone",
    "--from-json",
    "/bad.json",
  );
  assert.equal(envelope.error.code, "usage_error");
  assert.equal(broken.client.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Validation and the usage_error mapping                                     */
/* -------------------------------------------------------------------------- */

test("a missing required option fails usage_error before any provider call", async () => {
  const cases = [
    [["sites", "create"], "--display-name"],
    [["sites", "create-plain", "--display-name", "x"], "--region"],
    [["sites", "clone", "--display-name", "x"], "--source-env"],
    [["envs", "create", "--site", "s1"], "--display-name"],
    [["envs", "create-plain"], "--display-name"],
    [["envs", "clone", "--display-name", "x"], "--source-env"],
    [["envs", "push"], "--source-env"],
    [["envs", "push", "--source-env", "a"], "--target-env"],
  ];
  for (const [argv, flag] of cases) {
    const harnessed = harness();
    const { code, envelope } = await failing(harnessed, ...argv);
    assert.equal(code, 2, argv.join(" "));
    assert.equal(envelope.error.code, "usage_error", argv.join(" "));
    assert.equal(
      envelope.error.message,
      `${flag} is required unless --from-json is used.`,
      argv.join(" "),
    );
    assert.equal(envelope.error.details.flag, flag);
    assert.equal(harnessed.client.calls.length, 0, argv.join(" "));
  }
});

test("an empty string counts as an absent option, as cobra had it", async () => {
  const harnessed = harness();
  const { envelope } = await failing(
    harnessed,
    "sites",
    "create-plain",
    "--display-name",
    "",
    "--region",
    "eu",
  );
  assert.equal(envelope.error.code, "usage_error");
  assert.equal(envelope.error.details.flag, "--display-name");
});

test("a missing positional argument is commander's error, mapped to usage_error", async () => {
  for (const argv of [
    ["sites", "get"],
    ["sites", "reset"],
    ["envs", "get"],
    ["envs", "delete"],
  ]) {
    const harnessed = harness();
    const { code, envelope } = await failing(harnessed, ...argv);
    assert.equal(code, 2, argv.join(" "));
    assert.equal(envelope.error.code, "usage_error", argv.join(" "));
    assert.equal(harnessed.client.calls.length, 0, argv.join(" "));
  }
});

test("an unknown option or subcommand never reaches a provider", async () => {
  for (const argv of [
    ["sites", "list", "--include-environments"],
    ["sites", "nope"],
    ["envs", "push", "--files"],
  ]) {
    const harnessed = harness();
    const { code, envelope } = await failing(harnessed, ...argv);
    assert.equal(code, 2, argv.join(" "));
    assert.equal(envelope.error.code, "usage_error", argv.join(" "));
    assert.equal(harnessed.client.calls.length, 0, argv.join(" "));
  }
});

test("a secret must name exactly one source, and an absent one exits 3", async () => {
  const harnessed = harness();
  const missingSource = await failing(harnessed, "sites", "reset", "site-1");
  assert.equal(missingSource.code, 2);
  assert.equal(missingSource.envelope.error.code, "usage_error");
  assert.match(
    missingSource.envelope.error.message,
    /exactly one of --admin-password-env, --admin-password-stdin, or --admin-password-file/,
  );

  const both = harness();
  const conflicting = await failing(
    both,
    "sites",
    "reset",
    "site-1",
    "--admin-password-env",
    "PW",
    "--admin-password-stdin",
  );
  assert.equal(conflicting.envelope.error.code, "usage_error");

  const absent = harness({ io: fakeIo({ env: {} }) });
  const unset = await failing(
    absent,
    "sites",
    "reset",
    "site-1",
    "--admin-password-env",
    "ADMIN_PW",
  );
  assert.equal(unset.code, 3);
  assert.equal(unset.envelope.error.code, "credential_missing");
  assert.equal(unset.envelope.error.details.source, "env:ADMIN_PW");
  assert.equal(absent.client.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Profile resolution and the failure envelope                                */
/* -------------------------------------------------------------------------- */

test("every subcommand needs a profile, and it is never inferred", async () => {
  const harnessed = harness();
  // Bypass the harness's default --profile by parsing argv directly.
  let thrown;
  await assert.rejects(
    harnessed.program.parseAsync(["sites", "list"], { from: "user" }),
    (error) => {
      thrown = error;
      return true;
    },
  );
  assert.equal(thrown.code, "usage_error");
  assert.deepEqual(thrown.details.profiles, ["prod"]);
  assert.equal(harnessed.client.calls.length, 0);
});

test("an unknown profile fails profile_not_found with exit 2", async () => {
  const harnessed = harness();
  let thrown;
  await assert.rejects(
    harnessed.program.parseAsync(["--profile", "nope", "sites", "list"], {
      from: "user",
    }),
    (error) => {
      thrown = error;
      return true;
    },
  );
  assert.equal(thrown.code, "profile_not_found");
  assert.equal(exitCodeFor(thrown), 2);
});

test("a provider failure is rendered as the v1 failure envelope", async () => {
  const failingClient = fakeClient();
  failingClient.action = async () => {
    throw new CliError("provider_error", "Kinsta rejected the request.", {
      remoteCode: "site_limit_reached",
      details: { provider: "kinsta" },
    });
  };
  const harnessed = harness({ client: failingClient });
  const { code, envelope } = await failing(
    harnessed,
    "sites",
    "create-plain",
    "--display-name",
    "Plain",
    "--region",
    "eu",
  );
  assert.equal(code, 4);
  assert.deepEqual(envelope, {
    ok: false,
    error: {
      code: "provider_error",
      message: "Kinsta rejected the request.",
      retryable: false,
      remoteCode: "site_limit_reached",
      details: { provider: "kinsta" },
    },
  });
});

test("human mode prints Go's table instead of the JSON envelope", async () => {
  const out = [];
  const renderer = createRenderer(
    { json: false, color: false, requestId: "req-1" },
    {
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: () => undefined },
    },
  );
  const client = fakeClient({ sites: [{ ...SITE, environments: [STAGING] }] });
  const handlers = createSitesHandlers({
    store: {
      async selectHostingProfile(name) {
        return { name, profile: { provider: "kinsta" } };
      },
    },
    hosting: {
      async clientFromEntry() {
        return client;
      },
    },
    io: fakeIo(),
    rendererFor: () => renderer,
  });

  await handlers.sitesList(
    { includeEnvs: true },
    {
      json: false,
      quiet: false,
      verbose: false,
      color: false,
      yes: false,
      timeout: 30_000,
      timeoutExplicit: false,
      profile: "prod",
    },
  );

  const lines = out.join("").trimEnd().split("\n");
  assert.match(lines[0], /^ID\s+DISPLAY NAME\s+STATUS\s+DOMAIN$/);
  assert.match(lines[1], /^site-1\s+Example Site\s+live\s+example\.com$/);
  assert.match(lines[2], /^ {2}env env-2\s+Staging\s+-$/);
});
