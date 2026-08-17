// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_POLL_TIMEOUT_SECONDS,
  addFromJsonOption,
  addPollingOptions,
  addSecretSourceOptions,
  collect,
  oneOf,
  parsePositiveInteger,
  parseUnsignedInteger,
  requireEnum,
} from "../dist/cli/flags.js";
import {
  operationFailure,
  resolveHostingClient,
  runHostingCommand,
  runLocalCommand,
  waitForOperationStatus,
} from "../dist/cli/hosting-command.js";
import {
  createCommandIo,
  jsonPointerLookupString,
  parseJsonValue,
  readJsonPayload,
  readSecret,
  readStdinRaw,
  readStdinTrimmed,
  readTextFile,
  requireNumberOption,
  requireOption,
} from "../dist/cli/inputs.js";
import {
  ADMIN_PASSWORD_SECRET,
  DEFAULT_SFTP_PERMISSION,
  DEFAULT_SFTP_ROOT_DIRECTORY,
  DEFAULT_WP_LANGUAGE,
  backupCreatePayload,
  backupRestorePayload,
  buildQuery,
  cacheClearPayload,
  deniedIpsSetPayload,
  dnsRecordCreatePayload,
  dnsRecordDeletePayload,
  dnsRecordUpdatePayload,
  domainAddPayload,
  domainDeletePayload,
  domainPrimaryPayload,
  environmentClonePayload,
  environmentCreatePayload,
  environmentCreatePlainPayload,
  environmentPushPayload,
  payloadOrObject,
  phpSetVersionPayload,
  requiredPayload,
  sftpAddPayload,
  shellJoin,
  shellQuote,
  siteClonePayload,
  siteCreatePayload,
  siteCreatePlainPayload,
  siteResetPayload,
  sshAllowlistPayload,
  wpAssetUpdateAllPayload,
  wpAssetUpdatePayload,
  wpCliCommandPayload,
  wpCliPayload,
  wpPluginActivateCommand,
  wpPluginInstallPayload,
} from "../dist/cli/payloads.js";
import {
  SITE_DELETE_CAPABILITY,
  disableSiteDeleteCapability,
  renderAction,
  renderEnvironment,
  renderEnvironments,
  renderOperation,
  renderRaw,
  renderSecretWrite,
  renderSite,
  renderSites,
  renderValidation,
  truncate,
} from "../dist/cli/print.js";
import { createRenderer } from "../dist/output/render.js";
import { MAX_SECRET_BYTES } from "../dist/credentials/resolve.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** An offline {@link CommandIo}: no real stdin, no real filesystem, no env. */
function fakeIo({ env = {}, stdin = "", files = {} } = {}) {
  const writes = [];
  let stdinReads = 0;
  return {
    env,
    writes,
    get stdinReads() {
      return stdinReads;
    },
    async readStdin() {
      stdinReads += 1;
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

function throwsWithCode(code, body) {
  let thrown;
  assert.throws(body, (error) => {
    thrown = error;
    return true;
  });
  assert.equal(thrown.code, code, thrown.message);
  return thrown;
}

async function rejectsWithCode(code, body) {
  let thrown;
  await assert.rejects(body, (error) => {
    thrown = error;
    return true;
  });
  assert.equal(thrown.code, code, thrown.message);
  return thrown;
}

async function isolated(body) {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-cli-foundations-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

/* -------------------------------------------------------------------------- */
/* flags.ts                                                                   */
/* -------------------------------------------------------------------------- */

test("unsigned option parsers reject everything a uint32 flag rejected", () => {
  assert.equal(parseUnsignedInteger("0"), 0);
  assert.equal(parseUnsignedInteger("1000"), 1000);
  for (const value of ["-1", "1.5", "", " 7", "0x10", "1e3", "seven"]) {
    assert.throws(() => parseUnsignedInteger(value), /non-negative integer/);
  }
  // Beyond 2^53 a decimal no longer round-trips, so refuse rather than send a
  // silently different number to a provider.
  assert.throws(() => parseUnsignedInteger("9007199254740993"), /at most/);

  assert.equal(parsePositiveInteger("5"), 5);
  assert.throws(() => parsePositiveInteger("0"), /greater than zero/);
});

test("collect accumulates a repeatable option in order", () => {
  assert.deepEqual(collect("b", collect("a", [])), ["a", "b"]);
  // The default array supplied to commander is never mutated.
  const defaults = [];
  collect("a", defaults);
  assert.deepEqual(defaults, []);
});

test("oneOf parses an enum option and requireEnum validates a late one", () => {
  const parse = oneOf(["site", "edge", "cdn"]);
  assert.equal(parse("edge"), "edge");
  assert.throws(() => parse("disk"), /must be one of site, edge, cdn/);

  assert.equal(
    requireEnum("quick", "--setup-type", ["quick", "avoid_downtime"]),
    "quick",
  );
  const error = throwsWithCode("usage_error", () =>
    requireEnum("later", "--setup-type", ["quick", "avoid_downtime"]),
  );
  assert.match(error.message, /Invalid value "later" for --setup-type\./);
  assert.deepEqual(error.details.allowed, ["quick", "avoid_downtime"]);
});

test("the shared option groups register the documented flags", () => {
  const command = new Command("install");
  addFromJsonOption(command);
  addSecretSourceOptions(command, "admin-password", "the admin password");
  addPollingOptions(command);
  const flags = command.options.map((option) => option.long);

  assert.deepEqual(flags, [
    "--from-json",
    "--admin-password-env",
    "--admin-password-stdin",
    "--admin-password-file",
    "--interval-seconds",
    "--timeout-seconds",
  ]);
  // A command never takes a secret value: there is no bare --admin-password.
  assert.equal(flags.includes("--admin-password"), false);

  command.parse([], { from: "user" });
  assert.equal(command.opts().intervalSeconds, DEFAULT_POLL_INTERVAL_SECONDS);
  assert.equal(command.opts().timeoutSeconds, DEFAULT_POLL_TIMEOUT_SECONDS);

  command.parse(["--interval-seconds", "9"], { from: "user" });
  assert.equal(command.opts().intervalSeconds, 9);
});

/* -------------------------------------------------------------------------- */
/* inputs.ts                                                                  */
/* -------------------------------------------------------------------------- */

test("a required option treats empty and absent alike, as cobra did", () => {
  for (const value of [undefined, ""]) {
    const error = throwsWithCode("usage_error", () =>
      requireOption(value, "--display-name"),
    );
    assert.equal(
      error.message,
      "--display-name is required unless --from-json is used.",
    );
    assert.equal(error.details.flag, "--display-name");
  }
  assert.equal(requireOption("site", "--display-name"), "site");

  throwsWithCode("usage_error", () =>
    requireNumberOption(undefined, "--backup-id"),
  );
  assert.equal(requireNumberOption(0, "--backup-id"), 0);
});

test("JSON payloads come from a path or from stdin", async () => {
  const io = fakeIo({
    stdin: '{"from":"stdin"}',
    files: { "/payload.json": '{"from":"file","n":7}' },
  });
  assert.deepEqual(await readJsonPayload("/payload.json", io), {
    from: "file",
    n: 7,
  });
  assert.deepEqual(await readJsonPayload("-", io), { from: "stdin" });

  await rejectsWithCode("usage_error", () =>
    readJsonPayload("/missing.json", io),
  );
  const broken = fakeIo({ files: { "/bad.json": "{oops" } });
  const error = await rejectsWithCode("usage_error", () =>
    readJsonPayload("/bad.json", broken),
  );
  assert.match(error.message, /Failed to parse the JSON payload \/bad\.json/);

  throwsWithCode("usage_error", () => parseJsonValue("nope", "the body"));
  assert.equal(parseJsonValue("null", "the body"), null);
});

test("readTextFile reports an unreadable user-named path as a usage error", async () => {
  const io = fakeIo({ files: { "/key.pem": "PRIVATE" } });
  assert.equal(await readTextFile("/key.pem", "custom SSL key", io), "PRIVATE");
  const error = await rejectsWithCode("usage_error", () =>
    readTextFile("/none.pem", "custom SSL key", io),
  );
  assert.equal(error.details.path, "/none.pem");
});

test("stdin readers keep Go's trimming rules", async () => {
  const io = fakeIo({ stdin: "wp plugin list\r\n\n" });
  assert.equal(
    await readStdinTrimmed("The WP-CLI command", io),
    "wp plugin list",
  );
  assert.equal(await readStdinRaw(io), "wp plugin list\r\n\n");

  const empty = fakeIo({ stdin: "\n" });
  const error = await rejectsWithCode("usage_error", () =>
    readStdinTrimmed("The WP-CLI command", empty),
  );
  assert.equal(error.message, "The WP-CLI command read from stdin was empty.");
});

test("a secret comes from exactly one of env, stdin or file", async () => {
  const spec = ADMIN_PASSWORD_SECRET;

  for (const source of [
    {},
    { env: "PW", stdin: true },
    { env: "PW", file: "/pw" },
    { stdin: true, file: "/pw" },
  ]) {
    const error = await rejectsWithCode("usage_error", () =>
      readSecret(source, spec, fakeIo({ env: { PW: "s3cr3t" } })),
    );
    assert.equal(
      error.message,
      "The admin password requires exactly one of --admin-password-env, --admin-password-stdin, or --admin-password-file.",
    );
  }

  assert.equal(
    await readSecret({ env: "PW" }, spec, fakeIo({ env: { PW: "s3cr3t" } })),
    "s3cr3t",
  );
  assert.equal(
    await readSecret({ stdin: true }, spec, fakeIo({ stdin: "s3cr3t\n" })),
    "s3cr3t",
  );
  assert.equal(
    await readSecret(
      { file: "/pw" },
      spec,
      fakeIo({ files: { "/pw": "s3cr3t" } }),
    ),
    "s3cr3t",
  );
  // `echo s3cr3t > pw.txt` must not send a password ending in a newline: the
  // file source trims exactly as the stdin source and the contract's `file`
  // credential reference do.
  assert.equal(
    await readSecret(
      { file: "/pw" },
      spec,
      fakeIo({ files: { "/pw": "s3cr3t\n" } }),
    ),
    "s3cr3t",
  );
});

test("an absent or empty secret is credential_missing and never echoed", async () => {
  const spec = ADMIN_PASSWORD_SECRET;
  const cases = [
    [
      { env: "PW" },
      fakeIo({ env: {} }),
      /Environment variable PW is not set\./,
    ],
    [
      { env: "PW" },
      fakeIo({ env: { PW: "" } }),
      /Environment variable PW is empty\./,
    ],
    [{ stdin: true }, fakeIo({ stdin: "\r\n" }), /read from stdin was empty\./],
    [
      { file: "/pw" },
      fakeIo({ files: {} }),
      /Failed to read the admin password from \/pw\./,
    ],
    [
      { file: "/pw" },
      fakeIo({ files: { "/pw": "" } }),
      /read from \/pw was empty\./,
    ],
    [
      { file: "/pw" },
      fakeIo({ files: { "/pw": "\n" } }),
      /read from \/pw was empty\./,
    ],
  ];
  for (const [source, io, pattern] of cases) {
    const error = await rejectsWithCode("credential_missing", () =>
      readSecret(source, spec, io),
    );
    assert.match(error.message, pattern);
    // The reported source is the non-secret rendering the contract mandates.
    assert.match(error.details.source, /^(env:PW|stdin|file:\/pw)$/);
  }
});

test("a payload failure after a secret was read never leaks the secret", async () => {
  const io = fakeIo({ env: { ADMIN_PW: "correct-horse-battery-staple" } });
  // --admin-user is required after the password is resolved, so the failure
  // path runs with the secret already in hand.
  const error = await rejectsWithCode("usage_error", () =>
    siteCreatePayload(
      {
        displayName: "Example",
        region: "europe-west1",
        adminEmail: "admin@example.com",
        adminPasswordEnv: "ADMIN_PW",
        siteTitle: "Example",
      },
      io,
    ),
  );
  const serialized = JSON.stringify({
    message: error.message,
    details: error.details,
  });
  assert.equal(serialized.includes("correct-horse-battery-staple"), false);
  assert.match(error.message, /--admin-user is required/);
});

test("jsonPointerLookupString walks a parsed provider response", () => {
  const value = {
    environment: { sftp_password: "hunter2", port: 22 },
    "a/b": { "c~d": "escaped" },
  };
  assert.equal(
    jsonPointerLookupString(value, "/environment/sftp_password"),
    "hunter2",
  );
  assert.equal(jsonPointerLookupString(value, "/a~1b/c~0d"), "escaped");
  assert.equal(jsonPointerLookupString(value, "/environment/port"), undefined);
  assert.equal(jsonPointerLookupString(value, "/nope"), undefined);
  assert.equal(jsonPointerLookupString(value, "environment"), undefined);
  assert.equal(jsonPointerLookupString(value, "/a~9b"), undefined);
  assert.equal(jsonPointerLookupString([1, 2], "/0"), undefined);
  // Inherited members are not payload members.
  assert.equal(jsonPointerLookupString({}, "/constructor"), undefined);
});

test("the default CommandIo reads stdin once and writes owner-only files", async () => {
  let reads = 0;
  const io = createCommandIo({
    env: { EXAMPLE: "value" },
    readStdin: async () => {
      reads += 1;
      return "payload";
    },
  });
  assert.equal(io.env.EXAMPLE, "value");
  assert.equal(await io.readStdin(), "payload");
  assert.equal(await io.readStdin(), "payload");
  assert.equal(reads, 1, "stdin can only be drained once");

  await isolated(async (root) => {
    const path = join(root, "nested", "secret.txt");
    await io.writePrivateFile(path, "opaque");
    assert.equal(await io.readFile(path), "opaque");
    if (process.platform !== "win32") {
      const info = await stat(path);
      assert.equal(info.mode & 0o777, 0o600);
    }
  });
});

test("secret stdin and named files enforce the credential size and safety boundary", async (t) => {
  const spec = ADMIN_PASSWORD_SECRET;
  const oversized = "x".repeat(MAX_SECRET_BYTES + 1);
  const stdinIo = createCommandIo({
    env: {},
    readStdin: async () => oversized,
  });
  await assert.rejects(readSecret({ stdin: true }, spec, stdinIo), {
    code: "usage_error",
  });

  if (process.platform === "win32") {
    t.skip("POSIX ownership and symlink behavior is asserted on Unix only");
    return;
  }
  await isolated(async (root) => {
    const io = createCommandIo({ env: {} });
    const path = join(root, "password.txt");
    await writeFile(path, "safe-password\n", { mode: 0o600 });
    assert.equal(await readSecret({ file: path }, spec, io), "safe-password");

    await chmod(path, 0o644);
    await assert.rejects(readSecret({ file: path }, spec, io), {
      code: "credential_invalid",
    });

    await chmod(path, 0o600);
    await writeFile(path, oversized);
    await assert.rejects(readSecret({ file: path }, spec, io), {
      code: "credential_invalid",
    });

    const target = join(root, "target.txt");
    const link = join(root, "password-link.txt");
    await writeFile(target, "linked-password", { mode: 0o600 });
    await symlink(target, link);
    await assert.rejects(readSecret({ file: link }, spec, io), {
      code: "credential_invalid",
    });
  });
});

test("private output atomically replaces a symlink without touching its target", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink and mode behavior is asserted on Unix only");
    return;
  }
  await isolated(async (root) => {
    const io = createCommandIo({ env: {} });
    const target = join(root, "target.txt");
    const destination = join(root, "password.txt");
    await writeFile(target, "keep-me", { mode: 0o600 });
    await symlink(target, destination);

    await io.writePrivateFile(destination, "new-secret");

    assert.equal(await readFile(target, "utf8"), "keep-me");
    assert.equal(await readFile(destination, "utf8"), "new-secret");
    assert.equal((await lstat(destination)).isSymbolicLink(), false);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
  });
});

test("private output is secured before content reaches its temporary file", async () => {
  await isolated(async (root) => {
    const observations = [];
    const security = {
      async secureDirectory() {
        throw new Error("a user-selected parent must not be changed");
      },
      async secureFile(path) {
        observations.push(await readFile(path, "utf8"));
      },
      async verifyDirectory() {
        return true;
      },
      async verifyFile() {
        return true;
      },
    };
    const io = createCommandIo({ env: {}, security });

    await io.writePrivateFile(join(root, "password.txt"), "new-secret");

    assert.deepEqual(observations, ["", "new-secret"]);
  });
});

/* -------------------------------------------------------------------------- */
/* payloads.ts — plumbing                                                     */
/* -------------------------------------------------------------------------- */

test("--from-json replaces the built body entirely", async () => {
  const io = fakeIo({ files: { "/body.json": '{"anything":[1,2]}' } });
  let built = 0;
  assert.deepEqual(
    await payloadOrObject(
      "/body.json",
      () => {
        built += 1;
        return {};
      },
      io,
    ),
    { anything: [1, 2] },
  );
  assert.equal(built, 0, "the builder must not run when --from-json is given");

  // Absent and empty both mean "build it".
  for (const fromJson of [undefined, ""]) {
    assert.deepEqual(
      await payloadOrObject(fromJson, () => ({ built: true }), io),
      {
        built: true,
      },
    );
  }
});

test("requiredPayload demands --from-json", async () => {
  const io = fakeIo({ files: { "/r.json": "[]" } });
  const error = await rejectsWithCode("usage_error", () =>
    requiredPayload(undefined, "redirects apply", io),
  );
  assert.equal(error.message, "redirects apply requires --from-json.");
  assert.deepEqual(await requiredPayload("/r.json", "redirects apply", io), []);
});

test("buildQuery preserves order and drops unset parameters", () => {
  assert.deepEqual(
    buildQuery([
      ["limit", 10],
      ["offset", 0],
      ["category", undefined],
      ["site_id", ""],
      ["regex_search", true],
      ["language", "en"],
    ]),
    [
      ["limit", "10"],
      ["offset", "0"],
      ["regex_search", "true"],
      ["language", "en"],
    ],
  );
});

/* -------------------------------------------------------------------------- */
/* payloads.ts — sites and environments                                       */
/* -------------------------------------------------------------------------- */

test("site create builds the WordPress install body", async () => {
  const io = fakeIo({ env: { ADMIN_PW: "s3cr3t" } });
  assert.deepEqual(
    await siteCreatePayload(
      {
        displayName: "Example",
        region: "europe-west1",
        siteTitle: "Example Site",
        adminEmail: "admin@example.com",
        adminUser: "admin",
        adminPasswordEnv: "ADMIN_PW",
        isMultisite: true,
      },
      io,
    ),
    {
      display_name: "Example",
      region: "europe-west1",
      install_mode: "new",
      admin_email: "admin@example.com",
      admin_password: "s3cr3t",
      admin_user: "admin",
      site_title: "Example Site",
      wp_language: DEFAULT_WP_LANGUAGE,
      is_multisite: true,
      is_subdomain_multisite: false,
      woocommerce: false,
      wordpressseo: false,
    },
  );
});

test("site create switches to the InstaWP template body", async () => {
  const io = fakeIo();
  assert.deepEqual(
    await siteCreatePayload(
      {
        siteName: "demo",
        templateSlug: "starter",
        shared: true,
        email: "a@b.c",
      },
      io,
    ),
    {
      site_name: "demo",
      template_slug: "starter",
      is_shared: true,
      email: "a@b.c",
    },
  );
  // A reserved-only invocation still takes the template branch, and none of the
  // WordPress-install options are then required.
  assert.deepEqual(await siteCreatePayload({ reserved: true }, io), {
    is_reserved: true,
  });
});

test("site create-plain, clone and reset keep their Go bodies", async () => {
  const io = fakeIo({ env: { ADMIN_PW: "s3cr3t" } });
  assert.deepEqual(
    await siteCreatePlainPayload({ displayName: "Plain", region: "eu" }, io),
    { display_name: "Plain", region: "eu" },
  );
  assert.deepEqual(
    await siteClonePayload({ displayName: "Copy", sourceEnv: "env-1" }, io),
    { display_name: "Copy", source_env_id: "env-1" },
  );
  assert.deepEqual(
    await siteResetPayload({ adminPasswordEnv: "ADMIN_PW" }, io),
    {
      admin_password: "s3cr3t",
    },
  );
  await rejectsWithCode("usage_error", () =>
    siteClonePayload({ displayName: "Copy" }, io),
  );
});

test("environment payloads carry the premium and asset flags", async () => {
  const io = fakeIo({ env: { ADMIN_PW: "s3cr3t" } });
  assert.deepEqual(
    await environmentCreatePayload(
      {
        displayName: "staging",
        siteTitle: "Staging",
        adminEmail: "a@b.c",
        adminUser: "admin",
        adminPasswordStdin: undefined,
        adminPasswordEnv: "ADMIN_PW",
        isPremium: true,
        wordpressPluginEdd: true,
        wpLanguage: "it_IT",
      },
      io,
    ),
    {
      display_name: "staging",
      site_title: "Staging",
      is_premium: true,
      admin_email: "a@b.c",
      admin_password: "s3cr3t",
      admin_user: "admin",
      wp_language: "it_IT",
      is_multisite: false,
      is_subdomain_multisite: false,
      woocommerce: false,
      wordpress_plugin_edd: true,
      wordpressseo: false,
    },
  );
  assert.deepEqual(
    await environmentCreatePlainPayload({ displayName: "staging" }, io),
    { display_name: "staging", is_premium: false },
  );
  assert.deepEqual(
    await environmentClonePayload(
      { displayName: "copy", sourceEnv: "env-1", isPremium: true },
      io,
    ),
    { display_name: "copy", source_env_id: "env-1", is_premium: true },
  );
});

test("environment push chooses ALL_FILES or SPECIFIC_FILES", async () => {
  const io = fakeIo();
  assert.deepEqual(
    await environmentPushPayload({ sourceEnv: "a", targetEnv: "b" }, io),
    {
      source_env_id: "a",
      target_env_id: "b",
      push_db: true,
      push_files: true,
      run_search_and_replace: true,
      push_files_option: "ALL_FILES",
    },
  );
  assert.deepEqual(
    await environmentPushPayload(
      {
        sourceEnv: "a",
        targetEnv: "b",
        noDb: true,
        noSearchReplace: true,
        file: ["wp-content/uploads", "wp-content/themes"],
      },
      io,
    ),
    {
      source_env_id: "a",
      target_env_id: "b",
      push_db: false,
      push_files: true,
      run_search_and_replace: false,
      push_files_option: "SPECIFIC_FILES",
      file_list: ["wp-content/uploads", "wp-content/themes"],
    },
  );
});

/* -------------------------------------------------------------------------- */
/* payloads.ts — domains, DNS and cache                                       */
/* -------------------------------------------------------------------------- */

test("domain add inlines certificate files without echoing them", async () => {
  const io = fakeIo({
    files: { "/tls.key": "KEY-BYTES", "/tls.crt": "CERT-BYTES" },
  });
  assert.deepEqual(
    await domainAddPayload(
      {
        domainName: "example.com",
        addWithWwwSubdomain: true,
        setupType: "avoid_downtime",
        customSslKeyFile: "/tls.key",
        customSslCertFile: "/tls.crt",
      },
      io,
    ),
    {
      domain_name: "example.com",
      is_wildcardless: false,
      add_with_www_subdomain: true,
      setup_type: "avoid_downtime",
      custom_ssl_key: "KEY-BYTES",
      custom_ssl_cert: "CERT-BYTES",
    },
  );
  assert.deepEqual(await domainAddPayload({ domainName: "example.com" }, io), {
    domain_name: "example.com",
    is_wildcardless: false,
    add_with_www_subdomain: false,
  });
});

test("domain delete requires at least one id and primary carries search-replace", async () => {
  const io = fakeIo();
  const error = await rejectsWithCode("usage_error", () =>
    domainDeletePayload({}, io),
  );
  assert.equal(error.message, "At least one --domain-id is required.");
  assert.deepEqual(await domainDeletePayload({ domainId: ["d1", "d2"] }, io), {
    domain_ids: ["d1", "d2"],
  });
  assert.deepEqual(
    await domainPrimaryPayload({ domainId: "d1", searchReplace: true }, io),
    { domain_id: "d1", run_search_and_replace: true },
  );
});

test("DNS record payloads keep the resource-record wrapper and optional ttl", async () => {
  const io = fakeIo();
  assert.deepEqual(
    await dnsRecordCreatePayload(
      { recordType: "A", name: "www", value: ["1.2.3.4", "5.6.7.8"] },
      io,
    ),
    {
      type: "A",
      name: "www",
      resource_records: [{ value: "1.2.3.4" }, { value: "5.6.7.8" }],
    },
  );
  assert.deepEqual(
    await dnsRecordCreatePayload(
      { recordType: "A", name: "www", ttl: 300, value: ["1.2.3.4"] },
      io,
    ),
    {
      type: "A",
      name: "www",
      ttl: 300,
      resource_records: [{ value: "1.2.3.4" }],
    },
  );
  const error = await rejectsWithCode("usage_error", () =>
    dnsRecordCreatePayload({ recordType: "A", name: "www" }, io),
  );
  assert.equal(error.message, "At least one --value is required.");

  assert.deepEqual(
    await dnsRecordUpdatePayload(
      {
        recordType: "A",
        name: "www",
        addValue: ["1.1.1.1"],
        removeValue: ["2.2.2.2"],
      },
      io,
    ),
    {
      type: "A",
      name: "www",
      new_resource_records: [{ value: "1.1.1.1" }],
      removed_resource_records: [{ value: "2.2.2.2" }],
    },
  );
  assert.deepEqual(
    await dnsRecordUpdatePayload({ recordType: "A", name: "www" }, io),
    { type: "A", name: "www" },
  );
  assert.deepEqual(
    await dnsRecordDeletePayload({ recordType: "A", name: "www" }, io),
    { type: "A", name: "www" },
  );
});

test("cache clear builds a different body per cache layer", async () => {
  const io = fakeIo();
  assert.deepEqual(
    await cacheClearPayload({ kind: "site", env: "env-1" }, io),
    {
      environment_id: "env-1",
    },
  );
  assert.deepEqual(
    await cacheClearPayload(
      {
        kind: "edge",
        env: "env-1",
        clearSubdirectories: true,
        url: "https://x/y",
      },
      io,
    ),
    {
      environment_id: "env-1",
      clear_subdirectories: true,
      url: "https://x/y",
    },
  );
  assert.deepEqual(
    await cacheClearPayload(
      { kind: "cdn", env: "env-1", cdnCacheId: "c1" },
      io,
    ),
    { environment_id: "env-1", cdn_cache_id: "c1" },
  );
  await rejectsWithCode("usage_error", () =>
    cacheClearPayload({ kind: "cdn", env: "env-1" }, io),
  );
});

/* -------------------------------------------------------------------------- */
/* payloads.ts — WordPress assets and WP-CLI                                  */
/* -------------------------------------------------------------------------- */

test("asset update payloads name the plugin or theme collection", async () => {
  const io = fakeIo();
  assert.deepEqual(
    await wpAssetUpdatePayload({ name: "akismet", updateVersion: "5.3" }, io),
    { name: "akismet", update_version: "5.3" },
  );
  assert.deepEqual(
    await wpAssetUpdateAllPayload(
      { name: ["akismet", "novamira"] },
      "plugins",
      io,
    ),
    { plugins: [{ name: "akismet" }, { name: "novamira" }] },
  );
  assert.deepEqual(await wpAssetUpdateAllPayload({}, "themes", io), {
    themes: [],
  });
});

// Ported from TestWpPluginInstallPayloadBuildsWpCliCommand.
test("plugin install builds the WP-CLI command line", async () => {
  const payload = await wpPluginInstallPayload(
    {
      source:
        "https://github.com/use-novamira/novamira/releases/latest/download/novamira.zip",
      force: true,
      activate: true,
      ignoreRequirements: true,
    },
    fakeIo(),
  );
  assert.equal(
    payload.wp_command,
    "wp plugin install https://github.com/use-novamira/novamira/releases/latest/download/novamira.zip --force --ignore-requirements --activate",
  );
});

// Ported from TestWpPluginInstallPayloadUsesNetworkActivation.
test("plugin install prefers network activation over plain activation", async () => {
  const payload = await wpPluginInstallPayload(
    { source: "novamira", activate: true, activateNetwork: true },
    fakeIo(),
  );
  assert.equal(
    payload.wp_command,
    "wp plugin install novamira --activate-network",
  );
});

// Ported from TestWpPluginInstallPayloadSupportsInstaWPCommandID.
test("plugin install supports the InstaWP saved-command id", async () => {
  const payload = await wpPluginInstallPayload({ commandId: 42 }, fakeIo());
  assert.deepEqual(payload, { command_id: 42 });
  assert.equal(Object.hasOwn(payload, "wp_command"), false);
  // Go treated 0 as "unset"; so does HQ.
  await rejectsWithCode("usage_error", () =>
    wpPluginInstallPayload({ commandId: 0 }, fakeIo()),
  );
});

// Ported from TestWpPluginInstallPayloadRejectsUnsupportedCommandChars.
test("plugin install refuses a source a provider shell could reinterpret", async () => {
  const error = await rejectsWithCode("usage_error", () =>
    wpPluginInstallPayload(
      { source: "https://example.com/plugin.zip?token=secret" },
      fakeIo(),
    ),
  );
  assert.match(error.message, /can contain only letters, numbers, spaces/);
  // The offending value may carry a token, so it is never echoed back.
  assert.equal(error.message.includes("secret"), false);
});

test("shell quoting is strict and version pinning survives it", () => {
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("novamira"), "novamira");
  assert.equal(shellQuote("two words"), "'two words'");
  throwsWithCode("usage_error", () => shellQuote("it's"));
  throwsWithCode("usage_error", () => shellQuote("a;b"));
  throwsWithCode("usage_error", () => shellQuote("a$b"));
  assert.equal(
    shellJoin(["wp", "option", "get", "siteurl"]),
    "wp option get siteurl",
  );
  assert.equal(
    wpPluginActivateCommand("novamira", true),
    "wp plugin activate novamira --network",
  );
  assert.equal(
    wpPluginActivateCommand("novamira", false),
    "wp plugin activate novamira",
  );
});

test("wp-cli run takes its command from an option, stdin or JSON", async () => {
  assert.deepEqual(
    await wpCliPayload({ command: "wp option get siteurl" }, fakeIo()),
    { wp_command: "wp option get siteurl" },
  );
  assert.deepEqual(
    await wpCliPayload(
      { commandStdin: true },
      fakeIo({ stdin: "wp plugin list --format=json\n" }),
    ),
    { wp_command: "wp plugin list --format=json" },
  );
  assert.deepEqual(
    await wpCliPayload(
      { fromJson: "/c.json" },
      fakeIo({ files: { "/c.json": '{"wp_command":"wp cron event list"}' } }),
    ),
    { wp_command: "wp cron event list" },
  );
  await rejectsWithCode("usage_error", () => wpCliPayload({}, fakeIo()));
  assert.deepEqual(wpCliCommandPayload("wp option get siteurl"), {
    wp_command: "wp option get siteurl",
  });
});

/* -------------------------------------------------------------------------- */
/* payloads.ts — backups, PHP, denied IPs, SSH and SFTP                       */
/* -------------------------------------------------------------------------- */

test("the bodies Go built inline are now shared builders", async () => {
  const io = fakeIo({ env: { SFTP_PW: "s3cr3t" } });

  assert.deepEqual(await backupCreatePayload({}, io), {});
  assert.deepEqual(await backupCreatePayload({ tag: "" }, io), { tag: "" });
  assert.deepEqual(await backupCreatePayload({ tag: "nightly" }, io), {
    tag: "nightly",
  });

  assert.deepEqual(
    await backupRestorePayload({ backupId: 12, notifiedUserId: "u1" }, io),
    { backup_id: 12, notified_user_id: "u1" },
  );
  await rejectsWithCode("usage_error", () =>
    backupRestorePayload({ notifiedUserId: "u1" }, io),
  );

  assert.deepEqual(
    await phpSetVersionPayload({ env: "env-1", phpVersion: "8.3" }, io),
    { environment_id: "env-1", php_version: "8.3" },
  );
  assert.deepEqual(
    await phpSetVersionPayload(
      { env: "env-1", phpVersion: "8.3", optOutAutoUpdates: true },
      io,
    ),
    {
      environment_id: "env-1",
      php_version: "8.3",
      is_opt_out_from_automatic_php_update: true,
    },
  );

  assert.deepEqual(
    await deniedIpsSetPayload({ env: "env-1", ip: ["1.2.3.4"] }, io),
    { environment_id: "env-1", ip_list: ["1.2.3.4"] },
  );
  assert.deepEqual(await sshAllowlistPayload({}, io), { ip_allowlist: [] });

  assert.deepEqual(
    await sftpAddPayload({ username: "deploy", passwordEnv: "SFTP_PW" }, io),
    {
      username: "deploy",
      password: "s3cr3t",
      root_directory: DEFAULT_SFTP_ROOT_DIRECTORY,
      permission: DEFAULT_SFTP_PERMISSION,
    },
  );
});

/* -------------------------------------------------------------------------- */
/* print.ts                                                                   */
/* -------------------------------------------------------------------------- */

const SITE = {
  id: "site-1",
  name: "example",
  displayName: "Example Site",
  status: "live",
  primaryDomain: "example.com",
};

const ENVIRONMENT = {
  id: "env-1",
  name: "staging",
  displayName: "Staging",
  isBlocked: false,
  isPremium: true,
  wordpressVersion: "6.9",
};

test("truncate matches Go's rune-counting ellipsis", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("exactly-10", 10), "exactly-10");
  assert.equal(truncate("abcdefghijk", 10), "abcdefg...");
  assert.equal(truncate("abcdef", 2), "...");
  assert.equal(truncate("ααααααααααα", 10), "ααααααα...");
});

