// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract test for `hosting novamira setup` — the command group in
 * `src/cli/hosting/novamira.ts` driving the provisioning service in
 * `src/provisioning/`.
 *
 * Everything runs offline. The provider is a recording fake implementing
 * `ProviderClient`, keyed by the exact WP-CLI command line so a test can script
 * a whole multi-step setup without ordering guesswork, and the two outbound
 * non-provider requests (the canonical source HEAD and the one unauthenticated
 * compatibility read) go either to a literal `fetch` double or to a loopback
 * `node:http` server. No socket ever leaves 127.0.0.1 and no provider credential
 * exists in this file beyond an obvious placeholder that is asserted never to
 * be printed.
 *
 * The group is exercised through its own `registerNovamiraCommands` on a
 * throwaway program carrying the same globals the assembled program does, which
 * is the idiom `test/cli-wp-contract.test.mjs` established.
 *
 * The boundary rule gets its own test at the bottom: the exact set of WP-CLI
 * commands the provider received is asserted, and the real `config.json` on
 * disk is compared byte for byte across a successful run. Go's setup ended with
 * `wp user application-password create` and a `site_profiles` write; neither may
 * ever come back.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";

import {
  createNovamiraHandlers,
  registerNovamiraCommands,
} from "../dist/cli/hosting/novamira.js";
import { defaultFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import { envCredential } from "../dist/config/schema.js";
import { CliError } from "../dist/errors.js";
import { createHostingClientFactory } from "../dist/hosting/factory.js";
import { createRenderer } from "../dist/output/render.js";
import { PROTECTED_RESOURCE_PATH } from "../dist/provisioning/compatibility.js";
import {
  ALREADY_INSTALLED_HINT,
  DB_HOST_LOCALHOST_HINT,
  NOVAMIRA_DOWNLOAD_URL,
} from "../dist/provisioning/plugin.js";
import { PHP_VERSION_COMMAND } from "../dist/provisioning/phpcompat.js";
import {
  EXISTING_NOVAMIRA_COMMAND,
  EXISTING_AI_COMMAND,
  EXISTING_AI_DOMAIN_COMMAND,
} from "../dist/provisioning/existing.js";

test("existing Novamira is preserved unless abilities activation is explicitly requested", async () => {
  for (const enable of [false, true]) {
    const client = fakeClient({
      wpCli: {
        ...happyScript(),
        [EXISTING_NOVAMIRA_COMMAND]: sync({
          data: {
            result: JSON.stringify([
              { name: "novamira", version: "1.11.1", status: "active" },
            ]),
          },
        }),
        [EXISTING_AI_COMMAND]: sync({ data: { result: "[]" } }),
        "wp plugin status novamira": sync({
          data: { result: "Status: Active" },
        }),
      },
    });
    const { run } = harness({ client });
    const { envelope } = await run([
      "setup",
      "--env",
      "env",
      "--source",
      "novamira",
      "--url",
      SITE_URL,
      "--no-compat-check",
      ...(enable ? ["--ai-abilities"] : []),
    ]);
    assert.equal(envelope.ok, true);
    assert.equal(
      client
        .commands()
        .some((command) => command.startsWith("wp plugin install")),
      false,
    );
    assert.equal(
      client
        .commands()
        .includes("wp option update novamira_ai_abilities_enabled 1"),
      enable,
    );
    assert.equal(envelope.data.ai_abilities.enabled, enable);
  }
});

test("even --force cannot implicitly replace an unsupported old Novamira", async () => {
  const client = fakeClient({
    wpCli: {
      ...happyScript(),
      [EXISTING_NOVAMIRA_COMMAND]: sync({
        data: {
          result: JSON.stringify([
            { name: "novamira", version: "1.0.0", status: "active" },
          ]),
        },
      }),
    },
  });
  const { envelope } = await harness({ client }).run([
    "setup",
    "--env",
    "env",
    "--source",
    "novamira",
    "--force",
  ]);
  assert.equal(envelope.error.code, "server_unsupported");
  assert.deepEqual(client.commands(), [
    PHP_VERSION_COMMAND,
    EXISTING_NOVAMIRA_COMMAND,
  ]);
});

test("an existing abilities domain mismatch is reported without rewriting the setting", async () => {
  const client = fakeClient({
    wpCli: {
      ...happyScript(),
      [EXISTING_NOVAMIRA_COMMAND]: sync({
        data: {
          result: JSON.stringify([
            { name: "novamira", version: "1.11.1", status: "active" },
          ]),
        },
      }),
      [EXISTING_AI_COMMAND]: sync({
        data: {
          result: JSON.stringify([
            { option_name: "novamira_ai_abilities_enabled", option_value: "1" },
          ]),
        },
      }),
      [EXISTING_AI_DOMAIN_COMMAND]: sync({
        data: {
          result: JSON.stringify([
            {
              option_name: "novamira_ai_abilities_domain",
              option_value: "other.example",
            },
          ]),
        },
      }),
    },
  });
  const { envelope } = await harness({ client }).run([
    "setup",
    "--env",
    "env",
    "--source",
    "novamira",
    "--url",
    SITE_URL,
    "--no-compat-check",
  ]);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.ai_abilities.enabled, false);
  assert.equal(envelope.data.ai_abilities.domain, "other.example");
  assert.equal(
    client.commands().some((command) => command.startsWith("wp option update")),
    false,
  );
});

/** An obvious fake. Nothing in this suite ever contacts a real provider. */
const PLACEHOLDER = "novamira-setup-fake-credential-not-a-real-secret";
const SITE_URL = "https://example.com";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** An offline `CommandIo`: no real stdin, no real filesystem, no env. */
function fakeIo({ env = {} } = {}) {
  return {
    env,
    async readStdin() {
      throw new Error("hosting novamira setup reads no stdin");
    },
    async readFile(path) {
      const error = new Error(`ENOENT: no such file or directory ${path}`);
      error.code = "ENOENT";
      throw error;
    },
    async writePrivateFile() {
      throw new Error("hosting novamira setup writes no file");
    },
  };
}

