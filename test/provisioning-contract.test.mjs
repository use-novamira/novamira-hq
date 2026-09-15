// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract test for `src/provisioning/` — the provisioning service's own units,
 * with no commander, no `Renderer`, no `CommandIo` and no provider client
 * anywhere in this file. That is the point: Phase 6's dashboard calls the same
 * modules directly, so anything that needs the CLI to be exercised would be in
 * the wrong layer.
 *
 * Completely offline. The one outbound seam (`HttpFetch`) is a literal double
 * that records every call, so the compatibility read is exercised without a
 * socket, and every "must fail" case asserts the `CliError` code, the
 * `details.check` handle and how many attempts were spent.
 *
 * The compatibility fixtures are copied from the plugin itself —
 * `novamira/includes/oauth/endpoints/discovery.php`'s
 * `protected_resource_document()` and `novamira/includes/compatibility.php`'s
 * `novamira_server_compatibility()` — so a plugin-side rename fails here rather
 * than in production.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CliError } from "../dist/errors.js";
import { shellJoin } from "../dist/hosting/shell.js";
import {
  COMPATIBILITY_CHECKS,
  METADATA_MAX_BYTES,
  MINIMUM_NOVAMIRA_VERSION,
  MINIMUM_WORDPRESS_VERSION,
  PROTECTED_RESOURCE_PATH,
  REQUIRED_FEATURES,
  assertCompatible,
  checkSiteCompatibility,
  compareDotted,
  compareSemver,
  metadataUrl,
  parseDotted,
  parseSemver,
  readCompatibilityBlock,
} from "../dist/provisioning/compatibility.js";
import {
  SITE_CLI_EXECUTABLE,
  connectHandoff,
  handoffData,
  handoffHuman,
} from "../dist/provisioning/handoff.js";
import {
  NOVAMIRA_DOWNLOAD_URL,
  NOVAMIRA_LATEST_SOURCE_ALIAS,
  resolvePluginSource,
  validateRemotePluginSource,
} from "../dist/provisioning/plugin.js";
import {
  NOVAMIRA_SETUP_MINIMUM_PHP,
  PHP_VERSION_COMMAND,
  ensureNovamiraSetupPhp,
  phpVersionFromOutput,
} from "../dist/provisioning/phpcompat.js";
import { normalizeSiteUrl } from "../dist/provisioning/site-url.js";
import { VERSION } from "../dist/version.js";
import { cleanWpCliOutput, wpCliOutput } from "../dist/provisioning/wp-cli.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** The `CliError` a thunk raised, or a failed assertion naming what it did. */
async function raised(body, label) {
  try {
    await body();
  } catch (error) {
    assert.ok(error instanceof CliError, `${label}: not a CliError: ${error}`);
    return error;
  }
  return assert.fail(`${label}: expected a failure`);
}

