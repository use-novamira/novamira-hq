// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract test for `hosting domains …` and `hosting dns …`.
 *
 * Everything here is offline: the provider is a fake `ProviderClient` that
 * records the request it was handed, the profile store is a two-method stub,
 * and stdin/files come from a fake `CommandIo`. No test may reach a network.
 *
 * `program.ts` does not yet register this group (integration owns that), so the
 * grammar is attached to a throwaway `Command` that mirrors the program's
 * globals and its `optionsFor` resolver.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Command, CommanderError } from "commander";
import {
  createDomainsHandlers,
  registerDomainsCommands,
} from "../dist/cli/hosting/domains.js";
import { CliError, asCliError, exitCodeFor } from "../dist/errors.js";
import { createRenderer } from "../dist/output/render.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** An offline CommandIo: no real stdin, no real filesystem, no real env. */
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

const DEFAULT_ACTION = {
  provider: "kinsta",
  action: "domains.add",
  status: 202,
  raw: null,
};

/**
 * Build the whole world a handler sees: a recording client, a profile store
 * that only knows `prod`, a JSON renderer over captured streams, and the
 * commander program the group is registered onto.
 */
function harness(options = {}) {
  // `read` is looked up rather than defaulted, so a test can assert what an
  // empty provider response (`undefined`) renders as.
  const read = Object.hasOwn(options, "read") ? options.read : { records: [] };
  const { action = DEFAULT_ACTION, fail, io = {} } = options;
  const calls = { read: [], action: [] };
  const client = {
    provider: "kinsta",
    async read(request) {
      calls.read.push(request);
      if (fail !== undefined) throw fail;
      return read;
    },
    async action(request) {
      calls.action.push(request);
      if (fail !== undefined) throw fail;
      return action;
    },
  };

  const chunks = { out: [], err: [] };
  const renderer = createRenderer(
    { json: true, requestId: "req-1" },
    {
      stdout: { write: (chunk) => chunks.out.push(chunk) },
      stderr: { write: (chunk) => chunks.err.push(chunk) },
    },
  );

  const dependencies = {
    store: {
      async selectHostingProfile(requested) {
        if (requested === undefined || requested === "") {
          throw new CliError(
            "usage_error",
            "Select a hosting profile with --profile.",
            { details: { profiles: ["prod"] } },
          );
        }
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
    io: fakeIo(io),
    rendererFor: () => renderer,
  };

  const program = new Command();
  program
    .name("novamira-hq")
    .exitOverride()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined })
    .option("--json", "emit exactly one JSON value on stdout", false)
    .option("--profile <name>", "hosting profile");

  const optionsFor = (values) => {
    const active =
      values.findLast((value) => value instanceof Command) ?? program;
    return {
      ...active.optsWithGlobals(),
      timeoutExplicit: false,
    };
  };

  const hosting = program.command("hosting").description("hosting operations");
  registerDomainsCommands(
    hosting,
    createDomainsHandlers(dependencies),
    optionsFor,
  );

  return { calls, chunks, client, hosting, program, renderer };
}

/**
 * Parse and run, mirroring `main.ts`: a commander failure becomes a
 * `usage_error`, anything else goes through `asCliError`, and the renderer
 * produces the failure envelope and the exit code.
 */
async function run(context, argv) {
  try {
    await context.program.parseAsync(["--profile", "prod", ...argv], {
      from: "user",
    });
  } catch (error) {
    const cliError =
      error instanceof CommanderError
        ? new CliError("usage_error", "Invalid command usage.")
        : asCliError(error);
    return {
      code: context.renderer.failure(cliError),
      envelope: JSON.parse(context.chunks.out.join("")),
      error: cliError,
    };
  }
  return {
    code: 0,
    envelope: JSON.parse(context.chunks.out.join("")),
    error: undefined,
  };
}

/** Run and assert the invocation succeeded, returning the success envelope. */
async function succeeds(context, argv) {
  const result = await run(context, argv);
  assert.equal(result.error, undefined, String(result.error?.message));
  assert.equal(result.envelope.ok, true);
  return result.envelope;
}

/** Run and assert the invocation failed with `code`, returning the CliError. */
async function fails(code, context, argv) {
  const result = await run(context, argv);
  assert.notEqual(result.error, undefined, "expected the invocation to fail");
  assert.equal(result.error.code, code, result.error.message);
  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.error.code, code);
  assert.equal(result.code, exitCodeFor(result.error));
  return result.error;
}

function subcommandNames(command, path) {
  let current = command;
  for (const name of path) {
    current = current.commands.find((child) => child.name() === name);
    assert.ok(current, `missing subcommand ${name}`);
  }
  return current;
}