function actionResult(overrides = {}) {
  return {
    provider: "kinsta",
    action: "wp-cli.run",
    status: 200,
    raw: null,
    ...overrides,
  };
}

/** A synchronous WP-CLI answer carrying `raw`. */
function sync(raw = null, overrides = {}) {
  return actionResult({ raw, ...overrides });
}

/** An asynchronous WP-CLI answer: an operation id to poll. */
function asyncOperation(operationId) {
  return actionResult({ status: 202, operationId });
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
 * A recording `ProviderClient`. WP-CLI answers are keyed by the exact command
 * line, and an unscripted command is an error rather than a default, so a test
 * that asserts "these commands and no others" cannot pass by accident.
 */
function fakeClient({ wpCli = {}, operations = {}, observable } = {}) {
  wpCli = {
    [EXISTING_NOVAMIRA_COMMAND]: sync({ data: { result: "[]" } }),
    [EXISTING_AI_DOMAIN_COMMAND]: sync({ data: { result: "[]" } }),
    ...wpCli,
  };
  const client = {
    provider: "kinsta",
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
      throw new Error(`unexpected read ${request.kind}`);
    },

    async action(request) {
      client.actionRequests.push(request);
      if (request.kind !== "run-wp-cli")
        throw new Error(`unexpected action ${request.kind}`);
      const command = request.body?.wp_command;
      assert.match(command, /^[A-Za-z0-9 '_./:=\-]+$/);
      if (!Object.hasOwn(wpCli, command))
        throw new Error(`unexpected wp-cli command ${JSON.stringify(command)}`);
      const answer = wpCli[command];
      return typeof answer === "function" ? answer() : answer;
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
  /** Every WP-CLI command line the provider was asked to run, in order. */
  client.commands = () =>
    client.actionRequests.map((request) => request.body?.wp_command);
  return client;
}

/** The default Phase B script for a site that answers everything cleanly. */
function happyScript({
  siteUrl = SITE_URL,
  host = "example.com",
  source = "novamira",
} = {}) {
  return {
    [PHP_VERSION_COMMAND]: sync({ data: { result: "8.2.12" } }),
    "wp option get siteurl": sync({ data: { result: siteUrl } }),
    [`wp plugin install ${source}`]: sync(),
    "wp plugin status novamira": sync({ data: { result: "Status: Inactive" } }),
    "wp plugin activate novamira": sync(),
    "wp option get home": sync({ data: { result: siteUrl } }),
    "wp option update novamira_ai_abilities_enabled 1": sync(),
    [`wp option update novamira_ai_abilities_domain ${host}`]: sync(),
  };
}

/* -------------------------------------------------------------------------- */
/* Compatibility fixtures                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `protected_resource_document()` from
 * `novamira/includes/oauth/endpoints/discovery.php`, over
 * `novamira_server_compatibility()` from `novamira/includes/compatibility.php`.
 */
function metadataDocument(siteUrl, block = {}) {
  return {
    resource: `${siteUrl}/wp-json/mcp/novamira-oauth`,
    authorization_servers: [siteUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
    novamira: {
      plugin_version: "1.11.1",
      rest_api_version: 1,
      wordpress_version: "6.9",
      minimum_wordpress_version: "6.9",
      features: {
        abilities_bearer_auth: true,
        agent_context: true,
        rest_skills: true,
        generalized_execution_shim: true,
      },
      ...block,
    },
  };
}

function httpResponse({ status = 200, body = "", headers = {} } = {}) {
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      String(value),
    ]),
  );
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
  };
}

/** A recording `HttpFetch` routed by `${method} ${url}`. */
function routedFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, init });
    const route = routes[`${method} ${url}`] ?? routes[url];
    if (route === undefined)
      throw new Error(`unexpected fetch ${method} ${url}`);
    if (typeof route === "function") return route(calls.length);
    return route;
  };
  impl.calls = calls;
  return impl;
}

/** Serve the canonical document for `siteUrl` and nothing else. */
function servingMetadata(siteUrl, block = {}) {
  return routedFetch({
    [`GET ${siteUrl}${PROTECTED_RESOURCE_PATH}`]: httpResponse({
      body: metadataDocument(siteUrl, block),
    }),
  });
}

/** A `fetch` seam that fails the test if anything reaches it. */
function forbiddenFetch() {
  const impl = async (url) => {
    throw new Error(`the fetch seam must not be used: ${url}`);
  };
  impl.calls = [];
  return impl;
}

/* -------------------------------------------------------------------------- */
/* Program harness                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A throwaway program carrying the globals `program.ts` carries, with this
 * group registered under `hosting`. `run(argv)` renders the failure envelope
 * the way `main.ts` does, so both envelope branches are covered.
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
        if (requested === undefined || requested === "")
          throw new CliError(
            "usage_error",
            "Select a hosting profile with --profile.",
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
  registerNovamiraCommands(
    hosting,
    createNovamiraHandlers(dependencies, overrides),
    optionsFor,
  );

  return {
    program,
    hosting,
    chunks,
    async run(argv) {
      chunks.out.length = 0;
      chunks.err.length = 0;
      let error;
      try {
        await program.parseAsync(
          ["--json", "--profile", "prod", "hosting", "novamira", ...argv],
          { from: "user" },
        );
      } catch (caught) {
        error = caught;
        renderer.failure(caught);
      }
      const stdout = chunks.out.join("");
      return {
        envelope: JSON.parse(stdout),
        error,
        stdout,
        stderr: chunks.err.join(""),
      };
    },
  };
}

/** The grammar alone: handlers that record what commander handed them. */
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

  registerNovamiraCommands(program.command("hosting"), handlers, optionsFor);

  return {
    calls,
    async parse(argv) {
      await program.parseAsync(["hosting", "novamira", ...argv], {
        from: "user",
      });
      return calls.at(-1);
    },
  };
}

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