test("site rendering emits snake_case data and Go's column layout", () => {
  const result = renderSites([{ ...SITE, environments: [ENVIRONMENT] }]);
  assert.deepEqual(result.data, [
    {
      id: "site-1",
      name: "example",
      display_name: "Example Site",
      status: "live",
      primary_domain: "example.com",
      environments: [
        {
          id: "env-1",
          name: "staging",
          display_name: "Staging",
          is_blocked: false,
          is_premium: true,
          wordpress_version: "6.9",
        },
      ],
    },
  ]);
  const lines = result.human.split("\n");
  assert.match(lines[0], /^ID\s+DISPLAY NAME\s+STATUS\s+DOMAIN$/);
  assert.match(lines[1], /^site-1\s+Example Site\s+live\s+example\.com$/);
  assert.match(lines[2], /^ {2}env env-1\s+Staging\s+-$/);

  const single = renderSite(SITE);
  assert.equal(
    single.human,
    [
      "id: site-1",
      "name: example",
      "display_name: Example Site",
      "status: live",
      "primary_domain: example.com",
    ].join("\n"),
  );
  // An included but empty environment list still renders the header.
  assert.match(
    renderSite({ ...SITE, environments: [] }).human,
    /environments:\n/,
  );
});

test("environment rendering keeps the blocked and premium columns", () => {
  const table = renderEnvironments([ENVIRONMENT]).human.split("\n");
  assert.match(
    table[0],
    /^ID\s+DISPLAY NAME\s+BLOCKED\s+PREMIUM\s+WP VERSION\s+DOMAIN$/,
  );
  assert.match(table[1], /^env-1\s+Staging\s+false\s+true\s+6\.9\s+-$/);

  const one = renderEnvironment(ENVIRONMENT);
  assert.equal(one.data.is_premium, true);
  assert.match(one.human, /^is_blocked: false$/m);
  assert.match(one.human, /^primary_domain: -$/m);
});