function longFlags(command) {
  return command.options.map((option) => option.long);
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

test("the group registers exactly the Go command tree", () => {
  const { hosting } = harness();

  assert.deepEqual(
    hosting.commands.map((command) => command.name()),
    ["domains", "dns"],
  );
  assert.deepEqual(
    subcommandNames(hosting, ["domains"]).commands.map((c) => c.name()),
    ["list", "add", "delete", "verify", "primary"],
  );
  assert.deepEqual(
    subcommandNames(hosting, ["dns"]).commands.map((c) => c.name()),
    ["domains", "records"],
  );
  assert.deepEqual(
    subcommandNames(hosting, ["dns", "domains"]).commands.map((c) => c.name()),
    ["list"],
  );
  assert.deepEqual(
    subcommandNames(hosting, ["dns", "records"]).commands.map((c) => c.name()),
    ["list", "create", "update", "delete"],
  );
});

test("every subcommand carries exactly the Go flags", () => {
  const { hosting } = harness();
  const flagsOf = (path) => longFlags(subcommandNames(hosting, path));

  assert.deepEqual(flagsOf(["domains", "list"]), ["--env"]);
  assert.deepEqual(flagsOf(["domains", "add"]), [
    "--env",
    "--domain-name",
    "--is-wildcardless",
    "--add-with-www-subdomain",
    "--setup-type",
    "--custom-ssl-key-file",
    "--custom-ssl-cert-file",
    "--from-json",
  ]);
  assert.deepEqual(flagsOf(["domains", "delete"]), [
    "--env",
    "--domain-id",
    "--from-json",
  ]);
  assert.deepEqual(flagsOf(["domains", "verify"]), []);
  assert.deepEqual(flagsOf(["domains", "primary"]), [
    "--env",
    "--domain-id",
    "--search-replace",
    "--from-json",
  ]);
  assert.deepEqual(flagsOf(["dns", "domains", "list"]), ["--company"]);
  assert.deepEqual(flagsOf(["dns", "records", "list"]), ["--domain"]);
  assert.deepEqual(flagsOf(["dns", "records", "create"]), [
    "--domain",
    "--record-type",
    "--name",
    "--ttl",
    "--value",
    "--from-json",
  ]);
  assert.deepEqual(flagsOf(["dns", "records", "update"]), [
    "--domain",
    "--record-type",
    "--name",
    "--ttl",
    "--add-value",
    "--remove-value",
    "--from-json",
  ]);
  assert.deepEqual(flagsOf(["dns", "records", "delete"]), [
    "--domain",
    "--record-type",
    "--name",
    "--from-json",
  ]);

  // `domains verify` takes the site domain id as a required argument, as
  // cobra's ExactArgs(1) did, not as a flag.
  const verify = subcommandNames(hosting, ["domains", "verify"]);
  assert.deepEqual(
    verify.registeredArguments.map((argument) => [
      argument.name(),
      argument.required,
    ]),
    [["site_domain_id", true]],
  );

  // The boundary rule and the secret rule: no site token, no bare secret.
  const everyFlag = [];
  const walk = (command) => {
    everyFlag.push(...longFlags(command));
    for (const child of command.commands) walk(child);
  };
  walk(hosting);
  for (const flag of everyFlag) {
    assert.doesNotMatch(flag, /password|token|secret|application-password/);
  }
});

test("--setup-type is constrained at parse time, unlike Go's late validateEnum", async () => {
  const context = harness();
  await fails("usage_error", context, [
    "hosting",
    "domains",
    "add",
    "--env",
    "env-1",
    "--domain-name",
    "example.test",
    "--setup-type",
    "eventually",
  ]);
  // Nothing was dispatched: the parse failed before a client existed.
  assert.deepEqual(context.calls.action, []);
});

test("--ttl only accepts a non-negative integer", async () => {
  const context = harness();
  await fails("usage_error", context, [
    "hosting",
    "dns",
    "records",
    "create",
    "--domain",
    "dom-1",
    "--record-type",
    "A",
    "--name",
    "www",
    "--ttl",
    "-1",
    "--value",
    "1.2.3.4",
  ]);
  assert.deepEqual(context.calls.action, []);
});

/* -------------------------------------------------------------------------- */
/* domains                                                                    */
/* -------------------------------------------------------------------------- */

test("domains list reads the site domains of one environment", async () => {
  const context = harness({ read: [{ id: "d1" }] });
  const envelope = await succeeds(context, [
    "hosting",
    "domains",
    "list",
    "--env",
    "env-1",
  ]);

  assert.deepEqual(context.calls.read, [
    { kind: "site-domains", envId: "env-1" },
  ]);
  assert.deepEqual(envelope.data, [{ id: "d1" }]);
  assert.deepEqual(envelope.meta, {
    requestId: "req-1",
    profile: "prod",
    provider: "kinsta",
  });
});

test("an empty provider response renders as null, as Go's parseJSONBody did", async () => {
  const context = harness({ read: undefined });
  const envelope = await succeeds(context, [
    "hosting",
    "domains",
    "list",
    "--env",
    "env-1",
  ]);
  assert.equal(envelope.data, null);
});

test("a resource identifier is required before any provider request", async () => {
  for (const argv of [
    ["hosting", "domains", "list"],
    ["hosting", "domains", "list", "--env", ""],
  ]) {
    const context = harness();
    const error = await fails("usage_error", context, argv);
    assert.equal(error.message, "--env is required.");
    assert.deepEqual(error.details, { flag: "--env" });
    assert.deepEqual(context.calls.read, []);
  }
});

test("domains add builds the Go payload and dispatches add-domain", async () => {
  const context = harness({
    io: {
      files: {
        "/tmp/key.pem": "PRIVATE KEY",
        "/tmp/cert.pem": "CERTIFICATE",
      },
    },
  });
  const envelope = await succeeds(context, [
    "hosting",
    "domains",
    "add",
    "--env",
    "env-1",
    "--domain-name",
    "example.test",
    "--is-wildcardless",
    "--add-with-www-subdomain",
    "--setup-type",
    "avoid_downtime",
    "--custom-ssl-key-file",
    "/tmp/key.pem",
    "--custom-ssl-cert-file",
    "/tmp/cert.pem",
  ]);

  assert.deepEqual(context.calls.action, [
    {
      kind: "add-domain",
      envId: "env-1",
      body: {
        domain_name: "example.test",
        is_wildcardless: true,
        add_with_www_subdomain: true,
        setup_type: "avoid_downtime",
        custom_ssl_key: "PRIVATE KEY",
        custom_ssl_cert: "CERTIFICATE",
      },
    },
  ]);
  assert.equal(envelope.data.action, "domains.add");
  assert.equal(envelope.data.status, 202);
});

test("domains add defaults the booleans to false and omits an unset setup type", async () => {
  const context = harness();
  await succeeds(context, [
    "hosting",
    "domains",
    "add",
    "--env",
    "env-1",
    "--domain-name",
    "example.test",
  ]);
  assert.deepEqual(context.calls.action[0].body, {
    domain_name: "example.test",
    is_wildcardless: false,
    add_with_www_subdomain: false,
  });
});

test("domains add requires --domain-name unless --from-json is used", async () => {
  const missing = harness();
  const error = await fails("usage_error", missing, [
    "hosting",
    "domains",
    "add",
    "--env",
    "env-1",
  ]);
  assert.equal(
    error.message,
    "--domain-name is required unless --from-json is used.",
  );

  const fromStdin = harness({ io: { stdin: '{"domain_name":"raw.test"}' } });
  await succeeds(fromStdin, [
    "hosting",
    "domains",
    "add",
    "--env",
    "env-1",
    "--from-json",
    "-",
  ]);
  // --from-json wins verbatim: no defaults are merged in.
  assert.deepEqual(fromStdin.calls.action[0].body, { domain_name: "raw.test" });
});

test("an unreadable custom SSL file is a usage error naming the path", async () => {
  const context = harness();
  const error = await fails("usage_error", context, [
    "hosting",
    "domains",
    "add",
    "--env",
    "env-1",
    "--domain-name",
    "example.test",
    "--custom-ssl-key-file",
    "/nope/key.pem",
  ]);
  assert.deepEqual(error.details, { path: "/nope/key.pem" });
  assert.deepEqual(context.calls.action, []);
});

test("domains delete collects every --domain-id in order", async () => {
  const context = harness();
  await succeeds(context, [
    "hosting",
    "domains",
    "delete",
    "--env",
    "env-1",
    "--domain-id",
    "d1",
    "--domain-id",
    "d2",
  ]);
  assert.deepEqual(context.calls.action, [
    {
      kind: "delete-domains",
      envId: "env-1",
      body: { domain_ids: ["d1", "d2"] },
    },
  ]);
});

test("domains delete refuses an empty domain id list", async () => {
  const context = harness();
  const error = await fails("usage_error", context, [
    "hosting",
    "domains",
    "delete",
    "--env",
    "env-1",
  ]);
  assert.deepEqual(error.details, { flag: "--domain-id" });
});

test("domains verify reads the verification of the positional site domain id", async () => {
  const context = harness({ read: { verified: false } });
  const envelope = await succeeds(context, [
    "hosting",
    "domains",
    "verify",
    "sd-77",
  ]);
  assert.deepEqual(context.calls.read, [
    { kind: "site-domain-verification", siteDomainId: "sd-77" },
  ]);
  assert.deepEqual(envelope.data, { verified: false });
});

test("domains verify rejects a missing or empty site domain id", async () => {
  await fails("usage_error", harness(), ["hosting", "domains", "verify"]);
  const empty = harness();
  const error = await fails("usage_error", empty, [
    "hosting",
    "domains",
    "verify",
    "",
  ]);
  assert.deepEqual(error.details, { flag: "<site_domain_id>" });
  assert.deepEqual(empty.calls.read, []);
});

test("domains primary sends the domain id and the search-replace switch", async () => {
  const context = harness();
  await succeeds(context, [
    "hosting",
    "domains",
    "primary",
    "--env",
    "env-1",
    "--domain-id",
    "d9",
    "--search-replace",
  ]);
  assert.deepEqual(context.calls.action, [
    {
      kind: "change-primary-domain",
      envId: "env-1",
      body: { domain_id: "d9", run_search_and_replace: true },
    },
  ]);

  const defaults = harness();
  await succeeds(defaults, [
    "hosting",
    "domains",
    "primary",
    "--env",
    "env-1",
    "--domain-id",
    "d9",
  ]);
  assert.equal(defaults.calls.action[0].body.run_search_and_replace, false);
});

/* -------------------------------------------------------------------------- */
/* dns                                                                        */
/* -------------------------------------------------------------------------- */

test("dns domains list omits an unset company, as Go's optStr did", async () => {
  const implicit = harness({ read: [] });
  await succeeds(implicit, ["hosting", "dns", "domains", "list"]);
  assert.deepEqual(implicit.calls.read, [{ kind: "dns-domains" }]);

  const empty = harness({ read: [] });
  await succeeds(empty, ["hosting", "dns", "domains", "list", "--company", ""]);
  assert.deepEqual(empty.calls.read, [{ kind: "dns-domains" }]);

  const explicit = harness({ read: [] });
  await succeeds(explicit, [
    "hosting",
    "dns",
    "domains",
    "list",
    "--company",
    "co-1",
  ]);
  assert.deepEqual(explicit.calls.read, [
    { kind: "dns-domains", companyId: "co-1" },
  ]);
});

test("dns records list reads the records of one domain", async () => {
  const context = harness({ read: [{ name: "www" }] });
  await succeeds(context, [
    "hosting",
    "dns",
    "records",
    "list",
    "--domain",
    "dom-1",
  ]);
  assert.deepEqual(context.calls.read, [
    { kind: "dns-records", domainId: "dom-1" },
  ]);

  const missing = harness();
  const error = await fails("usage_error", missing, [
    "hosting",
    "dns",
    "records",
    "list",
  ]);
  assert.deepEqual(error.details, { flag: "--domain" });
});

test("dns records create wraps every --value and only sends a given ttl", async () => {
  const withTtl = harness();
  await succeeds(withTtl, [
    "hosting",
    "dns",
    "records",
    "create",
    "--domain",
    "dom-1",
    "--record-type",
    "A",
    "--name",
    "www",
    "--ttl",
    "0",
    "--value",
    "1.2.3.4",
    "--value",
    "5.6.7.8",
  ]);
  assert.deepEqual(withTtl.calls.action, [
    {
      kind: "dns-record-create",
      domainId: "dom-1",
      body: {
        type: "A",
        name: "www",
        ttl: 0,
        resource_records: [{ value: "1.2.3.4" }, { value: "5.6.7.8" }],
      },
    },
  ]);

  const withoutTtl = harness();
  await succeeds(withoutTtl, [
    "hosting",
    "dns",
    "records",
    "create",
    "--domain",
    "dom-1",
    "--record-type",
    "CNAME",
    "--name",
    "alias",
    "--value",
    "example.test",
  ]);
  assert.equal(
    Object.hasOwn(withoutTtl.calls.action[0].body, "ttl"),
    false,
    "an unset --ttl must not reach the provider",
  );
});

test("dns records create requires at least one value, a type and a name", async () => {
  const noValue = harness();
  assert.deepEqual(
    (
      await fails("usage_error", noValue, [
        "hosting",
        "dns",
        "records",
        "create",
        "--domain",
        "dom-1",
        "--record-type",
        "A",
        "--name",
        "www",
      ])
    ).details,
    { flag: "--value" },
  );

  const noType = harness();
  assert.deepEqual(
    (
      await fails("usage_error", noType, [
        "hosting",
        "dns",
        "records",
        "create",
        "--domain",
        "dom-1",
        "--name",
        "www",
        "--value",
        "1.2.3.4",
      ])
    ).details,
    { flag: "--record-type" },
  );
});

test("dns records update sends only the non-empty value lists", async () => {
  const both = harness();
  await succeeds(both, [
    "hosting",
    "dns",
    "records",
    "update",
    "--domain",
    "dom-1",
    "--record-type",
    "A",
    "--name",
    "www",
    "--ttl",
    "300",
    "--add-value",
    "1.1.1.1",
    "--remove-value",
    "2.2.2.2",
  ]);
  assert.deepEqual(both.calls.action, [
    {
      kind: "dns-record-update",
      domainId: "dom-1",
      body: {
        type: "A",
        name: "www",
        ttl: 300,
        new_resource_records: [{ value: "1.1.1.1" }],
        removed_resource_records: [{ value: "2.2.2.2" }],
      },
    },
  ]);

  const neither = harness();
  await succeeds(neither, [
    "hosting",
    "dns",
    "records",
    "update",
    "--domain",
    "dom-1",
    "--record-type",
    "A",
    "--name",
    "www",
  ]);
  assert.deepEqual(neither.calls.action[0].body, { type: "A", name: "www" });
});

test("dns records delete sends the type and the name", async () => {
  const context = harness();
  await succeeds(context, [
    "hosting",
    "dns",
    "records",
    "delete",
    "--domain",
    "dom-1",
    "--record-type",
    "TXT",
    "--name",
    "_acme",
  ]);
  assert.deepEqual(context.calls.action, [
    {
      kind: "dns-record-delete",
      domainId: "dom-1",
      body: { type: "TXT", name: "_acme" },
    },
  ]);
});

test("a --from-json payload replaces the option-built body of every DNS command", async () => {
  const payload = '{"type":"MX","name":"@","resource_records":[]}';
  for (const [subcommand, kind] of [
    ["create", "dns-record-create"],
    ["update", "dns-record-update"],
    ["delete", "dns-record-delete"],
  ]) {
    const context = harness({ io: { stdin: payload } });
    await succeeds(context, [
      "hosting",
      "dns",
      "records",
      subcommand,
      "--domain",
      "dom-1",
      "--from-json",
      "-",
    ]);
    assert.deepEqual(context.calls.action, [
      { kind, domainId: "dom-1", body: JSON.parse(payload) },
    ]);
  }
});

test("a malformed --from-json payload is a usage error", async () => {
  const context = harness({ io: { stdin: "{not json" } });
  await fails("usage_error", context, [
    "hosting",
    "dns",
    "records",
    "create",
    "--domain",
    "dom-1",
    "--from-json",
    "-",
  ]);
  assert.deepEqual(context.calls.action, []);
});

/* -------------------------------------------------------------------------- */
/* Envelope                                                                   */
/* -------------------------------------------------------------------------- */

test("a provider failure becomes the failure envelope and its exit code", async () => {
  const context = harness({
    fail: new CliError("provider_error", "Kinsta rejected the domain.", {
      details: { provider: "kinsta", status: 422 },
    }),
  });
  const result = await run(context, [
    "hosting",
    "domains",
    "add",
    "--env",
    "env-1",
    "--domain-name",
    "example.test",
  ]);

  assert.equal(result.code, 4);
  assert.deepEqual(result.envelope, {
    ok: false,
    error: {
      code: "provider_error",
      message: "Kinsta rejected the domain.",
      retryable: false,
      details: { provider: "kinsta", status: 422 },
    },
  });
});

test("a hosting command never infers a profile", async () => {
  const context = harness();
  try {
    await context.program.parseAsync(
      ["hosting", "domains", "list", "--env", "e"],
      {
        from: "user",
      },
    );
    assert.fail("expected the invocation to fail");
  } catch (error) {
    assert.equal(error.code, "usage_error");
    assert.deepEqual(error.details.profiles, ["prod"]);
  }
  assert.deepEqual(context.calls.read, []);
});

test("an unknown profile fails profile_not_found before any request", async () => {
  const context = harness();
  try {
    await context.program.parseAsync(
      [
        "--profile",
        "staging",
        "hosting",
        "dns",
        "records",
        "list",
        "--domain",
        "d",
      ],
      { from: "user" },
    );
    assert.fail("expected the invocation to fail");
  } catch (error) {
    assert.equal(error.code, "profile_not_found");
  }
  assert.deepEqual(context.calls.read, []);
});