/** Serve loopback responses, recording what was asked for. */
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

test("the group registers exactly one command", () => {
  // 77. Go's `novamira` command had a single `setup` subcommand and still does;
  // everything Go's setup did beyond provisioning is gone, not renamed.
  const { hosting } = harness({ client: fakeClient() });
  assert.deepEqual(
    hosting.commands.map((command) => command.name()),
    ["novamira"],
  );
  assert.deepEqual(
    findCommand(hosting, "novamira").commands.map((command) => command.name()),
    ["setup"],
  );
});

test("setup declares exactly the v1 flag list, in order", () => {
  // 78. This list is the frozen surface; `--username`, `--app-name`,
  // `--site-profile` and `--replace-profile` died with the Application
  // Password, and `--version` is a reserved global.
  const { hosting } = harness({ client: fakeClient() });
  assert.deepEqual(longFlags(findCommand(hosting, "novamira setup")), [
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
  ]);
});

test("no deleted Go flag and no reserved global is registered", () => {
  // 81, and the four flags §4 deletes.
  const { hosting } = harness({ client: fakeClient() });
  const flags = longFlags(findCommand(hosting, "novamira setup"));
  for (const gone of [
    "--version",
    "--username",
    "--app-name",
    "--site-profile",
    "--replace-profile",
    "--from-json",
    "--command-id",
  ])
    assert.equal(flags.includes(gone), false, `${gone} must not be registered`);
  assert.equal(flags.includes("--plugin-version"), true);
});

test("commander applies the documented defaults at the handler boundary", async () => {
  // 79.
  const grammar = grammarHarness();
  const call = await grammar.parse(["setup", "--env", "env-1"]);

  assert.equal(call.name, "novamiraSetup");
  const [options] = call.args;
  assert.equal(options.env, "env-1");
  assert.equal(options.source, "novamira-latest");
  assert.equal(options.url, undefined);
  assert.equal(options.pluginVersion, undefined);
  for (const flag of [
    "activate",
    "preflight",
    "validateSource",
    "wait",
    "compatCheck",
  ])
    assert.equal(options[flag], true, flag);
  for (const flag of [
    "force",
    "activateNetwork",
    "ignoreRequirements",
    "aiAbilities",
  ])
    assert.equal(options[flag], false, flag);
  assert.equal(options.intervalSeconds, 5);
  assert.equal(options.timeoutSeconds, 300);
});

test("each --no- flag flips exactly its own option", async () => {
  // 80.
  const negations = {
    "--no-activate": "activate",
    "--no-preflight": "preflight",
    "--no-validate-source": "validateSource",
    "--no-wait": "wait",
    "--no-ai-abilities": "aiAbilities",
    "--no-compat-check": "compatCheck",
  };
  const all = Object.values(negations);
  for (const [flag, field] of Object.entries(negations)) {
    const grammar = grammarHarness();
    const call = await grammar.parse(["setup", "--env", "env-1", flag]);
    const [options] = call.args;
    for (const other of all)
      assert.equal(
        options[other],
        other === field || other === "aiAbilities" ? false : true,
        `${flag} changed ${other}`,
      );
  }
});

/* -------------------------------------------------------------------------- */
/* Happy path                                                                 */
/* -------------------------------------------------------------------------- */

/** Assigned once the loopback server is listening; handlers close over it. */
const originHolder = { value: "" };

test("a default run issues exactly the Phase B sequence and hands off", async () => {
  // 82 and 83. The whole flow with no flags but `--env`: the alias resolves to
  // the canonical download endpoint, that endpoint is HEAD-checked, the site
  // URL is discovered from `wp option get home`, and the compatibility
  // document is read from the discovered URL.
  await withServer(
    (request, response) => {
      if (request.url === PROTECTED_RESOURCE_PATH) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(metadataDocument(originHolder.value)));
        return;
      }
      response.writeHead(200).end();
    },
    async ({ base, requests }) => {
      originHolder.value = base;
      const sourceChecks = [];
      const client = fakeClient({
        wpCli: happyScript({
          siteUrl: base,
          host: "127.0.0.1",
          source: NOVAMIRA_DOWNLOAD_URL,
        }),
      });
      const { run } = harness({
        client,
        overrides: {
          fetch: async (target, init = {}) => {
            if (target === NOVAMIRA_DOWNLOAD_URL) {
              sourceChecks.push({ method: init.method ?? "GET", url: target });
              return httpResponse({ status: 405 });
            }
            return fetch(target, init);
          },
        },
      });

      const { envelope } = await run(["setup", "--env", "env-abc123"]);

      // The provider sequence, exactly, in order. The install line carries no
      // `--activate`: activation is deferred to an observable call of its own.
      assert.deepEqual(client.commands(), [
        PHP_VERSION_COMMAND,
        EXISTING_NOVAMIRA_COMMAND,
        "wp option get siteurl",
        `wp plugin install ${NOVAMIRA_DOWNLOAD_URL}`,
        "wp plugin status novamira",
        "wp plugin activate novamira",
        "wp option get home",
        "wp option update novamira_ai_abilities_enabled 1",
        "wp option update novamira_ai_abilities_domain 127.0.0.1",
      ]);
      for (const command of client.commands())
        assert.doesNotMatch(command, /--activate(-network)?\b/);

      assert.deepEqual(sourceChecks, [
        { method: "HEAD", url: NOVAMIRA_DOWNLOAD_URL },
      ]);
      assert.deepEqual(requests, [
        { method: "GET", url: PROTECTED_RESOURCE_PATH },
      ]);

      assert.equal(envelope.ok, true);
      assert.deepEqual(envelope.meta, {
        requestId: "req-1",
        profile: "prod",
        provider: "kinsta",
      });
      assert.deepEqual(envelope.data, {
        hosting_profile: "prod",
        env: "env-abc123",
        url: base,
        plugin: {
          slug: "novamira",
          source: NOVAMIRA_DOWNLOAD_URL,
          version: "1.11.1",
          activated: true,
          network_activated: false,
        },
        ai_abilities: { enabled: true, domain: "127.0.0.1" },
        compatibility: {
          status: "supported",
          metadata_url: `${base}${PROTECTED_RESOURCE_PATH}`,
          plugin_version: "1.11.1",
          rest_api_version: 1,
          wordpress_version: "6.9",
          minimum_wordpress_version: "6.9",
          features: {
            abilities_bearer_auth: true,
            agent_context: true,
            rest_skills: true,
            generalized_execution_shim: true,
          },
        },
        ready: true,
        next_step: {
          tool: "novamira-hq",
          command: ["novamira-hq", "site-cli", "auth", "login", base],
          command_line: `novamira-hq site-cli auth login ${base}`,
        },
      });
    },
  );
});