test("action and operation rendering drop the empty-message trailing space", () => {
  const base = {
    provider: "kinsta",
    action: "sites.create",
    status: 202,
    raw: null,
  };
  assert.equal(renderAction(base).human, "sites.create status=202");
  assert.equal(
    renderAction({ ...base, operationId: "op-1", message: "queued" }).human,
    "sites.create status=202 operation=op-1 queued",
  );
  assert.deepEqual(renderAction({ ...base, operationId: "op-1" }).data, {
    provider: "kinsta",
    action: "sites.create",
    status: 202,
    operation_id: "op-1",
    raw: null,
  });

  const status = {
    provider: "kinsta",
    operationId: "op-1",
    status: 200,
    done: true,
    failed: false,
    raw: { ok: true },
  };
  assert.equal(
    renderOperation(status).human,
    "op-1 status=200 done=true failed=false",
  );
  assert.equal(
    renderOperation({ ...status, message: "finished" }).human,
    "op-1 status=200 done=true failed=false finished",
  );
});

test("validation and secret-write rendering never expose a value", () => {
  const validation = renderValidation({
    provider: "kinsta",
    status: "ok",
    companyId: null,
    credential: "env:KINSTA_API_KEY",
  });
  assert.equal(
    validation.human,
    "kinsta credential=env:KINSTA_API_KEY status=ok company=(not set)",
  );
  assert.equal(validation.data.company_id, null);

  const write = renderSecretWrite("/tmp/ssh-password");
  assert.deepEqual(write.data, {
    path: "/tmp/ssh-password",
    value: "********",
  });
  assert.equal(write.human, "wrote redacted secret to /tmp/ssh-password");
});