/** A literal {@link HttpResponse}: a plain object, never a real `Response`. */
function response({ status = 200, body = "", headers = {} } = {}) {
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

/** A 3xx with a `Location`, so the manual-redirect path can be driven. */
function redirect(location, status = 302) {
  return response({ status, headers: { location } });
}

/**
 * A recording `HttpFetch`. `script(url, attempt)` returns the response or
 * throws; every call is kept so a test can assert exactly how many attempts
 * were spent and which URLs were reached.
 */
function scriptedFetch(script) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    return script(url, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function siteOf(raw, environment = {}) {
  return normalizeSiteUrl(raw, environment, "--url");
}

/* -------------------------------------------------------------------------- */
/* Compatibility fixtures                                                     */
/* -------------------------------------------------------------------------- */

/** `novamira_server_compatibility()` as the released plugin publishes it. */
function compatibilityBlock(overrides = {}) {
  return {
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
    ...overrides,
  };
}

/** `protected_resource_document()`, for a site rooted at `siteUrl`. */
function protectedResourceDocument(siteUrl, overrides = {}, block = {}) {
  return {
    resource: `${siteUrl}/wp-json/mcp/novamira-oauth`,
    authorization_servers: [siteUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
    novamira: compatibilityBlock(block),
    ...overrides,
  };
}

const SITE_URL = "https://example.com";
const SITE = siteOf(SITE_URL);
const METADATA_URL = `${SITE_URL}${PROTECTED_RESOURCE_PATH}`;

/** Serve one document at the expected URL and 404 everything else. */
function serving(document) {
  return scriptedFetch((url) =>
    url === METADATA_URL
      ? response({ body: document })
      : response({ status: 404 }),
  );
}

/** Read the metadata once. */
function check(fetchImpl, site = SITE, options = {}) {
  return checkSiteCompatibility(site, {
    fetch: fetchImpl,
    ...options,
  });
}

/** The `CliError` a compatibility read raised, asserted to be one. */
async function checkFails(fetchImpl, site = SITE, label = "compatibility") {
  return raised(() => check(fetchImpl, site), label);
}

/* -------------------------------------------------------------------------- */
/* wpCliOutput: the nine provider shapes Go's regression test pinned           */
/* -------------------------------------------------------------------------- */

test("wpCliOutput finds the result wherever a provider put it", () => {
  // 1-3: the three flat shapes, in Go's pointer order.
  assert.equal(wpCliOutput({ data: { result: "secret" } }), "secret");
  assert.equal(wpCliOutput({ data: { output: "secret" } }), "secret");
  assert.equal(wpCliOutput({ result: { response: "secret" } }), "secret");

  // 4: Rocket.net smuggles a JSON document inside the string.
  assert.equal(
    wpCliOutput({
      result: { response: JSON.stringify({ data: "admin", status: 1 }) },
    }),
    "admin",
  );

  // 5: InstaWP returns an array of per-command records.
  assert.equal(wpCliOutput({ data: [{ output: "secret" }] }), "secret");

  // 6: a whole multi-line value, echo and all, is returned unchanged — the
  // echo is `cleanWpCliOutput`'s job, not this one's.
  assert.equal(
    wpCliOutput({
      data: "2026-06-18 10:26:27 wp option get home\nhttps://example.test",
    }),
    "2026-06-18 10:26:27 wp option get home\nhttps://example.test",
  );

  // 7: a `/data` object with no string member falls through to a later pointer.
  assert.equal(
    wpCliOutput({
      data: { meta: { code: 1 } },
      result: { response: "secret" },
    }),
    "secret",
  );

  // 8: an unparseable or non-object payload is "", never an error.
  assert.equal(wpCliOutput("not json at all"), "");
  assert.equal(wpCliOutput(null), "");
  assert.equal(wpCliOutput(42), "");

  // 9: an array whose entries are not objects yields nothing.
  assert.equal(wpCliOutput({ data: ["a", "b"] }), "");
});

/* -------------------------------------------------------------------------- */
/* cleanWpCliOutput                                                           */
/* -------------------------------------------------------------------------- */

test("cleanWpCliOutput strips the provider's echo and only the echo", () => {
  // 10: a timestamped echo line.
  assert.equal(
    cleanWpCliOutput(
      "2026-06-18 10:26:27 wp option get home\nhttps://example.test\n",
      "wp option get home",
    ),
    "https://example.test",
  );

  // 11: a bare echo line equal to the command.
  assert.equal(
    cleanWpCliOutput(
      "wp option get home\nhttps://example.test",
      "wp option get home",
    ),
    "https://example.test",
  );

  // 12: stripping stops at the first non-echo line, so a later repetition of
  // the command inside real output survives.
  assert.equal(
    cleanWpCliOutput(
      "wp option get home\nfirst\nwp option get home\nlast",
      "wp option get home",
    ),
    "first\nwp option get home\nlast",
  );

  // 13: interior indentation survives; every trailing `\r` is removed, not
  // one, because Go's `strings.TrimRight(s, "\r")` takes a cutset.
  assert.equal(
    cleanWpCliOutput(
      "wp plugin status novamira\r\nPlugin details:\r\r\n  Status: Active",
      "wp plugin status novamira",
    ),
    "Plugin details:\n  Status: Active",
  );

  // 14: empty and whitespace-only input.
  assert.equal(cleanWpCliOutput("", "wp option get home"), "");
  assert.equal(cleanWpCliOutput("   \n \t ", "wp option get home"), "");
});

/* -------------------------------------------------------------------------- */
/* The PHP gate                                                               */
/* -------------------------------------------------------------------------- */

test("the PHP gate accepts 8.x and reports the raw version", () => {
  // 15: three components.
  assert.equal(ensureNovamiraSetupPhp("8.2.12"), "8.2.12");
  assert.deepEqual(phpVersionFromOutput("8.2.12"), {
    major: 8,
    minor: 2,
    patch: 12,
    raw: "8.2.12",
  });

  // 16: two components, patch defaulting to 0.
  assert.equal(ensureNovamiraSetupPhp("8.0"), "8.0");
  assert.deepEqual(phpVersionFromOutput("8.0"), {
    major: 8,
    minor: 0,
    patch: 0,
    raw: "8.0",
  });
});

test("the PHP gate refuses a site below PHP 8 as server_unsupported", async () => {
  // 17.
  const error = await raised(() => ensureNovamiraSetupPhp("7.4.33"), "php 7.4");
  assert.equal(error.code, "server_unsupported");
  assert.equal(error.retryable, false);
  assert.match(error.message, /7\.4\.33/);
  assert.match(error.message, new RegExp(`PHP ${NOVAMIRA_SETUP_MINIMUM_PHP}`));
  assert.equal(error.details.check, "php.version");
  assert.equal(error.details.phpVersion, "7.4.33");
});

test("the PHP version is the LAST version-like token in the output", async () => {
  // 18: an unstripped read, where the echo carries no version but the command
  // line could; the value `echo` produced is the last token.
  const echoed = await raised(
    () => ensureNovamiraSetupPhp("2026-06-30 wp cli info\n7.4.33\n"),
    "echoed php",
  );
  assert.equal(echoed.code, "server_unsupported");
  assert.match(echoed.message, /7\.4\.33/);

  // 19: a deprecation notice mentioning 5.6 must not win over the real value.
  assert.equal(
    ensureNovamiraSetupPhp(
      "Deprecated: Function x() is deprecated since 5.6 in /www/wp-includes/f.php on line 12\n8.1.2",
    ),
    "8.1.2",
  );
});

test("output with no version in it is a provider_error, not server_unsupported", async () => {
  // 20: the provider did not give HQ a readable answer; the site said nothing.
  for (const output of ["", "no version here"]) {
    const error = await raised(
      () => ensureNovamiraSetupPhp(output),
      `php output ${JSON.stringify(output)}`,
    );
    assert.equal(error.code, "provider_error");
    assert.equal(error.details.command, PHP_VERSION_COMMAND);
  }
});

test("PHP_VERSION_COMMAND is spelled in the charset every provider accepts", async () => {
  // 21: Kinsta validates `wp_command` against `letters, numbers, spaces, single
  // quotes, _, -, ., /, :, =` and answers anything else with HTTP 400. `wp eval`
  // cannot satisfy it — PHP's `eval()` refuses an unterminated statement, so the
  // `;` is mandatory and rejected — and this gate is setup's FIRST request, so a
  // command outside the charset makes provisioning impossible on Kinsta.
  assert.equal(PHP_VERSION_COMMAND, "wp cli info");
  assert.match(PHP_VERSION_COMMAND, /^wp [a-z0-9 _.:/='-]+$/);

  // The old command is pinned as a counter-example so it cannot come back.
  assert.doesNotMatch("wp eval 'echo PHP_VERSION;'", /^wp [a-z0-9 _.:/='-]+$/);

  // It is still sent as a literal rather than joined: shellJoin quotes each
  // argument, which would spell `wp 'cli' 'info'` and defeat the charset.
  assert.equal(shellJoin(["wp", "cli", "info"]), "wp cli info");
});

test("the PHP gate reads wp cli info's label, not its trailing token", async () => {
  // 22: `wp cli info` prints WP-CLI's own version AFTER PHP's, so the
  // last-token rule alone would report 2.12.0 and refuse every site.
  const info = [
    "OS:\tLinux 6.8.0-1052-oracle #53-Ubuntu SMP x86_64",
    "Shell:\t",
    "PHP binary:\t/usr/bin/php8.5",
    "PHP version:\t8.5.7",
    "php.ini used:\t/etc/php/8.5/cli/php.ini",
    "MySQL version:\tmariadb from 11.4.7-MariaDB, client 15.2",
    "WP-CLI version:\t2.12.0",
  ].join("\n");

  assert.equal(ensureNovamiraSetupPhp(info), "8.5.7");
  assert.deepEqual(phpVersionFromOutput(info), {
    major: 8,
    minor: 5,
    patch: 7,
    raw: "8.5.7",
  });

  // The label still wins when the site is genuinely too old, so an operator on
  // PHP 7 gets server_unsupported rather than a WP-CLI version in the message.
  const old = await raised(
    () =>
      ensureNovamiraSetupPhp(
        info.replace("PHP version:\t8.5.7", "PHP version:\t7.4.33"),
      ),
    "php 7 via label",
  );
  assert.equal(old.code, "server_unsupported");
  assert.match(old.message, /7\.4\.33/);
});

/* -------------------------------------------------------------------------- */
/* normalizeSiteUrl                                                           */
/* -------------------------------------------------------------------------- */

test("normalizeSiteUrl keeps Go's one convenience", () => {
  // 22: a bare host is read as HTTPS.
  assert.deepEqual(siteOf("example.com"), {
    siteUrl: "https://example.com",
    origin: "https://example.com",
    host: "example.com",
    insecure: false,
  });
});

test("normalizeSiteUrl collapses and strips the path", () => {
  // 23.
  assert.equal(siteOf("https://example.com/").siteUrl, "https://example.com");
  assert.equal(siteOf("https://example.com///").siteUrl, "https://example.com");

  // 24: a subdirectory install keeps its path and reports the bare origin.
  const blog = siteOf("https://example.com/blog/");
  assert.equal(blog.siteUrl, "https://example.com/blog");
  assert.equal(blog.origin, "https://example.com");

  // 25: the port stays in the URL and never reaches the domain option.
  const ported = siteOf("https://example.com:8443/x");
  assert.equal(ported.siteUrl, "https://example.com:8443/x");
  assert.equal(ported.host, "example.com");
});

test("plain HTTP is loopback-only unless HQ's own opt-in is set", async () => {
  // 26: loopback needs no opt-in and is not "insecure".
  const local = siteOf("http://localhost:8080");
  assert.equal(local.siteUrl, "http://localhost:8080");
  assert.equal(local.insecure, false);
  assert.equal(siteOf("http://127.0.0.1:8080").insecure, false);

  // 27: a public host over HTTP needs the opt-in, and is flagged when accepted.
  const refused = await raised(
    () => siteOf("http://staging.example.com"),
    "http without opt-in",
  );
  assert.equal(refused.code, "usage_error");
  assert.match(refused.message, /NOVAMIRA_HQ_ALLOW_INSECURE_HTTP=1/);

  const allowed = siteOf("http://staging.example.com", {
    NOVAMIRA_HQ_ALLOW_INSECURE_HTTP: "1",
  });
  assert.equal(allowed.siteUrl, "http://staging.example.com");
  assert.equal(allowed.insecure, true);

  // The site CLI's own variable is never consulted.
  await raised(
    () =>
      siteOf("http://staging.example.com", {
        NOVAMIRA_ALLOW_INSECURE_HTTP: "1",
      }),
    "site CLI opt-in must not be read",
  );
});

test("every rejected site URL is a usage_error naming its source", async () => {
  // 28. `details.url` is the scheme-prefixed form HQ actually parsed, with any
  // userinfo removed — never the operator's raw string.
  const rejected = [
    ["ftp://example.com", "ftp://example.com"],
    ["https://u:p@example.com", "https://[REDACTED]@example.com"],
    ["https://example.com/?a=1", "https://example.com/?a=1"],
    ["https://example.com/#x", "https://example.com/#x"],
    ["", ""],
    ["   ", ""],
    ["u:p@example.com", "https://[REDACTED]@example.com"],
  ];
  for (const [raw, url] of rejected) {
    for (const source of ["--url", "wp option get home"]) {
      const error = await raised(
        () => normalizeSiteUrl(raw, {}, source),
        `${source} ${JSON.stringify(raw)}`,
      );
      assert.equal(error.code, "usage_error");
      assert.equal(error.retryable, false);
      assert.deepEqual(error.details, { flag: "--url", source, url });
    }
  }
});

test("a rejected site URL never echoes the credential it carried", async () => {
  // Normalize userinfo before the CliError exists as defense in depth; output
  // redaction must not be the first component to learn that this URL is unsafe.
  const carriers = [
    "https://admin:hunter2@example.com",
    "ftp://admin:hunter2@example.com",
    "http://admin:hunter2@staging.example.com",
    "https://admin:hunter2@example.com/?a=1",
    "admin:hunter2@example.com",
  ];
  for (const raw of carriers) {
    const error = await raised(
      () => normalizeSiteUrl(raw, {}, "--url"),
      JSON.stringify(raw),
    );
    const serialized = JSON.stringify({
      message: error.message,
      details: error.details,
    });
    assert.equal(serialized.includes("hunter2"), false, serialized);
    assert.equal(serialized.includes("admin:"), false, serialized);
  }
});

/* -------------------------------------------------------------------------- */
/* Version comparison                                                         */
/* -------------------------------------------------------------------------- */

test("SemVer precedence orders the plugin versions the matrix depends on", () => {
  // 29.
  assert.deepEqual(parseSemver("1.11.1"), {
    major: "1",
    minor: "11",
    patch: "1",
  });
  const ordered = ["1.11.0", "1.11.1", "1.12.0", "2.0.0"].map((value) => {
    const parsed = parseSemver(value);
    assert.ok(parsed, value);
    return parsed;
  });
  for (let index = 1; index < ordered.length; index += 1)
    assert.equal(
      compareSemver(ordered[index - 1], ordered[index]),
      -1,
      `${index}`,
    );

  // 30: the sleeper. A prerelease sorts BELOW the matching final release.
  const rc = parseSemver("1.11.1-rc.1");
  const final = parseSemver("1.11.1");
  assert.ok(rc && final);
  assert.equal(compareSemver(rc, final), -1);
  assert.equal(compareSemver(final, rc), 1);

  // 31: a two-component version is not SemVer.
  assert.equal(parseSemver("1.11"), undefined);
});

test("WordPress versions compare as dotted-numeric, not SemVer", () => {
  // 32.
  const dotted = (value) => {
    const parsed = parseDotted(value);
    assert.ok(parsed, value);
    return parsed;
  };
  assert.equal(compareDotted(dotted("6.9"), dotted("6.9.0")), 0);
  assert.equal(compareDotted(dotted("6.10"), dotted("6.9")), 1);
  assert.equal(compareDotted(dotted("6.8"), dotted("6.9")), -1);
  assert.equal(parseDotted("6.9-beta"), undefined);
});

/* -------------------------------------------------------------------------- */
/* Compatibility: documents that must pass                                    */
/* -------------------------------------------------------------------------- */

test("the canonical plugin document passes, read once, unauthenticated", async () => {
  // 33.
  const http = serving(protectedResourceDocument(SITE_URL));
  const block = await check(http);

  assert.deepEqual(block, compatibilityBlock());
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, METADATA_URL);

  const { init } = http.calls[0];
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "manual");
  // The boundary rule as an assertion: this request carries no credential and
  // no session, and exactly two headers.
  assert.deepEqual(Object.keys(init.headers).sort(), ["Accept", "User-Agent"]);
  assert.equal(init.headers["User-Agent"], `novamira-hq/${VERSION}`);
  for (const name of Object.keys(init.headers))
    assert.doesNotMatch(name, /authorization|cookie/i);
});

test("a subdirectory install is read under its own path, never the root", async () => {
  // 34: the append form. The insert form would land on a domain root this
  // WordPress does not own.
  const site = siteOf("https://example.com/blog");
  const expected = `https://example.com/blog${PROTECTED_RESOURCE_PATH}`;
  const http = scriptedFetch((url) =>
    url === expected
      ? response({
          body: protectedResourceDocument("https://example.com/blog"),
        })
      : response({ status: 404 }),
  );

  await check(http, site);
  assert.deepEqual(
    http.calls.map((call) => call.url),
    [expected],
  );
  assert.equal(metadataUrl(site.siteUrl), expected);
});

test("a plain-permalink resource passes: HQ checks the origin only", async () => {
  // 35: the deliberate narrowing. HQ cannot know the site's permalink style or
  // its rest_url_prefix filter, and a false "not ready" is worse than a miss.
  const http = serving(
    protectedResourceDocument(SITE_URL, {
      resource: "https://example.com/index.php?rest_route=/mcp/novamira-oauth",
    }),
  );
  assert.deepEqual(await check(http), compatibilityBlock());
});

test("additional members are ignored everywhere, at every depth", async () => {
  // 36: the tolerance rule. The plugin is free to add fields in 1.12.
  const http = serving(
    protectedResourceDocument(
      SITE_URL,
      {
        resource_documentation: "https://example.com/docs",
        scopes_supported: ["mcp", "legacy"],
        bearer_methods_supported: ["header", "body"],
      },
      {
        release_channel: "stable",
        features: {
          abilities_bearer_auth: true,
          agent_context: true,
          rest_skills: true,
          generalized_execution_shim: true,
          experimental_thing: false,
        },
      },
    ),
  );
  const block = await check(http);
  assert.equal(block.features.experimental_thing, false);
});

test("a newer plugin on a newer WordPress passes", async () => {
  // 37: there is no upper bound on either version.
  const http = serving(
    protectedResourceDocument(
      SITE_URL,
      {},
      { plugin_version: "2.0.0", wordpress_version: "6.10" },
    ),
  );
  const block = await check(http);
  assert.equal(block.plugin_version, "2.0.0");
  assert.equal(block.wordpress_version, "6.10");
});

test("a loopback site is read over plain HTTP", async () => {
  // 38.
  const site = siteOf("http://127.0.0.1:8080");
  const expected = `http://127.0.0.1:8080${PROTECTED_RESOURCE_PATH}`;
  const http = scriptedFetch((url) =>
    url === expected
      ? response({ body: protectedResourceDocument("http://127.0.0.1:8080") })
      : response({ status: 404 }),
  );
  assert.deepEqual(await check(http, site), compatibilityBlock());
  assert.equal(http.calls[0].url, expected);
});

test("a same-origin redirect is refused without a follow-up request", async () => {
  // 39.
  const target = `${SITE_URL}/wp-json/oauth-protected-resource`;
  const http = scriptedFetch(() => redirect(target));
  const error = await checkFails(http, SITE, "same-origin redirect");
  assert.equal(error.code, "server_unsupported");
  assert.equal(error.details.reason, "redirect");
  assert.match(error.message, /exactly one request/);
  assert.deepEqual(
    http.calls.map((call) => call.url),
    [METADATA_URL],
  );
});

/* -------------------------------------------------------------------------- */
/* Compatibility: reachability failures                                       */
/* -------------------------------------------------------------------------- */

test("a transport failure is reported after exactly one request", async () => {
  // 40.
  const http = scriptedFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  const error = await raised(
    () => checkSiteCompatibility(SITE, { fetch: http }),
    "transport failure",
  );

  assert.equal(error.code, "network_error");
  assert.equal(error.retryable, true);
  assert.equal(error.details.check, "metadata.reachable");
  assert.equal(http.calls.length, 1);
});

test("a 404 is server_unsupported after exactly one request", async () => {
  const http = scriptedFetch(() => response({ status: 404 }));
  const error = await checkFails(http, SITE, "404");

  assert.equal(error.code, "server_unsupported");
  assert.equal(error.retryable, false);
  assert.equal(error.details.check, "metadata.reachable");
  assert.equal(error.details.status, 404);
  assert.equal(http.calls.length, 1);
  assert.match(error.message, /HTTP 404/);
  assert.match(error.message, /not active|cache or CDN/);
});

test("a password-protected site is server_unsupported, never credential_invalid", async () => {
  // 42: a 401 here is about the WordPress site, not a provider API key. Sending
  // an operator to hunt a broken provider credential would be the wrong answer.
  for (const status of [401, 403]) {
    const http = scriptedFetch(() => response({ status }));
    const error = await checkFails(http, SITE, `HTTP ${status}`);
    assert.equal(error.code, "server_unsupported");
    assert.equal(error.details.check, "metadata.reachable");
    assert.equal(error.details.status, status);
    assert.match(error.message, /password-protected/);
    // Fatal on the first attempt: nothing about a 401 is transient.
    assert.equal(http.calls.length, 1);
  }
});

test("a 5xx is a retryable network_error after exactly one request", async () => {
  // 43.
  const http = scriptedFetch(() => response({ status: 500 }));
  const error = await checkFails(http, SITE, "HTTP 500");
  assert.equal(error.code, "network_error");
  assert.equal(error.retryable, true);
  assert.equal(error.details.check, "metadata.reachable");
  assert.equal(error.details.status, 500);
  assert.equal(http.calls.length, 1);
});

test("a themed page served with status 200 is metadata.document", async () => {
  // 45 and 47: an HTML body, and a body that is not JSON at all.
  for (const body of [
    "<!doctype html><html><body>Not found</body></html>",
    "definitely not json",
  ]) {
    const http = scriptedFetch(() => response({ body }));
    const error = await checkFails(
      http,
      SITE,
      JSON.stringify(body.slice(0, 20)),
    );
    assert.equal(error.code, "server_unsupported");
    assert.equal(error.details.check, "metadata.document");
    assert.match(error.message, /returned a page instead of JSON/);
    assert.equal(http.calls.length, 1);
  }
});

test("a JSON array is a document but not a metadata object", async () => {
  // 46.
  const http = scriptedFetch(() => response({ body: "[]" }));
  const error = await checkFails(http, SITE, "array body");
  assert.equal(error.code, "server_unsupported");
  assert.equal(error.details.check, "metadata.document");
  assert.match(error.message, /is not a JSON object/);
});

test("a cross-origin redirect is refused without being followed", async () => {
  // 48: the second host must never be contacted. A redirect the site CLI
  // refuses must not be one HQ silently follows.
  const http = scriptedFetch(() => redirect("https://evil.example/steal"));
  const error = await checkFails(http, SITE, "cross-origin redirect");

  assert.equal(error.code, "server_unsupported");
  assert.equal(error.details.check, "metadata.reachable");
  assert.equal(error.details.reason, "redirect");
  assert.match(error.message, /redirected instead of serving/);
  assert.equal(http.calls.length, 1);
  for (const call of http.calls)
    assert.match(call.url, /^https:\/\/example\.com\//);
});

test("a redirect is refused whether or not Location is usable", async () => {
  for (const [label, headers] of [
    ["absent", {}],
    ["unparseable", { location: "http://[nonsense" }],
  ]) {
    const http = scriptedFetch(() => response({ status: 302, headers }));
    const error = await checkFails(http, SITE, `Location ${label}`);
    assert.equal(error.code, "server_unsupported");
    assert.equal(error.details.check, "metadata.reachable");
    assert.equal(error.details.reason, "redirect");
    assert.equal(http.calls.length, 1);
  }
});

test("an oversized body is abandoned rather than buffered", async () => {
  // 50: the common failure is a themed 404 page of arbitrary size.
  const total = 300 * 1024;
  const chunk = 4 * 1024;
  const state = { pulled: 0, cancelled: false };
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, total - sent);
      sent += size;
      state.pulled += size;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const oversized = { ...response({ status: 200 }), body: stream };
  const http = scriptedFetch(() => oversized);

  const error = await checkFails(http, SITE, "oversized body");
  assert.equal(error.code, "server_unsupported");
  assert.equal(error.details.check, "metadata.reachable");
  assert.match(error.message, new RegExp(String(METADATA_MAX_BYTES)));
  // The read stopped early and released the connection.
  assert.equal(state.cancelled, true);
  assert.ok(state.pulled < total, `pulled ${state.pulled} of ${total}`);
  assert.ok(state.pulled <= METADATA_MAX_BYTES + 2 * chunk);
});

test("a declared content-length past the ceiling is refused unread", async () => {
  const state = { pulled: 0, cancelled: false };
  // `highWaterMark: 0` so the stream never pre-fills its queue: every recorded
  // pull is one the reader asked for, and there are meant to be none.
  const stream = new ReadableStream(
    {
      pull(controller) {
        state.pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const http = scriptedFetch(() => ({
    ...response({ status: 200, headers: { "content-length": "307200" } }),
    body: stream,
  }));

  const error = await checkFails(http, SITE, "declared oversize");
  assert.equal(error.code, "server_unsupported");
  assert.equal(error.details.check, "metadata.reachable");
  assert.equal(state.pulled, 0);
  // Every abandon path releases the connection: an undrained keep-alive body
  // would keep the process alive past the printed envelope.
  assert.equal(state.cancelled, true);
});

test("a body that fails mid-stream is a network_error after one request", async () => {
  // `fetch` resolves at the headers, so a slow shared host that flushes 200 and
  // then stalls or resets fails during the BODY read, not at the call. Left
  // unguarded that rejection escapes as a raw TypeError/DOMException and lands
  // as `internal_error` (exit 1) with no `details.check` and no retry — after
  // the plugin has already been installed and activated.
  const http = scriptedFetch(() => ({
    ...response({ status: 200 }),
    body: new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array([123]));
        controller.error(new TypeError("terminated"));
      },
    }),
  }));
  const error = await raised(
    () => checkSiteCompatibility(SITE, { fetch: http }),
    "body failure",
  );

  assert.equal(error.code, "network_error");
  assert.equal(error.retryable, true);
  assert.equal(error.details.check, "metadata.reachable");
  assert.equal(error.details.metadataUrl, METADATA_URL);
  assert.equal(http.calls.length, 1);
});

test("an attempt deadline that expires mid-body is a retryable timeout", async () => {
  // The same seam, aborted rather than reset: the taxonomy calls that `timeout`
  // and it is still inside the retry band.
  // The body stalls until the per-attempt signal fires and then rejects with
  // the signal's own reason — deterministically, with no wall-clock race.
  const calls = [];
  const http = async (url, init = {}) => {
    calls.push({ url, init });
    return {
      ...response({ status: 200 }),
      body: new ReadableStream({
        pull(controller) {
          return new Promise((resolve) => {
            // `AbortSignal.timeout`'s timer is unref'd, and a stalled body is
            // not a handle: with nothing else pending the loop drains before
            // the deadline fires and the runner reports the whole file as
            // "resolution is still pending". One ref'd timer holds it open
            // until the abort we are waiting for arrives.
            const holdOpen = setTimeout(() => {}, 60_000);
            init.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(holdOpen);
                controller.error(init.signal.reason);
                resolve();
              },
              { once: true },
            );
          });
        },
      }),
    };
  };
  const error = await raised(
    () => checkSiteCompatibility(SITE, { fetch: http, timeoutMs: 5 }),
    "mid-body abort",
  );

  assert.equal(calls.length, 1);
  assert.equal(error.code, "timeout");
  assert.equal(error.retryable, true);
  assert.equal(error.details.check, "metadata.reachable");
});

/* -------------------------------------------------------------------------- */
/* Plugin source network policy                                                */
/* -------------------------------------------------------------------------- */

test("novamira-latest resolves locally to the sole canonical download URL", () => {
  assert.equal(
    resolvePluginSource(NOVAMIRA_LATEST_SOURCE_ALIAS),
    NOVAMIRA_DOWNLOAD_URL,
  );
  assert.equal(
    resolvePluginSource(NOVAMIRA_DOWNLOAD_URL),
    NOVAMIRA_DOWNLOAD_URL,
  );
  assert.equal(resolvePluginSource("another-plugin"), "another-plugin");
});

test("remote plugin HEAD validation is bounded and refuses redirects", async () => {
  const source =
    "https://download:source-password@downloads.example/novamira.zip?X-Amz-%53ignature=signed-source";
  const http = scriptedFetch(() =>
    redirect("https://cdn.example/novamira.zip"),
  );
  const error = await raised(
    () => validateRemotePluginSource(source, http),
    "source redirect",
  );

  assert.equal(error.code, "network_error");
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].init.method, "HEAD");
  assert.equal(http.calls[0].init.redirect, "manual");
  assert.ok(http.calls[0].init.signal instanceof AbortSignal);
  assert.equal(http.calls[0].url, source);
  assert.equal(error.message.includes("source-password"), false);
  assert.equal(error.message.includes("signed-source"), false);
});