test("--url skips the discovery read and anchors the metadata URL", async () => {
  // 84.
  const client = fakeClient({
    wpCli: {
      ...happyScript(),
      "wp option get home": () => {
        throw new Error("wp option get home must not be issued with --url");
      },
    },
  });
  const http = servingMetadata(SITE_URL);
  const { run } = harness({ client, overrides: { fetch: http } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--url",
    SITE_URL,
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.ok, true);
  assert.equal(client.commands().includes("wp option get home"), false);
  assert.deepEqual(
    http.calls.map((call) => call.url),
    [`${SITE_URL}${PROTECTED_RESOURCE_PATH}`],
  );
  assert.equal(envelope.data.url, SITE_URL);
});

test("--no-ai-abilities preserves disabled abilities on an existing installation", async () => {
  // 85.
  const client = fakeClient({
    wpCli: {
      ...happyScript(),
      [EXISTING_NOVAMIRA_COMMAND]: sync({
        data: {
          result: JSON.stringify([
            { name: "novamira", version: "1.11.1", status: "active" },
          ]),
        },
      }),
      [EXISTING_AI_COMMAND]: sync({ data: { result: "[]" } }),
    },
  });
  const { run } = harness({
    client,
    overrides: { fetch: servingMetadata(SITE_URL) },
  });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--no-ai-abilities",
  ]);

  assert.equal(envelope.ok, true);
  for (const command of client.commands())
    assert.doesNotMatch(command, /wp option update novamira_ai_abilities/);
  assert.deepEqual(envelope.data.ai_abilities, {
    enabled: false,
    domain: null,
  });
});

test("--no-preflight skips the DB-backed WP-CLI probe", async () => {
  // 86.
  const client = fakeClient({ wpCli: happyScript() });
  const { run } = harness({
    client,
    overrides: { fetch: servingMetadata(SITE_URL) },
  });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--no-preflight",
  ]);

  assert.equal(envelope.ok, true);
  assert.equal(client.commands().includes("wp option get siteurl"), false);
  assert.equal(client.commands()[0], PHP_VERSION_COMMAND);
});

test("--no-compat-check never touches the site and says so", async () => {
  // 87. The escape hatch is honest: skipped, not silently downgraded.
  const client = fakeClient({ wpCli: happyScript() });
  const http = forbiddenFetch();
  const { run } = harness({ client, overrides: { fetch: http } });

  const { envelope, error } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--no-compat-check",
  ]);

  assert.equal(error, undefined);
  assert.equal(envelope.ok, true);
  assert.equal(http.calls.length, 0);
  assert.deepEqual(envelope.data.compatibility, {
    status: "skipped",
    metadata_url: null,
    plugin_version: null,
    rest_api_version: null,
    wordpress_version: null,
    minimum_wordpress_version: null,
    features: null,
  });
  assert.equal(envelope.data.ready, null);
  assert.equal(envelope.data.plugin.version, null);
  assert.deepEqual(
    envelope.meta.warnings.map((warning) => warning.code),
    ["compatibility_not_checked"],
  );
});

test("--activate-network requires Network Active and passes --network", async () => {
  // 88.
  const client = fakeClient({
    wpCli: {
      ...happyScript(),
      // Plain "Active" is not network activation, so HQ still activates.
      "wp plugin status novamira": asyncOperation("op-status"),
      "wp plugin activate novamira --network": sync(),
    },
    operations: {
      "op-status": operationStatus("op-status", {
        raw: { data: { result: "Status: Active" } },
      }),
    },
  });
  const { run } = harness({
    client,
    overrides: { fetch: servingMetadata(SITE_URL) },
  });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--activate-network",
  ]);

  assert.equal(envelope.ok, true);
  assert.equal(
    client.commands().includes("wp plugin activate novamira --network"),
    true,
  );
  assert.equal(envelope.data.plugin.network_activated, true);
  assert.equal(envelope.data.plugin.activated, true);
});

test("an already-active plugin is not activated again", async () => {
  // 89.
  const client = fakeClient({
    wpCli: {
      ...happyScript(),
      "wp plugin status novamira": asyncOperation("op-status"),
    },
    operations: {
      "op-status": operationStatus("op-status", {
        raw: { data: { result: "Plugin novamira details:\n  Status: Active" } },
      }),
    },
  });
  const { run } = harness({
    client,
    overrides: { fetch: servingMetadata(SITE_URL) },
  });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.ok, true);
  assert.equal(
    client.commands().includes("wp plugin activate novamira"),
    false,
  );
  assert.equal(envelope.data.plugin.activated, true);
});