test("raw provider values pass through, with null for an empty body", () => {
  assert.deepEqual(renderRaw({ a: [1] }).data, { a: [1] });
  assert.equal(renderRaw({ a: 1 }).human, '{\n  "a": 1\n}');
  assert.equal(renderRaw(undefined).data, null);
  assert.equal(renderRaw(null).data, null);
});

// Ported from TestSiteDeleteCapabilityIsDisabledForCLI.
test("the sites.delete capability is reported unsupported", () => {
  const value = disableSiteDeleteCapability([
    { name: "sites.list", supported: true },
    { name: SITE_DELETE_CAPABILITY, supported: true },
  ]);
  assert.equal(
    value[0].supported,
    true,
    "an unrelated capability was modified",
  );
  assert.equal(value[0].name, "sites.list");
  assert.equal(value[1].supported, false);
  assert.equal(typeof value[1].notes, "string");
  assert.notEqual(value[1].notes, "");
});

test("a response that is not a capability list is passed through unchanged", () => {
  for (const value of [
    null,
    { message: "not a list" },
    [{ unexpected: true }],
    [{ name: "sites.list", supported: "yes" }],
    "text",
  ]) {
    assert.equal(disableSiteDeleteCapability(value), value);
  }
  // Notes on unrelated capabilities survive the round trip.
  assert.deepEqual(
    disableSiteDeleteCapability([
      { name: "sites.list", supported: false, notes: "read-only key" },
    ]),
    [{ name: "sites.list", supported: false, notes: "read-only key" }],
  );
});

