// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CliError } from "../dist/errors.js";
import { UnixFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import {
  PROVIDER_KINDS,
  defaultApiBaseUrl,
  envCredential,
} from "../dist/config/schema.js";
import {
  ACTION_REQUEST_KINDS,
  ACTION_REQUEST_KINDS_ARE_EXHAUSTIVE,
  READ_REQUEST_KINDS,
  READ_REQUEST_KINDS_ARE_EXHAUSTIVE,
  assertNever,
  isActionRequestKind,
  isReadRequestKind,
  unsupportedActionRequest,
  unsupportedOperation,
  unsupportedReadRequest,
  wpCliResultsObservable,
  wpCliWithoutBinary,
} from "../dist/hosting/client.js";
import {
  createHostingClientFactory,
  registeredProviders,
} from "../dist/hosting/factory.js";
import {
  operationFailure,
  waitForOperationStatus,
} from "../dist/hosting/operations.js";
import { renderAction, renderOperation } from "../dist/cli/print.js";
import {
  providerCapabilities,
  providerLabel,
  serializeActionResult,
  serializeHostingSite,
  serializeProviderValidation,
} from "../dist/hosting/types.js";

// HQ's complete public provider-read vocabulary.
const EXPECTED_READ_KINDS = [
  "capabilities",
  "regions",
  "activity",
  "site-domains",
  "site-domain-verification",
  "dns-domains",
  "dns-records",
  "backups",
  "downloadable-backups",
  "logs",
  "redirects",
  "denied-ips",
  "plugins",
  "themes",
  "company-plugins",
  "company-themes",
  "analytics-usage",
  "analytics-env",
  "file-list",
];

// HQ's complete public provider-action vocabulary.
const EXPECTED_ACTION_KINDS = [
  "setup-novamira",
  "create-site",
  "create-environment",
  "push-environment",
  "clear-cache",
  "restart-php",
  "set-php-version",
  "add-domain",
  "change-primary-domain",
  "create-backup",
  "restore-backup",
  "update-plugin",
  "bulk-update-plugins",
  "update-theme",
  "bulk-update-themes",
  "run-wp-cli",
  "set-denied-ips",
  "apply-redirects",
];

const PROFILE = {
  provider: "kinsta",
  credential: envCredential("KINSTA_API_KEY"),
  companyId: "company-1234",
};

async function isolatedStore() {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-hosting-"));
  const paths = platformPaths({ NOVAMIRA_HQ_HOME: root }, "linux", root);
  const security = new UnixFileSecurity();
  const locks = new ProfileLockManager(paths.stateDir, security);
  const store = new ConfigStore(paths.configFile, locks, security);
  await store.upsertHostingProfile("production", PROFILE);
  return { root, store };
}

/**
 * A dispatcher shaped exactly like a provider's: one explicit case per kind and
 * a `default` that must never be reached. `assertNever` is what the TypeScript
 * providers use for that default, so reaching it is an `internal_error`.
 */
function dispatchRead(request) {
  switch (request.kind) {
    case "capabilities":
    case "regions":
    case "activity":
    case "site-domains":
    case "site-domain-verification":
    case "dns-domains":
    case "dns-records":
    case "backups":
    case "downloadable-backups":
    case "logs":
    case "redirects":
    case "denied-ips":
    case "plugins":
    case "themes":
    case "company-plugins":
    case "company-themes":
    case "analytics-usage":
    case "analytics-env":
    case "file-list":
      return request.kind;
    default:
      return assertNever(request);
  }
}

function dispatchAction(request) {
  switch (request.kind) {
    case "setup-novamira":
    case "create-site":
    case "create-environment":
    case "push-environment":
    case "clear-cache":
    case "restart-php":
    case "set-php-version":
    case "add-domain":
    case "change-primary-domain":
    case "create-backup":
    case "restore-backup":
    case "update-plugin":
    case "bulk-update-plugins":
    case "update-theme":
    case "bulk-update-themes":
    case "run-wp-cli":
    case "set-denied-ips":
    case "apply-redirects":
      return request.kind;
    default:
      return assertNever(request);
  }
}

test("every request kind is dispatchable and no dispatch falls through", () => {
  assert.deepEqual([...READ_REQUEST_KINDS], EXPECTED_READ_KINDS);
  assert.deepEqual([...ACTION_REQUEST_KINDS], EXPECTED_ACTION_KINDS);
  assert.equal(READ_REQUEST_KINDS_ARE_EXHAUSTIVE, true);
  assert.equal(ACTION_REQUEST_KINDS_ARE_EXHAUSTIVE, true);

  // No duplicates, and the two kind spaces are disjoint, so one string always
  // identifies exactly one request.
  assert.equal(new Set(READ_REQUEST_KINDS).size, READ_REQUEST_KINDS.length);
  assert.equal(new Set(ACTION_REQUEST_KINDS).size, ACTION_REQUEST_KINDS.length);
  assert.equal(
    new Set([...READ_REQUEST_KINDS, ...ACTION_REQUEST_KINDS]).size,
    READ_REQUEST_KINDS.length + ACTION_REQUEST_KINDS.length,
  );

  for (const kind of READ_REQUEST_KINDS) {
    assert.equal(dispatchRead({ kind }), kind);
    assert.equal(isReadRequestKind(kind), true);
    assert.equal(isActionRequestKind(kind), false);
  }
  for (const kind of ACTION_REQUEST_KINDS) {
    assert.equal(dispatchAction({ kind }), kind);
    assert.equal(isActionRequestKind(kind), true);
    assert.equal(isReadRequestKind(kind), false);
  }

  // The `default` arm exists and fails loudly rather than silently succeeding.
  assert.throws(() => dispatchRead({ kind: "not-a-read" }), {
    code: "internal_error",
  });
  assert.throws(() => dispatchAction({ kind: "not-an-action" }), {
    code: "internal_error",
  });
  assert.equal(isReadRequestKind("not-a-read"), false);
  assert.equal(isActionRequestKind(42), false);
});

test("deliberately unmapped operations report provider_unsupported", () => {
  for (const build of [
    () => unsupportedReadRequest("hostinger", { kind: "analytics-env" }),
    () => unsupportedActionRequest("hostinger", { kind: "run-wp-cli" }),
    () => unsupportedOperation("hostinger", "operation status"),
  ]) {
    const error = build();
    assert.equal(error.code, "provider_unsupported");
    assert.match(error.message, /^Hostinger does not support /);
    assert.equal(error.details.provider, "hostinger");
  }
  assert.equal(providerLabel("wpengine"), "WP Engine");
  assert.equal(providerLabel("rocketnet"), "Rocket.net");
});

test("ClientFromProfile refuses a provider with no registered client", async () => {
  const state = await isolatedStore();
  try {
    const factory = createHostingClientFactory({
      store: state.store,
      registry: {},
      env: { KINSTA_API_KEY: "placeholder-not-a-secret" },
    });
    assert.deepEqual(registeredProviders(factory.registry), []);
    await assert.rejects(factory.clientFromProfile("production"), (error) => {
      assert.equal(error.code, "provider_unsupported");
      assert.equal(error.details.provider, "kinsta");
      assert.deepEqual(error.details.registered, []);
      return true;
    });

    // A missing profile is a different failure entirely.
    await assert.rejects(factory.clientFromProfile("absent"), {
      code: "profile_not_found",
    });

    // A provider kind that is not in the taxonomy at all.
    await assert.rejects(
      factory.clientFromEntry({
        name: "legacy",
        profile: { ...PROFILE, provider: "flywheel" },
      }),
      (error) => {
        assert.equal(error.code, "provider_unsupported");
        assert.deepEqual(error.details.providers, [...PROVIDER_KINDS]);
        return true;
      },
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a registered provider receives a provider-neutral, secret-safe context", async () => {
  const state = await isolatedStore();
  try {
    let seen;
    const factory = createHostingClientFactory({
      store: state.store,
      registry: {
        kinsta: (context) => {
          seen = context;
          return {
            provider: context.provider,
            validate: async () => ({
              provider: context.provider,
              status: "ok",
              companyId: context.companyId ?? null,
              credential: context.credentialSource,
            }),
            listSites: async () => [],
            getSite: async () => {
              throw new Error("unused");
            },
            listEnvironments: async () => [],
            read: async () => null,
            action: async () => {
              throw new Error("unused");
            },
            operationStatus: async () => {
              throw new Error("unused");
            },
          };
        },
      },
      env: { KINSTA_API_KEY: "placeholder-not-a-secret" },
    });
    assert.deepEqual(registeredProviders(factory.registry), ["kinsta"]);

    const client = await factory.clientFromProfile("production");
    assert.equal(client.provider, "kinsta");
    assert.equal(seen.profileName, "production");
    assert.equal(seen.providerLabel, "Kinsta");
    assert.equal(seen.baseUrl, defaultApiBaseUrl("kinsta"));
    assert.equal(seen.credentialSource, "env:KINSTA_API_KEY");
    assert.equal(seen.companyId, "company-1234");
    assert.equal(seen.identity, "company-1234");
    assert.equal(seen.secret.reveal(), "placeholder-not-a-secret");
    assert.equal(`${seen.secret}`, "[REDACTED]");
    assert.equal(typeof seen.createHttpClient, "function");
    assert.equal(seen.createHttpClient().baseUrl, defaultApiBaseUrl("kinsta"));

    // The context never exposes a raw secret to `JSON.stringify`.
    assert.equal(
      JSON.stringify({
        secret: seen.secret,
        credentialSource: seen.credentialSource,
      }).includes("placeholder-not-a-secret"),
      false,
    );

    assert.deepEqual(serializeProviderValidation(await client.validate()), {
      provider: "kinsta",
      status: "ok",
      company_id: "company-1234",
      credential: "env:KINSTA_API_KEY",
    });

    // A profile whose credential env var is unset fails before any network use.
    const unset = createHostingClientFactory({
      store: state.store,
      registry: factory.registry,
      env: {},
    });
    await assert.rejects(unset.clientFromProfile("production"), {
      code: "credential_missing",
    });
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("provider action inputs remain available internally but are redacted from output", async () => {
  const state = await isolatedStore();
  const adminPassword = "admin-password-from-input";
  const sftpPassword = "sftp-password-from-input";
  const sslKey = "private-ssl-key-from-input";
  let received;
  try {
    const factory = createHostingClientFactory({
      store: state.store,
      registry: {
        kinsta: () => ({
          provider: "kinsta",
          validate: async () => {
            throw new Error("unused");
          },
          listSites: async () => [],
          getSite: async () => {
            throw new Error("unused");
          },
          listEnvironments: async () => [],
          read: async () => null,
          action: async (request) => {
            received = request.body;
            return {
              provider: "kinsta",
              action: "sites.create",
              status: 202,
              operationId: adminPassword,
              message: `queued ${adminPassword}`,
              raw: {
                echoed: [adminPassword, sftpPassword, sslKey],
              },
            };
          },
          operationStatus: async (operationId) => ({
            provider: "kinsta",
            operationId,
            status: 200,
            done: false,
            failed: false,
            message: `finished ${sftpPassword}`,
            raw: { echoed: sslKey },
          }),
        }),
      },
      env: { KINSTA_API_KEY: "placeholder-not-a-secret" },
    });
    const client = await factory.clientFromProfile("production");
    const body = {
      admin_password: adminPassword,
      password: sftpPassword,
      custom_ssl_key: sslKey,
    };
    const result = await client.action({
      kind: "create-site",
      mode: "wordpress",
      body,
    });
    assert.deepEqual(received, body);

    const actionOutput = JSON.stringify(renderAction(result));
    for (const secret of [adminPassword, sftpPassword, sslKey])
      assert.equal(actionOutput.includes(secret), false, actionOutput);
    assert.match(actionOutput, /\[REDACTED\]/);

    const status = await client.operationStatus(adminPassword);
    const operationOutput = JSON.stringify(renderOperation(status));
    for (const secret of [adminPassword, sftpPassword, sslKey])
      assert.equal(operationOutput.includes(secret), false, operationOutput);
    const failure = operationFailure(status);
    const derivedFailure = `${failure.message} ${JSON.stringify(failure.details)}`;
    for (const secret of [adminPassword, sftpPassword, sslKey])
      assert.equal(derivedFailure.includes(secret), false, derivedFailure);

    await assert.rejects(
      waitForOperationStatus(client, adminPassword, {
        intervalSeconds: 1,
        timeoutSeconds: 0,
        now: () => 0,
        sleep: async () => undefined,
      }),
      (error) => {
        const output = `${error.message} ${JSON.stringify(error.details)}`;
        assert.equal(output.includes(adminPassword), false, output);
        assert.match(output, /\[REDACTED\]/);
        return true;
      },
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("provider semantic errors redact action input secrets", async () => {
  const state = await isolatedStore();
  const password = "failed-action-password";
  try {
    const factory = createHostingClientFactory({
      store: state.store,
      registry: {
        kinsta: () => ({
          provider: "kinsta",
          validate: async () => {
            throw new Error("unused");
          },
          listSites: async () => [],
          getSite: async () => {
            throw new Error("unused");
          },
          listEnvironments: async () => [],
          read: async () => null,
          action: async () => {
            throw new CliError(
              "provider_error",
              `Provider echoed ${password}`,
              {
                details: { echoed: password },
              },
            );
          },
          operationStatus: async () => {
            throw new Error("unused");
          },
        }),
      },
      env: { KINSTA_API_KEY: "placeholder-not-a-secret" },
    });
    const client = await factory.clientFromProfile("production");
    await assert.rejects(
      client.action({
        kind: "create-site",
        mode: "wordpress",
        body: { admin_password: password },
      }),
      (error) => {
        const serialized = JSON.stringify({
          message: error.message,
          details: error.details,
        });
        assert.equal(serialized.includes(password), false, serialized);
        assert.match(serialized, /\[REDACTED\]/);
        return true;
      },
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("neutral hosting helpers keep the Go semantics", () => {
  assert.equal(wpCliWithoutBinary("wp plugin list"), "plugin list");
  assert.equal(wpCliWithoutBinary("  WP   plugin list  "), "plugin list");
  assert.equal(wpCliWithoutBinary("wp"), "");
  assert.equal(wpCliWithoutBinary("plugin list"), "plugin list");
  assert.equal(wpCliWithoutBinary("wpcli plugin list"), "wpcli plugin list");

  assert.equal(wpCliResultsObservable({ provider: "kinsta" }), true);
  assert.equal(
    wpCliResultsObservable({
      provider: "rocketnet",
      wpCliResultsObservable: () => false,
    }),
    false,
  );

  assert.deepEqual(
    providerCapabilities([
      "sites",
      ["wp-cli", false],
      ["backups", true, "daily"],
    ]),
    [
      { name: "sites", supported: true },
      { name: "wp-cli", supported: false },
      { name: "backups", supported: true, notes: "daily" },
    ],
  );

  // Wire compatibility with the Go CLI: snake_case keys, `omitempty` honoured.
  assert.deepEqual(
    serializeHostingSite({
      id: "site-1",
      name: "example",
      displayName: "Example",
      status: "live",
      environments: [
        {
          id: "env-1",
          name: "live",
          displayName: "Live",
          isBlocked: false,
          isPremium: true,
          primaryDomain: "example.test",
        },
      ],
    }),
    {
      id: "site-1",
      name: "example",
      display_name: "Example",
      status: "live",
      environments: [
        {
          id: "env-1",
          name: "live",
          display_name: "Live",
          is_blocked: false,
          is_premium: true,
          primary_domain: "example.test",
        },
      ],
    },
  );
});