test("a source naming no slug is activated on the install line instead", async () => {
  // A CI build such as `novamira-pr123.zip` matches neither the release-asset
  // pattern nor the repository URL, so no slug can be inferred and there is
  // nothing to pass to `wp plugin status` / `wp plugin activate`. Deferring
  // activation is impossible, so `--activate` goes back on the install line —
  // exactly what Go did. Dropping it would install an inactive plugin, and
  // Phase C would then 404 three times and fail a run that in fact worked.
  const source = "https://ci.example.com/novamira-pr123.zip";
  const installLine = `wp plugin install ${source} --activate`;
  const client = fakeClient({
    wpCli: {
      [PHP_VERSION_COMMAND]: sync({ data: { result: "8.2.12" } }),
      "wp option get siteurl": sync({ data: { result: SITE_URL } }),
      [installLine]: sync(),
      "wp option get home": sync({ data: { result: SITE_URL } }),
      "wp option update novamira_ai_abilities_enabled 1": sync(),
      "wp option update novamira_ai_abilities_domain example.com": sync(),
    },
  });
  const http = routedFetch({
    [`HEAD ${source}`]: httpResponse({ status: 200 }),
    [`GET ${SITE_URL}${PROTECTED_RESOURCE_PATH}`]: httpResponse({
      body: metadataDocument(SITE_URL),
    }),
  });
  const { run } = harness({ client, overrides: { fetch: http } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    source,
  ]);

  assert.equal(envelope.ok, true);
  assert.deepEqual(client.commands(), [
    PHP_VERSION_COMMAND,
    EXISTING_NOVAMIRA_COMMAND,
    "wp option get siteurl",
    installLine,
    "wp option get home",
    "wp option update novamira_ai_abilities_enabled 1",
    "wp option update novamira_ai_abilities_domain example.com",
  ]);
  assert.equal(envelope.data.plugin.slug, "");
  assert.equal(envelope.data.plugin.activated, true);
  assert.equal(envelope.data.plugin.network_activated, false);
});

test("--no-activate on a slugless source leaves the install line bare", async () => {
  // The fallback is not "always activate": it mirrors the request.
  const source = "https://ci.example.com/novamira-pr123.zip";
  const installLine = `wp plugin install ${source}`;
  const client = fakeClient({
    wpCli: {
      [PHP_VERSION_COMMAND]: sync({ data: { result: "8.2.12" } }),
      "wp option get siteurl": sync({ data: { result: SITE_URL } }),
      [installLine]: sync(),
      "wp option get home": sync({ data: { result: SITE_URL } }),
      "wp option update novamira_ai_abilities_enabled 1": sync(),
      "wp option update novamira_ai_abilities_domain example.com": sync(),
    },
  });
  const http = routedFetch({
    [`HEAD ${source}`]: httpResponse({ status: 200 }),
    [`GET ${SITE_URL}${PROTECTED_RESOURCE_PATH}`]: httpResponse({
      body: metadataDocument(SITE_URL),
    }),
  });
  const { run } = harness({ client, overrides: { fetch: http } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    source,
    "--no-activate",
  ]);

  assert.equal(envelope.ok, true);
  assert.equal(client.commands().includes(installLine), true);
  assert.equal(envelope.data.plugin.activated, false);
});

test("--plugin-version, --force and --ignore-requirements shape the install line", async () => {
  // The WP-CLI flag inside the generated command keeps its own name; only HQ's
  // option was renamed away from the reserved `--version` global. A silent drop
  // here would be invisible in every other assertion in this file.
  const installLine =
    "wp plugin install novamira --version=1.11.1 --force --ignore-requirements";
  const client = fakeClient({
    wpCli: { ...happyScript(), [installLine]: sync() },
  });
  const { run } = harness({
    client,
    overrides: { fetch: servingMetadata(SITE_URL) },
  });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--plugin-version",
    "1.11.1",
    "--force",
    "--ignore-requirements",
  ]);

  assert.equal(envelope.ok, true);
  assert.equal(client.commands().includes(installLine), true);
});

/* -------------------------------------------------------------------------- */
/* Negative: nothing may reach the provider                                   */
/* -------------------------------------------------------------------------- */

test("--env is required, and refused before any provider call", async () => {
  // 90.
  const client = fakeClient();
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });
  const { envelope } = await run(["setup", "--source", "novamira"]);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "usage_error");
  assert.equal(envelope.error.details.flag, "--env");
  assert.deepEqual(client.actionRequests, []);
});

test("a provider whose WP-CLI output HQ cannot read is refused", async () => {
  // 91. Go refused this provider because it needed to capture an Application
  // Password out of the output. That reason is deleted; the gate remains,
  // because HQ still reads the PHP version, the plugin status and the site URL.
  const client = fakeClient({ observable: false });
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });
  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "provider_unsupported");
  assert.match(envelope.error.message, /read the PHP version/);
  assert.doesNotMatch(envelope.error.message, /application[- _]?password/i);
  assert.deepEqual(client.actionRequests, []);
});

test("a site URL HQ would never advertise is rejected locally", async () => {
  // 92.
  const client = fakeClient();
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });
  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--url",
    "ftp://example.com",
  ]);

  assert.equal(envelope.error.code, "usage_error");
  assert.equal(envelope.error.details.flag, "--url");
  assert.equal(envelope.error.details.source, "--url");
  assert.deepEqual(client.actionRequests, []);
});

test("a --url carrying userinfo is refused without repeating it", async () => {
  // The failure envelope goes to stdout in --json mode and into CI logs.
  // Normalize before constructing the CliError as defense in depth rather than
  // relying on the output boundary to be the first component that scrubs it.
  const client = fakeClient();
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });
  const { envelope, stdout, stderr } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--url",
    "https://admin:hunter2@example.com",
  ]);

  assert.equal(envelope.error.code, "usage_error");
  assert.equal(envelope.error.details.url, "https://[REDACTED]@example.com");
  for (const stream of [stdout, stderr]) {
    assert.equal(stream.includes("hunter2"), false, stream);
    assert.equal(stream.includes("admin:"), false, stream);
  }
  assert.deepEqual(client.actionRequests, []);
});