test("the canonical download endpoint may reject HEAD without failing validation", async () => {
  const http = scriptedFetch(() => response({ status: 405 }));
  await validateRemotePluginSource(NOVAMIRA_DOWNLOAD_URL, http);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, NOVAMIRA_DOWNLOAD_URL);
  assert.equal(http.calls[0].init.method, "HEAD");
});

/* -------------------------------------------------------------------------- */
/* Compatibility: document-shape failures                                     */
/* -------------------------------------------------------------------------- */

/** Serve a document built from `overrides` and return the raised error. */
async function documentFails(overrides, block, label) {
  const http = serving(protectedResourceDocument(SITE_URL, overrides, block));
  return checkFails(http, SITE, label);
}

test("the advertised resource must belong to the site", async () => {
  // 51 and 52.
  const other = await documentFails(
    {
      resource:
        "https://admin:hunter2@other.example/wp-json/mcp/novamira-oauth?sig=signed-resource",
    },
    {},
    "cross-origin resource",
  );
  assert.equal(other.details.check, "metadata.resource");
  assert.match(other.message, /does not belong to https:\/\/example\.com/);
  assert.equal(other.message.includes("hunter2"), false);
  assert.equal(other.message.includes("signed-resource"), false);
  assert.equal(JSON.stringify(other.details).includes("hunter2"), false);

  const notAString = await documentFails({ resource: 42 }, {}, "resource 42");
  assert.equal(notAString.details.check, "metadata.resource");
});