/* -------------------------------------------------------------------------- */
/* hosting-command.ts                                                         */
/* -------------------------------------------------------------------------- */

function fakeDependencies({
  client,
  profiles = { prod: { provider: "kinsta" } },
} = {}) {
  const chunks = { out: [], err: [] };
  const renderer = createRenderer(
    { json: true, requestId: "req-1" },
    {
      stdout: { write: (chunk) => chunks.out.push(chunk) },
      stderr: { write: (chunk) => chunks.err.push(chunk) },
    },
  );
  return {
    chunks,
    renderer,
    dependencies: {
      store: {
        async selectHostingProfile(requested) {
          if (requested === undefined || requested === "") {
            const { CliError } = await import("../dist/errors.js");
            throw new CliError(
              "usage_error",
              "Select a hosting profile with --profile.",
              { details: { profiles: Object.keys(profiles) } },
            );
          }
          const profile = profiles[requested];
          if (profile === undefined) {
            const { CliError } = await import("../dist/errors.js");
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
      io: fakeIo(),
      rendererFor: () => renderer,
    },
  };
}

test("runHostingCommand resolves the profile and stamps meta", async () => {
  const client = { provider: "kinsta" };
  const { chunks, dependencies } = fakeDependencies({ client });

  let seen;
  await runHostingCommand(
    dependencies,
    { json: true, profile: "prod" },
    (context) => {
      seen = context;
      return renderAction({
        provider: "kinsta",
        action: "sites.create",
        status: 202,
        raw: null,
      });
    },
  );

  assert.equal(seen.client, client);
  assert.equal(seen.entry.name, "prod");
  assert.equal(seen.options.profile, "prod");
  assert.equal(typeof seen.io.readStdin, "function");

  const envelope = JSON.parse(chunks.out.join(""));
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.action, "sites.create");
  assert.deepEqual(envelope.meta, {
    requestId: "req-1",
    profile: "prod",
    provider: "kinsta",
  });
});

test("a hosting command without --profile fails usage_error, never inferred", async () => {
  const { dependencies } = fakeDependencies({ client: { provider: "kinsta" } });
  const error = await rejectsWithCode("usage_error", () =>
    runHostingCommand(dependencies, { json: true }, () => ({ data: null })),
  );
  assert.deepEqual(error.details.profiles, ["prod"]);
  await rejectsWithCode("profile_not_found", () =>
    resolveHostingClient(dependencies, { profile: "nope" }),
  );
});

test("runLocalCommand renders without touching a provider", async () => {
  const { chunks, dependencies } = fakeDependencies({
    client: {
      provider: "kinsta",
      get shouldNotBeUsed() {
        throw new Error("a local command must not build a client");
      },
    },
  });
  await runLocalCommand(dependencies, { json: true }, () => ({
    data: { local: true },
    warnings: [{ code: "novamira_cli_missing", message: "install novamira" }],
  }));
  const envelope = JSON.parse(chunks.out.join(""));
  assert.deepEqual(envelope.data, { local: true });
  assert.equal(envelope.meta.profile, undefined);
  assert.equal(envelope.meta.warnings[0].code, "novamira_cli_missing");
});

test("waitForOperationStatus polls until done, failed, or the budget is spent", async () => {
  const statuses = [
    { done: false, failed: false },
    { done: false, failed: false },
    { done: true, failed: false, operationId: "op-1" },
  ];
  let index = 0;
  const slept = [];
  const client = {
    provider: "kinsta",
    async operationStatus() {
      return {
        provider: "kinsta",
        operationId: "op-1",
        status: 200,
        raw: null,
        ...statuses[index++],
      };
    },
  };
  const status = await waitForOperationStatus(client, "op-1", {
    intervalSeconds: 5,
    timeoutSeconds: 300,
    sleep: async (ms) => void slept.push(ms),
    now: () => 0,
  });
  assert.equal(status.done, true);
  assert.deepEqual(slept, [5000, 5000]);

  // A failed operation is returned, not thrown: callers decide.
  const failing = {
    provider: "kinsta",
    async operationStatus() {
      return {
        provider: "kinsta",
        operationId: "op-2",
        status: 500,
        done: false,
        failed: true,
        message: "provider exploded",
        raw: null,
      };
    },
  };
  const failed = await waitForOperationStatus(failing, "op-2", {
    intervalSeconds: 5,
    timeoutSeconds: 300,
    sleep: async () => undefined,
    now: () => 0,
  });
  assert.equal(failed.failed, true);
  const error = operationFailure(failed);
  assert.equal(error.code, "provider_error");
  assert.equal(error.message, "Operation op-2 failed: provider exploded");
  assert.equal(
    operationFailure({ ...failed, message: undefined }).message,
    "Operation op-2 failed: provider reported failure",
  );
});

test("waitForOperationStatus times out and refuses a zero interval", async () => {
  const pending = {
    provider: "kinsta",
    async operationStatus() {
      return {
        provider: "kinsta",
        operationId: "op-3",
        status: 200,
        done: false,
        failed: false,
        raw: null,
      };
    },
  };
  let clock = 0;
  const timeout = await rejectsWithCode("timeout", () =>
    waitForOperationStatus(pending, "op-3", {
      intervalSeconds: 5,
      timeoutSeconds: 10,
      sleep: async () => {
        clock += 5000;
      },
      now: () => clock,
    }),
  );
  assert.equal(timeout.retryable, true);
  assert.equal(timeout.details.operationId, "op-3");

  const usage = await rejectsWithCode("usage_error", () =>
    waitForOperationStatus(pending, "op-3", {
      intervalSeconds: 0,
      timeoutSeconds: 10,
    }),
  );
  assert.equal(usage.message, "--interval-seconds must be greater than zero.");
});

test("waitForOperationStatus aborts an injected polling sleep", async () => {
  const controller = new AbortController();
  const waiting = waitForOperationStatus(
    {
      provider: "kinsta",
      async operationStatus() {
        return {
          provider: "kinsta",
          operationId: "op-abort",
          status: 200,
          done: false,
          failed: false,
          raw: null,
        };
      },
    },
    "op-abort",
    {
      intervalSeconds: 5,
      timeoutSeconds: 300,
      sleep: () => new Promise(() => undefined),
      signal: controller.signal,
    },
  );
  await Promise.resolve();
  controller.abort(new Error("dashboard stopped"));
  await assert.rejects(waiting, /dashboard stopped/);
});