test("an unreachable canonical download fails before the provider is touched", async () => {
  // 93. Source validation is deliberately earlier than Go had it: a download
  // failure must be reported before HQ starts round-tripping the provider.
  const client = fakeClient();
  const http = routedFetch({
    [`HEAD ${NOVAMIRA_DOWNLOAD_URL}`]: () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const { run } = harness({ client, overrides: { fetch: http } });

  const { envelope } = await run(["setup", "--env", "env-1"]);

  assert.equal(envelope.error.code, "network_error");
  assert.equal(envelope.error.retryable, true);
  assert.deepEqual(client.actionRequests, []);
});

test("--validate-source refuses a zip the host will not serve", async () => {
  // 94.
  const source = "https://downloads.invalid/novamira.zip";
  const client = fakeClient();
  const http = routedFetch({
    [`HEAD ${source}`]: httpResponse({ status: 404 }),
  });
  const { run } = harness({ client, overrides: { fetch: http } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    source,
  ]);

  assert.equal(envelope.error.code, "not_found");
  assert.match(envelope.error.message, /HTTP 404/);
  assert.deepEqual(
    http.calls.map((call) => `${call.method} ${call.url}`),
    [`HEAD ${source}`],
  );
  assert.deepEqual(client.actionRequests, []);
});

/* -------------------------------------------------------------------------- */
/* Negative: the provider sequence                                            */
/* -------------------------------------------------------------------------- */

test("PHP below 8 fails before anything is installed", async () => {
  // 95. Go's ordering property: exactly one command is issued.
  const client = fakeClient({
    wpCli: { [PHP_VERSION_COMMAND]: sync({ data: { result: "7.4.33" } }) },
  });
  const { run } = harness({
    client,
    overrides: { fetch: forbiddenFetch() },
  });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "server_unsupported");
  assert.match(envelope.error.message, /7\.4\.33/);
  assert.equal(envelope.error.details.check, "php.version");
  assert.deepEqual(client.commands(), [PHP_VERSION_COMMAND]);
});

test("PHP output HQ cannot read is a provider_error", async () => {
  // 96 and 97: unreadable text, and an empty WP-CLI result. Both mean the
  // provider did not answer, which is not the site's fault.
  for (const raw of [{ data: { result: "no version here" } }, null]) {
    const client = fakeClient({
      wpCli: { [PHP_VERSION_COMMAND]: sync(raw) },
    });
    const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });
    const { envelope } = await run([
      "setup",
      "--env",
      "env-1",
      "--source",
      "novamira",
    ]);

    assert.equal(envelope.error.code, "provider_error");
    assert.equal(envelope.error.details.command, PHP_VERSION_COMMAND);
    assert.deepEqual(client.commands(), [PHP_VERSION_COMMAND]);
  }
});

test("a failed preflight carries the DB_HOST hint when it applies", async () => {
  // 98.
  const client = fakeClient({
    wpCli: {
      [PHP_VERSION_COMMAND]: sync({ data: { result: "8.2.12" } }),
      "wp option get siteurl": asyncOperation("op-preflight"),
      "wp config get DB_HOST": asyncOperation("op-dbhost"),
    },
    operations: {
      "op-preflight": operationStatus("op-preflight", {
        done: true,
        failed: true,
        message: "wp-cli exited 1",
      }),
      "op-dbhost": operationStatus("op-dbhost", {
        raw: { data: { result: "localhost" } },
      }),
    },
  });
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "provider_error");
  assert.equal(envelope.error.message.endsWith(DB_HOST_LOCALHOST_HINT), true);
  // Nothing was installed.
  assert.deepEqual(client.commands(), [
    PHP_VERSION_COMMAND,
    EXISTING_NOVAMIRA_COMMAND,
    "wp option get siteurl",
    "wp config get DB_HOST",
  ]);
});

test("a hint that cannot be read is simply omitted", async () => {
  // 99. The hint is a courtesy on top of a failure already being reported.
  const client = fakeClient({
    wpCli: {
      [PHP_VERSION_COMMAND]: sync({ data: { result: "8.2.12" } }),
      "wp option get siteurl": asyncOperation("op-preflight"),
      "wp config get DB_HOST": sync(null, { status: 500, message: "denied" }),
    },
    operations: {
      "op-preflight": operationStatus("op-preflight", {
        done: true,
        failed: true,
        message: "wp-cli exited 1",
      }),
    },
  });
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "provider_error");
  assert.equal(envelope.error.message.includes(DB_HOST_LOCALHOST_HINT), false);
  assert.match(envelope.error.message, /WP-CLI preflight failed/);
});

test("--no-wait against an async install is a usage_error", async () => {
  // 100.
  const client = fakeClient({
    wpCli: {
      ...happyScript(),
      "wp plugin install novamira": asyncOperation("op-install"),
    },
  });
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--no-wait",
  ]);

  assert.equal(envelope.error.code, "usage_error");
  assert.match(envelope.error.message, /requires --wait/);
  assert.deepEqual(client.operationIds, []);
});

test("a failed install operation is a provider_error naming the operation", async () => {
  // 101.
  const client = fakeClient({
    wpCli: {
      ...happyScript(),
      "wp plugin install novamira": asyncOperation("op-install"),
    },
    operations: {
      "op-install": operationStatus("op-install", {
        done: true,
        failed: true,
        message: "unpack failed",
      }),
    },
  });
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "provider_error");
  assert.match(envelope.error.message, /op-install/);
  assert.match(envelope.error.message, /unpack failed/);
  assert.equal(envelope.error.details.operationId, "op-install");
});

test("a synchronous install answered with 5xx is a provider_error", async () => {
  // 102. Go's asymmetry: the sync branch never waits, the async branch never
  // inspects the status.
  const client = fakeClient({
    wpCli: {
      ...happyScript(),
      "wp plugin install novamira": sync(null, {
        status: 500,
        message: "provider exploded",
      }),
    },
  });
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "provider_error");
  assert.match(envelope.error.message, /status 500/);
  assert.equal(envelope.error.details.status, 500);
});

test("a failed activation is a provider_error", async () => {
  // 103. Activation is a separate call precisely so this failure is visible.
  const client = fakeClient({
    wpCli: {
      ...happyScript(),
      "wp plugin activate novamira": asyncOperation("op-activate"),
    },
    operations: {
      "op-activate": operationStatus("op-activate", {
        done: true,
        failed: true,
        message: "fatal error on activation",
      }),
    },
  });
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "provider_error");
  assert.match(envelope.error.message, /op-activate/);
  assert.match(envelope.error.message, /activation/i);
});