test("exactly one authorization server, and it must be the site itself", async () => {
  // 53, 54, 55.
  const cases = [
    [[], "empty"],
    [["https://example.com", "https://other.example"], "two entries"],
    [["https://other.example"], "another site"],
  ];
  for (const [authorization_servers, label] of cases) {
    const error = await documentFails(
      { authorization_servers },
      {},
      `authorization_servers ${label}`,
    );
    assert.equal(error.code, "server_unsupported");
    assert.equal(error.details.check, "metadata.authorization_server");
  }
});

test("bearer-header authentication and the mcp scope must be advertised", async () => {
  // 56 and 57.
  const bearer = await documentFails(
    { bearer_methods_supported: ["body"] },
    {},
    "bearer methods",
  );
  assert.equal(bearer.details.check, "metadata.bearer_methods");

  const scopes = await documentFails(
    { scopes_supported: ["abilities:read"] },
    {},
    "scopes",
  );
  assert.equal(scopes.details.check, "metadata.scopes");
  assert.match(scopes.message, /"mcp"/);
});

test("a document with no novamira block names the pre-1.11.1 case", async () => {
  // 58.
  const http = serving({
    resource: `${SITE_URL}/wp-json/mcp/novamira-oauth`,
    authorization_servers: [SITE_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  });
  const error = await checkFails(http, SITE, "no novamira block");
  assert.equal(error.code, "server_unsupported");
  assert.equal(error.details.check, "compat.block");
  assert.match(
    error.message,
    new RegExp(`shipped since Novamira ${MINIMUM_NOVAMIRA_VERSION}`),
  );
});

test("every required compatibility field is type-checked", async () => {
  // 59, 60, 61: a stringly-typed contract version, a non-integer one, and a
  // feature map whose values are not booleans.
  const cases = [
    [{ rest_api_version: "1" }, "rest_api_version"],
    [{ rest_api_version: 1.5 }, "rest_api_version"],
    [{ plugin_version: 1111 }, "plugin_version"],
    [{ wordpress_version: 6.9 }, "wordpress_version"],
    [{ minimum_wordpress_version: null }, "minimum_wordpress_version"],
    [{ features: ["abilities_bearer_auth"] }, "features"],
    [
      {
        features: {
          abilities_bearer_auth: "yes",
          agent_context: true,
          rest_skills: true,
          generalized_execution_shim: true,
        },
      },
      "features",
    ],
  ];
  for (const [block, field] of cases) {
    const error = await documentFails({}, block, `block ${field}`);
    assert.equal(error.code, "server_unsupported");
    assert.equal(error.details.check, "compat.block");
    assert.equal(error.details.field, field);
    assert.match(error.message, /incomplete or invalid/);
  }

  // 62: features missing entirely.
  const document = protectedResourceDocument(SITE_URL);
  delete document.novamira.features;
  const missing = await checkFails(serving(document), SITE, "features absent");
  assert.equal(missing.details.check, "compat.block");
  assert.equal(missing.details.field, "features");
});

/* -------------------------------------------------------------------------- */
/* Compatibility: the matrix                                                  */
/* -------------------------------------------------------------------------- */

test("WordPress must be 6.9 or newer, and must be comparable", async () => {
  // 63 and 64.
  const old = await documentFails({}, { wordpress_version: "6.8" }, "WP 6.8");
  assert.equal(old.details.check, "compat.wordpress");
  assert.match(
    old.message,
    new RegExp(`WordPress ${MINIMUM_WORDPRESS_VERSION} or newer`),
  );
  assert.equal(old.details.wordpressVersion, "6.8");

  const garbage = await documentFails(
    {},
    { wordpress_version: "six-nine" },
    "WP six-nine",
  );
  assert.equal(garbage.details.check, "compat.wordpress");
  assert.match(garbage.message, /not a version number HQ can compare/);
});

test("metadata that contradicts itself is compat.wordpress_consistency", async () => {
  // 65.
  const error = await documentFails(
    {},
    { wordpress_version: "6.9", minimum_wordpress_version: "7.0" },
    "inconsistent minimum",
  );
  assert.equal(error.details.check, "compat.wordpress_consistency");
  assert.match(error.message, /contradicts itself/);
});

test("the plugin must be 1.11.1 or newer, prereleases included", async () => {
  // 66.
  const old = await documentFails({}, { plugin_version: "1.11.0" }, "1.11.0");
  assert.equal(old.details.check, "compat.plugin");
  assert.match(
    old.message,
    new RegExp(`requires ${MINIMUM_NOVAMIRA_VERSION} or newer`),
  );

  // 67: the sleeper. A naive string or numeric compare passes `1.11.1-rc.1`,
  // and the site then fails `novamira auth login`.
  const prerelease = await documentFails(
    {},
    { plugin_version: "1.11.1-rc.1" },
    "1.11.1-rc.1",
  );
  assert.equal(prerelease.details.check, "compat.plugin");
  assert.match(prerelease.message, /a prerelease of 1\.11\.1/);

  // 68.
  const invalid = await documentFails({}, { plugin_version: "1.11" }, "1.11");
  assert.equal(invalid.details.check, "compat.plugin");
  assert.match(invalid.message, /not a semantic version/);
});

test("the REST contract must be exactly 1", async () => {
  // 69.
  const error = await documentFails({}, { rest_api_version: 2 }, "contract 2");
  assert.equal(error.details.check, "compat.rest_contract");
  assert.equal(error.details.restApiVersion, 2);
});

test("a required feature that is false or absent is compat.features", async () => {
  // 70: false.
  const disabled = await documentFails(
    {},
    {
      features: {
        abilities_bearer_auth: true,
        agent_context: true,
        rest_skills: false,
        generalized_execution_shim: true,
      },
    },
    "rest_skills false",
  );
  assert.equal(disabled.details.check, "compat.features");
  assert.equal(disabled.details.feature, "rest_skills");
  assert.match(disabled.message, /"rest_skills"/);

  // 71: absent behaves identically to false.
  const absent = await documentFails(
    {},
    {
      features: {
        abilities_bearer_auth: true,
        agent_context: true,
        rest_skills: true,
      },
    },
    "generalized_execution_shim absent",
  );
  assert.equal(absent.details.check, "compat.features");
  assert.equal(absent.details.feature, "generalized_execution_shim");
  assert.match(absent.message, /"generalized_execution_shim"/);
});

test("the first failure in check order is the one reported", async () => {
  // 72: a document that fails both metadata.scopes and compat.wordpress names
  // the more fundamental problem.
  const error = await documentFails(
    { scopes_supported: ["abilities:read"] },
    { wordpress_version: "6.8" },
    "scopes before wordpress",
  );
  assert.equal(error.details.check, "metadata.scopes");
});

test("every reported check id is one of the frozen handles", async () => {
  const seen = new Set();
  const failures = [
    [{ resource: "https://other.example/x" }, {}],
    [{ authorization_servers: [] }, {}],
    [{ bearer_methods_supported: [] }, {}],
    [{ scopes_supported: [] }, {}],
    [{}, { wordpress_version: "6.8" }],
    [{}, { minimum_wordpress_version: "7.0" }],
    [{}, { plugin_version: "1.0.0" }],
    [{}, { rest_api_version: 3 }],
    [{}, { features: {} }],
  ];
  for (const [overrides, block] of failures) {
    const error = await documentFails(overrides, block, "check id");
    seen.add(error.details.check);
  }
  for (const check of seen)
    assert.ok(COMPATIBILITY_CHECKS.includes(check), `unknown check ${check}`);
});

test("the standalone validators are usable without a fetch", () => {
  // The service's units, called the way Phase 6 may call them.
  const block = readCompatibilityBlock(compatibilityBlock());
  assert.equal(block.plugin_version, MINIMUM_NOVAMIRA_VERSION);
  assertCompatible(block);

  for (const feature of REQUIRED_FEATURES)
    assert.equal(block.features[feature], true);
});

/* -------------------------------------------------------------------------- */
/* The handoff                                                                */
/* -------------------------------------------------------------------------- */

function setupResult(overrides = {}) {
  return {
    hostingProfile: "kinsta",
    envId: "env-abc123",
    siteUrl: SITE_URL,
    plugin: {
      slug: "novamira",
      source: "https://example.invalid/novamira-1.11.1.zip",
      version: "1.11.1",
      activated: true,
      networkActivated: false,
    },
    aiAbilities: { enabled: true, domain: "example.com" },
    compatibility: {
      status: "supported",
      metadataUrl: METADATA_URL,
      pluginVersion: "1.11.1",
      restApiVersion: 1,
      wordpressVersion: "6.9",
      minimumWordpressVersion: "6.9",
      features: compatibilityBlock().features,
    },
    ready: true,
    handoff: connectHandoff(SITE_URL),
    warnings: [],
    ...overrides,
  };
}

/** Every property name in `value`, at every depth. */
function keysDeep(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, into);
    return into;
  }
  if (value === null || typeof value !== "object") return into;
  for (const [key, item] of Object.entries(value)) {
    into.add(key);
    keysDeep(item, into);
  }
  return into;
}

