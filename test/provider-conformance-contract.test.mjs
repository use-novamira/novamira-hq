// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The invariants every provider adapter must hold, asserted once for all of
 * them rather than eight times in eight files.
 *
 * Each adapter has its own suite pinning its own endpoint table, and that is
 * the right place for what is specific to a provider. What those suites cannot
 * do is notice an adapter that never learned a rule: a ninth provider can be
 * merged with a perfectly green file of its own while quietly publishing a
 * capability HQ does not allow, putting its API key in a query string, or
 * throwing a bare `TypeError` where the CLI expects a classified failure. The
 * per-provider suites all pass; nothing fails; the rule is simply absent.
 *
 * So this suite is parametric over `PROVIDER_KINDS`. Adding a provider without
 * adding it here is not possible — the loop finds it through the registry — and
 * a provider that breaks a shared rule fails here even if its own suite is
 * untouched.
 *
 * Nothing here touches the network. Every client is built with an injected
 * `fetch` that records the request and answers locally, so the sweep exercises
 * the adapters' own code and never a provider's.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { UnixFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import {
  PROVIDER_KINDS,
  defaultCredentialEnv,
  envCredential,
} from "../dist/config/schema.js";
import { CliError } from "../dist/errors.js";
import {
  ACTION_REQUEST_KINDS,
  READ_REQUEST_KINDS,
} from "../dist/hosting/client.js";
import { isHqPublicCapability } from "../dist/hosting/capabilities.js";
import { createHostingClientFactory } from "../dist/hosting/factory.js";
import { PROVIDER_REGISTRY } from "../dist/hosting/providers/index.js";

/**
 * Obvious fakes, and distinctive enough that finding either one inside a URL,
 * a message or a serialized result is proof of a leak rather than a
 * coincidence.
 */
const SECRET = "conformance-fake-credential-8f3a1c-not-a-real-secret";
const IDENTITY = "conformance-fake-identity-4b7e2d";

/**
 * The identifiers the sweep uses.
 *
 * They are numeric strings on purpose. Several providers key their resources by
 * integer and reject anything else as a usage error *before* building a
 * request, so a decorative `"env-1"` would have most of the sweep stop at the
 * front door and never reach the endpoint table it exists to exercise. `"1"` is
 * accepted as an id by every provider and is still obviously not real.
 */
const ID = "1";

/** The request shape for each read kind: the minimum each one needs. */
const READ_REQUESTS = {
  capabilities: { kind: "capabilities" },
  regions: { kind: "regions" },
  activity: { kind: "activity" },
  "site-domains": { kind: "site-domains", envId: ID },
  "site-domain-verification": {
    kind: "site-domain-verification",
    siteDomainId: ID,
  },
  "dns-domains": { kind: "dns-domains" },
  "dns-records": { kind: "dns-records", domainId: ID },
  backups: { kind: "backups", envId: ID },
  "downloadable-backups": { kind: "downloadable-backups", envId: ID },
  logs: { kind: "logs", envId: ID, fileName: "error.log", lines: 10 },
  redirects: { kind: "redirects", envId: ID },
  "denied-ips": { kind: "denied-ips", envId: ID },
  plugins: { kind: "plugins", envId: ID },
  themes: { kind: "themes", envId: ID },
  "company-plugins": { kind: "company-plugins" },
  "company-themes": { kind: "company-themes" },
  "analytics-usage": {
    kind: "analytics-usage",
    siteId: ID,
    metric: "bandwidth",
  },
  "analytics-env": { kind: "analytics-env", envId: ID, metric: "visits" },
  "file-list": { kind: "file-list", envId: ID },
};

/**
 * The same for actions, minus `setup-novamira`: provisioning drives WP-CLI and
 * the compatibility preflight rather than one provider endpoint, and
 * `test/provisioning-contract.test.mjs` owns it.
 */
const ACTION_REQUESTS = {
  "create-site": { kind: "create-site", mode: "wordpress", body: {} },
  "create-environment": {
    kind: "create-environment",
    siteId: ID,
    mode: "wordpress",
    body: {},
  },
  "push-environment": { kind: "push-environment", siteId: ID, body: {} },
  "clear-cache": { kind: "clear-cache", cache: "site", body: {} },
  "restart-php": { kind: "restart-php", envId: ID },
  "set-php-version": { kind: "set-php-version", body: { version: "8.3" } },
  "add-domain": { kind: "add-domain", envId: ID, body: {} },
  "change-primary-domain": {
    kind: "change-primary-domain",
    envId: ID,
    body: {},
  },
  "create-backup": { kind: "create-backup", envId: ID, body: {} },
  "restore-backup": { kind: "restore-backup", targetEnvId: ID, body: {} },
  "update-plugin": { kind: "update-plugin", envId: ID, body: {} },
  "bulk-update-plugins": {
    kind: "bulk-update-plugins",
    envId: ID,
    body: {},
  },
  "update-theme": { kind: "update-theme", envId: ID, body: {} },
  "bulk-update-themes": { kind: "bulk-update-themes", envId: ID, body: {} },
  "run-wp-cli": { kind: "run-wp-cli", envId: ID, body: {} },
  "set-denied-ips": { kind: "set-denied-ips", body: {} },
  "apply-redirects": { kind: "apply-redirects", envId: ID, body: {} },
};

const SWEPT_ACTION_KINDS = ACTION_REQUEST_KINDS.filter(
  (kind) => kind !== "setup-novamira",
);

test("the request tables here cover the whole vocabulary", () => {
  // Without this, adding a request kind would silently shrink the sweep.
  assert.deepEqual(
    Object.keys(READ_REQUESTS).sort(),
    [...READ_REQUEST_KINDS].sort(),
  );
  assert.deepEqual(
    Object.keys(ACTION_REQUESTS).sort(),
    [...SWEPT_ACTION_KINDS].sort(),
  );
});

test("no destructive verb exists in the action vocabulary at all", () => {
  // The safety exclusions are enforced by the type system rather than by a
  // runtime guard, which only works while the vocabulary stays free of them.
  for (const forbidden of [
    "delete",
    "destroy",
    "remove",
    "reset",
    "purge",
    "ssh",
    "sftp",
  ]) {
    for (const kind of ACTION_REQUEST_KINDS) {
      assert.ok(
        !kind.includes(forbidden),
        `"${kind}" names a ${forbidden} operation; HQ implements none`,
      );
    }
  }
  // DNS is readable and never writable.
  assert.ok(READ_REQUEST_KINDS.includes("dns-records"));
  assert.ok(!ACTION_REQUEST_KINDS.some((kind) => kind.startsWith("dns-")));
});

for (const provider of PROVIDER_KINDS) {
  test(`${provider} publishes only capabilities HQ allows`, async () => {
    await withClient(provider, async (client) => {
      const capabilities = await client.read({ kind: "capabilities" });
      assert.ok(Array.isArray(capabilities) && capabilities.length > 0);

      const names = capabilities.map((capability) => capability.name);
      assert.equal(
        new Set(names).size,
        names.length,
        `${provider} lists a capability twice`,
      );
      for (const name of names) {
        assert.ok(
          isHqPublicCapability(name),
          `${provider} publishes "${name}", which is not in HQ's public capability vocabulary`,
        );
      }
    });
  });

  test(`${provider} classifies every failure and leaks no credential`, async () => {
    const seen = [];
    await withClient(
      provider,
      async (client) => {
        for (const kind of READ_REQUEST_KINDS) {
          await sweep(provider, "read", kind, () =>
            client.read(READ_REQUESTS[kind]),
          );
        }
        for (const kind of SWEPT_ACTION_KINDS) {
          await sweep(provider, "action", kind, () =>
            client.action(ACTION_REQUESTS[kind]),
          );
        }
      },
      seen,
    );

    // An adapter that rejected every request locally would pass the URL check
    // below without ever having built a URL. Prove the sweep got that far.
    assert.ok(
      seen.length > 0,
      `${provider} issued no HTTP request across the whole vocabulary; the sweep never reached its endpoint table`,
    );

    // The credential authenticates in a header. A provider that puts it in a
    // path or a query string writes it into every proxy log between here and
    // the API, and into HQ's own diagnostics.
    for (const url of seen) {
      assert.ok(
        !url.includes(SECRET),
        `${provider} put the credential in a request URL: ${url.replace(SECRET, "<credential>")}`,
      );
    }
  });
}

/**
 * Run one request and assert what must hold however it ends.
 *
 * A mapped request will usually fail against the canned response — that is
 * expected and uninteresting. What matters is that failing is *classified*: the
 * CLI turns a `CliError` into an exit code and an envelope, and turns anything
 * else into an internal error with no useful code. And that neither the failure
 * nor the success carries the credential.
 */
async function sweep(provider, surface, kind, invoke) {
  let result;
  try {
    result = await invoke();
  } catch (error) {
    assert.ok(
      error instanceof CliError,
      `${provider}.${surface}("${kind}") threw ${error?.constructor?.name ?? typeof error}: ${error?.message}`,
    );
    assert.ok(
      typeof error.code === "string" && error.code.length > 0,
      `${provider}.${surface}("${kind}") threw an unclassified CliError`,
    );
    assertNoSecret(provider, `${surface} "${kind}" error`, {
      message: error.message,
      details: error.details,
    });
    return;
  }
  assertNoSecret(provider, `${surface} "${kind}" result`, result);
}

function assertNoSecret(provider, where, value) {
  const rendered = JSON.stringify(value, replacer) ?? "";
  assert.ok(
    !rendered.includes(SECRET),
    `${provider} leaked the credential into its ${where}`,
  );
}

/** `JSON.stringify` drops `Error` fields; this keeps them visible. */
function replacer(_key, value) {
  if (value instanceof Error) {
    return { message: value.message, ...value };
  }
  return value;
}

/**
 * Build a real client for `provider` from a real profile in a real config
 * store, with the network replaced.
 */
async function withClient(provider, body, seen = []) {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-conformance-"));
  try {
    const paths = platformPaths({ NOVAMIRA_HQ_HOME: root });
    const security = new UnixFileSecurity();
    const store = new ConfigStore(
      paths.configFile,
      new ProfileLockManager(paths.stateDir, security),
      security,
    );
    await store.upsertHostingProfile(provider, {
      provider,
      credential: envCredential(defaultCredentialEnv(provider)),
      // Doubles as the identity half for the providers that require one.
      companyId: IDENTITY,
    });

    const factory = createHostingClientFactory({
      store,
      registry: PROVIDER_REGISTRY,
      env: Object.fromEntries(
        PROVIDER_KINDS.map((kind) => [defaultCredentialEnv(kind), SECRET]),
      ),
      http: {
        fetch: recordingFetch(seen),
        // One attempt: a retry band would multiply the sweep by the backoff
        // schedule for no extra assertion.
        retry: { attempts: 1 },
        timeoutMs: 2_000,
      },
    });

    await body(await factory.clientFromProfile(provider));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A `fetch` that answers every request locally and records where it was sent.
 *
 * The body is deliberately accommodating — it reads as an OAuth token response,
 * an empty collection and an empty object at once — so that adapters which
 * exchange a token before their first call get past that step and reach the
 * code this sweep is about.
 */
function recordingFetch(seen) {
  return async (input) => {
    const url =
      typeof input === "string" ? input : (input?.url ?? String(input));
    seen.push(url);
    return new Response(
      JSON.stringify({
        access_token: "conformance-fake-token",
        token_type: "Bearer",
        expires_in: 3600,
        data: [],
        results: [],
        sites: [],
        environments: [],
        backups: [],
        domains: [],
        plugins: [],
        themes: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}