test("an empty discovered site URL is a usage_error naming the source", async () => {
  // 104.
  const client = fakeClient({
    wpCli: {
      ...happyScript(),
      "wp option get home": sync({ data: { result: "" } }),
    },
  });
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "usage_error");
  assert.equal(envelope.error.details.flag, "--url");
  assert.equal(envelope.error.details.source, "wp option get home");
});

test("a provider echo in the discovered URL is stripped end to end", async () => {
  // 105.
  const client = fakeClient({
    wpCli: {
      ...happyScript({ host: "example.test" }),
      "wp option get home": sync({
        data: "2026-06-18 10:26:27 wp option get home\nhttps://example.test",
      }),
    },
  });
  const { run } = harness({
    client,
    overrides: { fetch: servingMetadata("https://example.test") },
  });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.url, "https://example.test");
  assert.equal(
    envelope.data.compatibility.metadata_url,
    `https://example.test${PROTECTED_RESOURCE_PATH}`,
  );
  assert.equal(
    client
      .commands()
      .includes("wp option update novamira_ai_abilities_domain example.test"),
    true,
  );
});

test("an exhausted polling budget is a retryable timeout", async () => {
  // 106.
  const client = fakeClient({
    wpCli: {
      ...happyScript(),
      "wp plugin install novamira": asyncOperation("op-install"),
    },
    operations: {
      "op-install": operationStatus("op-install", { done: false }),
    },
  });
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });

  const { envelope } = await run([
    "setup",
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
/* Negative: the compatibility preflight                                      */
/* -------------------------------------------------------------------------- */

test("a site that is not ready fails the invocation and keeps the record", async () => {
  // 107. `ok: true` with a warning would still be a success envelope a wrapper
  // script proceeds past, so this is fatal — and nothing about what landed on
  // the site is lost.
  const client = fakeClient({ wpCli: happyScript() });
  const { run } = harness({
    client,
    overrides: {
      fetch: servingMetadata(SITE_URL, { wordpress_version: "6.8" }),
    },
  });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-abc123",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "server_unsupported");
  assert.equal(envelope.error.retryable, false);
  assert.equal(envelope.error.details.check, "compat.wordpress");
  assert.equal(
    envelope.error.details.metadataUrl,
    `${SITE_URL}${PROTECTED_RESOURCE_PATH}`,
  );
  // The install record survives the failure.
  assert.equal(envelope.error.details.env, "env-abc123");
  assert.equal(envelope.error.details.hostingProfile, "prod");
  assert.equal(envelope.error.details.pluginSlug, "novamira");
  assert.equal(envelope.error.details.pluginSource, "novamira");
  assert.equal(envelope.error.details.aiAbilities, true);
  assert.equal(envelope.error.details.siteUrl, SITE_URL);
  // Everything really did run first.
  assert.equal(
    client
      .commands()
      .includes("wp option update novamira_ai_abilities_domain example.com"),
    true,
  );
});

test("a metadata transport failure is a retryable network_error", async () => {
  // 108.
  const client = fakeClient({ wpCli: happyScript() });
  const attempts = [];
  const http = async (url) => {
    attempts.push(url);
    throw new Error("ECONNREFUSED");
  };
  const { run } = harness({
    client,
    overrides: { fetch: http },
  });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "network_error");
  assert.equal(envelope.error.retryable, true);
  assert.equal(envelope.error.details.check, "metadata.reachable");
  assert.equal(attempts.length, 1);
});

test("a themed page where the metadata should be is server_unsupported", async () => {
  // 109.
  const client = fakeClient({ wpCli: happyScript() });
  const http = routedFetch({
    [`GET ${SITE_URL}${PROTECTED_RESOURCE_PATH}`]: httpResponse({
      body: "<!doctype html><html><body>404</body></html>",
    }),
  });
  const { run } = harness({ client, overrides: { fetch: http } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "server_unsupported");
  assert.equal(envelope.error.details.check, "metadata.document");
});

/* -------------------------------------------------------------------------- */
/* The boundary rule                                                          */
/* -------------------------------------------------------------------------- */

test("the success envelope names nothing the boundary rule deleted", async () => {
  // 110.
  const client = fakeClient({ wpCli: happyScript() });
  const { run } = harness({
    client,
    overrides: { fetch: servingMetadata(SITE_URL) },
  });

  const { stdout, stderr } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  for (const forbidden of [
    "application-password",
    "application_password",
    "site_profile",
    "credential",
    "rest_url",
    "config_path",
    "username",
  ]) {
    assert.doesNotMatch(stdout, new RegExp(forbidden, "i"), forbidden);
    assert.doesNotMatch(stderr, new RegExp(forbidden, "i"), forbidden);
  }
});

/**
 * The boundary rule as a single assertion, against the real `ConfigStore` on a
 * real (temporary) filesystem: HQ creates no WordPress user, captures no
 * Application Password, and writes nothing to its own config.
 */
test("setup issues no application-password command and writes no profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-novamira-"));
  try {
    const paths = platformPaths({ NOVAMIRA_HQ_HOME: root });
    const security = defaultFileSecurity();
    const locks = new ProfileLockManager(paths.stateDir, security);
    const store = new ConfigStore(paths.configFile, locks, security);
    await store.upsertHostingProfile("prod", {
      provider: "kinsta",
      credential: envCredential("KINSTA_API_KEY"),
      companyId: "company-1234",
    });
    const before = await readFile(paths.configFile, "utf8");

    const client = fakeClient({ wpCli: happyScript() });
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
      paths,
      store,
      hosting: createHostingClientFactory({
        store,
        registry: { kinsta: () => client },
        env: { KINSTA_API_KEY: PLACEHOLDER },
      }),
      io: fakeIo(),
      rendererFor: () => renderer,
    };

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
    registerNovamiraCommands(
      program.command("hosting"),
      createNovamiraHandlers(dependencies, {
        fetch: servingMetadata(SITE_URL),
      }),
      optionsFor,
    );

    await program.parseAsync(
      [
        "--json",
        "--profile",
        "prod",
        "hosting",
        "novamira",
        "setup",
        "--env",
        "env-1",
        "--source",
        "novamira",
      ],
      { from: "user" },
    );

    const envelope = JSON.parse(chunks.out.join(""));
    assert.equal(envelope.ok, true);

    // 1. The exact set of WP-CLI commands the provider was asked to run. Go's
    // step 4 (`wp user application-password create`) and its administrator
    // picker (`wp user list --role=administrator`) are permanently gone.
    assert.deepEqual(client.commands(), [
      PHP_VERSION_COMMAND,
      EXISTING_NOVAMIRA_COMMAND,
      "wp option get siteurl",
      "wp plugin install novamira",
      "wp plugin status novamira",
      "wp plugin activate novamira",
      "wp option get home",
      "wp option update novamira_ai_abilities_enabled 1",
      "wp option update novamira_ai_abilities_domain example.com",
    ]);
    for (const command of client.commands()) {
      assert.doesNotMatch(command, /application-password/);
      assert.doesNotMatch(command, /\bwp user\b/);
    }

    // 2. HQ's own config is untouched: Go's step 5 wrote a `site_profiles`
    // entry here, and the v1 schema has no such section.
    const after = await readFile(paths.configFile, "utf8");
    assert.equal(after, before);
    assert.equal(after.includes("site_profile"), false);

    // 3. No secret reaches the envelope, stderr or the config file.
    const stdout = chunks.out.join("");
    const stderr = chunks.err.join("");
    for (const text of [stdout, stderr, after])
      assert.equal(text.includes(PLACEHOLDER), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

/* -------------------------------------------------------------------------- */
/* The already-installed hint                                                 */
/* -------------------------------------------------------------------------- */

test("a failed install carries the already-installed hint when it applies", async () => {
  // 111. A provider is allowed to report a failed WP-CLI run without reporting
  // what WP-CLI said — Kinsta collapses every non-zero exit into a bare
  // `500 Server Error`. Re-running setup on a site that already has the plugin
  // then reports only that the install "failed", so the probe supplies the
  // reason and names `--force`. `wp plugin is-installed` writes nothing and
  // reports through its exit status alone, which is the one channel that
  // survives such a provider: a non-failed operation means the plugin is there.
  const client = fakeClient({
    wpCli: {
      [PHP_VERSION_COMMAND]: sync({ data: { result: "8.2.12" } }),
      "wp option get siteurl": sync({
        data: { result: "https://example.com" },
      }),
      "wp plugin install novamira": asyncOperation("op-install"),
      "wp plugin is-installed novamira": asyncOperation("op-probe"),
    },
    operations: {
      "op-install": operationStatus("op-install", {
        done: true,
        failed: true,
        message: "Operation failed! Please refer to `data` for more details.",
      }),
      "op-probe": operationStatus("op-probe", { done: true, failed: false }),
    },
  });
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "provider_error");
  assert.equal(envelope.error.message.endsWith(ALREADY_INSTALLED_HINT), true);
  assert.match(envelope.error.message, /--force/);
  // The probe ran after the install, never instead of it.
  assert.deepEqual(client.commands(), [
    PHP_VERSION_COMMAND,
    EXISTING_NOVAMIRA_COMMAND,
    "wp option get siteurl",
    "wp plugin install novamira",
    "wp plugin is-installed novamira",
  ]);
});

test("a failed install omits the hint when the plugin is absent", async () => {
  // 112. The install failed for some other reason; `--force` would not fix it,
  // so saying so would be advice that sends the operator the wrong way. A
  // failed probe is "not installed", because `is-installed` exits non-zero.
  const client = fakeClient({
    wpCli: {
      [PHP_VERSION_COMMAND]: sync({ data: { result: "8.2.12" } }),
      "wp option get siteurl": sync({
        data: { result: "https://example.com" },
      }),
      "wp plugin install novamira": asyncOperation("op-install"),
      "wp plugin is-installed novamira": asyncOperation("op-probe"),
    },
    operations: {
      "op-install": operationStatus("op-install", {
        done: true,
        failed: true,
        message: "disk full",
      }),
      "op-probe": operationStatus("op-probe", { done: true, failed: true }),
    },
  });
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
  ]);

  assert.equal(envelope.error.code, "provider_error");
  assert.equal(envelope.error.message.includes(ALREADY_INSTALLED_HINT), false);
  assert.match(envelope.error.message, /disk full/);
});