test("the handoff is the site CLI's login command and nothing else", () => {
  // 73 and 74.
  const handoff = connectHandoff(SITE_URL);
  assert.deepEqual(handoff.command, [
    SITE_CLI_EXECUTABLE,
    "auth",
    "login",
    SITE_URL,
  ]);
  assert.equal(handoff.commandLine, `novamira auth login ${SITE_URL}`);
  // Profile naming belongs to the site CLI; opening a browser is the
  // operator's call. Neither flag may creep back in.
  assert.equal(handoff.command.includes("--name"), false);
  assert.equal(handoff.command.includes("--no-open"), false);
});

test("the boundary rule holds in the emitted data: no site credential, ever", () => {
  // 75. Go returned `site_profile`, `username`, `credential`, `rest_url` and
  // `config_path`; HQ writes no credential and stores no profile, so none of
  // those names may appear at any depth.
  const data = handoffData(setupResult());
  const keys = keysDeep(data);
  for (const forbidden of [
    "username",
    "credential",
    "site_profile",
    "rest_url",
    "config_path",
    "application_password",
    "app_password",
    "password",
    "token",
  ])
    assert.equal(
      keys.has(forbidden),
      false,
      `data must not carry ${forbidden}`,
    );

  const serialized = JSON.stringify(data);
  for (const forbidden of ["application-password", "site_profile", "rest_url"])
    assert.doesNotMatch(serialized, new RegExp(forbidden, "i"));

  assert.equal(data.ready, true);
  assert.deepEqual(data.next_step, {
    tool: "novamira",
    command: ["novamira", "auth", "login", SITE_URL],
    command_line: `novamira auth login ${SITE_URL}`,
  });
  assert.equal(data.compatibility.status, "supported");
  assert.equal(data.plugin.network_activated, false);

  const secretSource = handoffData(
    setupResult({
      plugin: {
        ...setupResult().plugin,
        source:
          "https://download:source-password@example.test/novamira.zip?sig=signed-source",
      },
    }),
  );
  const secretSourceJson = JSON.stringify(secretSource);
  assert.equal(secretSourceJson.includes("source-password"), false);
  assert.equal(secretSourceJson.includes("signed-source"), false);
  assert.match(secretSourceJson, /\[REDACTED\]/);
});