test("--force suppresses the already-installed hint and its probe", async () => {
  // 113. The operator already asked for the overwrite, so the hint would be
  // advice they have taken. It is suppressed rather than probed for: no
  // `is-installed` call is made at all.
  const client = fakeClient({
    wpCli: {
      [PHP_VERSION_COMMAND]: sync({ data: { result: "8.2.12" } }),
      "wp option get siteurl": sync({
        data: { result: "https://example.com" },
      }),
      "wp plugin install novamira --force": asyncOperation("op-install"),
      "wp plugin is-installed novamira": asyncOperation("op-probe"),
    },
    operations: {
      "op-install": operationStatus("op-install", {
        done: true,
        failed: true,
        message: "still broken",
      }),
      "op-probe": operationStatus("op-probe", { done: true, failed: false }),
    },
  });
  const { run } = harness({ client, overrides: { fetch: forbiddenFetch() } });

  const { envelope } = await run([
    "setup",
    "--env",
    "env-1",
    "--source",
    "novamira",
    "--force",
  ]);

  assert.equal(envelope.error.code, "provider_error");
  assert.equal(envelope.error.message.includes(ALREADY_INSTALLED_HINT), false);
  assert.equal(
    client.commands().includes("wp plugin is-installed novamira"),
    false,
  );
});