test("a skipped compatibility check nulls every derived field", () => {
  // 76.
  const result = setupResult({
    plugin: { ...setupResult().plugin, version: null },
    compatibility: {
      status: "skipped",
      metadataUrl: null,
      pluginVersion: null,
      restApiVersion: null,
      wordpressVersion: null,
      minimumWordpressVersion: null,
      features: null,
    },
    ready: null,
  });
  const data = handoffData(result);

  assert.equal(data.ready, null);
  assert.equal(data.plugin.version, null);
  assert.deepEqual(data.compatibility, {
    status: "skipped",
    metadata_url: null,
    plugin_version: null,
    rest_api_version: null,
    wordpress_version: null,
    minimum_wordpress_version: null,
    features: null,
  });

  // The human block says so out loud rather than implying readiness.
  assert.equal(
    handoffHuman(result),
    [
      `Novamira installed and activated on ${SITE_URL}`,
      "  Compatibility not checked (--no-compat-check).",
      `  Connect your agent:  novamira auth login ${SITE_URL}`,
    ].join("\n"),
  );
});

test("the ready human block names the verified plugin version", () => {
  assert.equal(
    handoffHuman(setupResult()),
    [
      `Novamira 1.11.1 installed and activated on ${SITE_URL}`,
      `  Connect your agent:  novamira auth login ${SITE_URL}`,
    ].join("\n"),
  );
});
