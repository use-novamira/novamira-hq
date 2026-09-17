// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The provider registry contract: the composition root must be able to build a
 * real client for every provider kind in the taxonomy.
 *
 * `ProviderRegistry` is `Partial` by design, so a forgotten provider would
 * otherwise only show up as a `provider_unsupported` failure at runtime. These
 * assertions pin the total mapping, the registry's injectability, and the fact
 * that construction is offline: no test here performs a network call.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  createHostingClientFactory,
  registeredProviders,
} from "../dist/hosting/factory.js";
import { PROVIDER_REGISTRY } from "../dist/hosting/providers/index.js";
import {
  ENVIRONMENT_PUSH_PROVIDERS,
  NOVAMIRA_SETUP_PROVIDERS,
  NOVAMIRA_SETUP_PROVIDER_LABELS,
  providerLabel,
} from "../dist/hosting/types.js";
import { wpCliResultsObservable } from "../dist/hosting/client.js";
import { main } from "../dist/main.js";

/** An obvious fake. Nothing in this suite ever contacts a real provider. */
const PLACEHOLDER = "registry-fake-credential-not-a-real-secret";

/**
 * The identity half of a two-part credential, for the providers that require
 * one before they will construct at all.
 */
const IDENTITY = "registry-fake-identity";

async function isolatedStore() {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-registry-"));
  const paths = platformPaths({ NOVAMIRA_HQ_HOME: root });
  const security = new UnixFileSecurity();
  const locks = new ProfileLockManager(paths.stateDir, security);
  return {
    root,
    paths,
    store: new ConfigStore(paths.configFile, locks, security),
  };
}

test("the registry covers every provider kind exactly once", () => {
  const keys = Object.keys(PROVIDER_REGISTRY);
  assert.deepEqual([...keys].sort(), [...PROVIDER_KINDS].sort());
  assert.equal(keys.length, 8);
  assert.equal(new Set(keys).size, keys.length);

  // Distinct constructors: a copy-paste in the map would alias two providers.
  const factories = Object.values(PROVIDER_REGISTRY);
  assert.equal(new Set(factories).size, 8);
  for (const kind of PROVIDER_KINDS) {
    assert.equal(
      typeof PROVIDER_REGISTRY[kind],
      "function",
      `${kind} is not a callable factory`,
    );
  }
});

test("registeredProviders reports all eight in taxonomy order", () => {
  assert.deepEqual(registeredProviders(PROVIDER_REGISTRY), [...PROVIDER_KINDS]);
});

test("every registered factory builds a working client from a profile", async () => {
  const state = await isolatedStore();
  try {
    const env = Object.fromEntries(
      PROVIDER_KINDS.map((kind) => [defaultCredentialEnv(kind), PLACEHOLDER]),
    );
    const factory = createHostingClientFactory({
      store: state.store,
      registry: PROVIDER_REGISTRY,
      env,
    });

    for (const kind of PROVIDER_KINDS) {
      await state.store.upsertHostingProfile(kind, {
        provider: kind,
        credential: envCredential(defaultCredentialEnv(kind)),
        // Doubles as the identity for the providers that need one, and keeps
        // construction from having to read the environment.
        companyId: IDENTITY,
      });
      const client = await factory.clientFromProfile(kind);
      assert.equal(client.provider, kind);
      for (const method of [
        "validate",
        "listSites",
        "getSite",
        "listEnvironments",
        "read",
        "action",
        "operationStatus",
      ]) {
        assert.equal(
          typeof client[method],
          "function",
          `${kind}.${method} is missing`,
        );
      }
      // Constructing must not have contacted the provider: the capability
      // matrix is answered locally by every client.
      const capabilities = await client.read({ kind: "capabilities" });
      assert.ok(
        Array.isArray(capabilities) && capabilities.length > 0,
        `${kind} reports no capabilities`,
      );
    }
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("the composition root uses the real registry and still accepts a fake", async () => {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-registry-main-"));
  try {
    // A profile for a provider the injected registry does not know about
    // proves the override reached the hosting client factory.
    await writeFile(
      join(root, "config.json"),
      JSON.stringify({
        version: 1,
        hosting_profiles: {
          production: {
            provider: "kinsta",
            credential: { type: "env", name: "KINSTA_API_KEY" },
          },
        },
      }),
      { mode: 0o600 },
    );
    const out = [];
    const streams = {
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: () => undefined },
    };
    // Default (production) wiring: no override, real registry, no network.
    assert.equal(
      await main(["config", "path", "--json"], streams, {
        NOVAMIRA_HQ_HOME: root,
      }),
      0,
    );
    // The same invocation with an empty registry injected still succeeds:
    // the seam exists and nothing eagerly constructs a provider client.
    assert.equal(
      await main(
        ["config", "path", "--json"],
        streams,
        { NOVAMIRA_HQ_HOME: root },
        { registry: {} },
      ),
      0,
    );
    assert.equal(out.length, 2);
    for (const chunk of out) {
      assert.equal(JSON.parse(chunk).ok, true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* The two capability sets the dashboard's views render from                  */
/* -------------------------------------------------------------------------- */

/**
 * Go hard-coded `deploySupported` and `novamiraSetupSupported` as `switch`
 * statements inside the dashboard package, three files away from the clients
 * they described. `src/hosting/types.ts` states them beside the clients; these
 * cases prove the statement against the clients themselves, so adding a provider
 * that implements the action and forgetting the set is a red test rather than a
 * dashboard button that does nothing.
 *
 * Nothing here reaches a provider. `fetch` is replaced with a function that
 * throws a marker, so "the client tried to make a request" and "the client
 * refused the action locally" are two distinguishable, offline outcomes.
 */
const REACHED_NETWORK = Symbol("reached the provider");

async function actionSupport(kind, request) {
  const state = await isolatedStore();
  try {
    const env = Object.fromEntries(
      PROVIDER_KINDS.map((provider) => [
        defaultCredentialEnv(provider),
        PLACEHOLDER,
      ]),
    );
    const factory = createHostingClientFactory({
      store: state.store,
      registry: PROVIDER_REGISTRY,
      env,
      http: {
        retries: 0,
        fetch: async () => {
          throw REACHED_NETWORK;
        },
      },
    });
    await state.store.upsertHostingProfile(kind, {
      provider: kind,
      credential: envCredential(defaultCredentialEnv(kind)),
      companyId: IDENTITY,
    });
    const client = await factory.clientFromProfile(kind);
    try {
      await client.action(request);
    } catch (error) {
      if (error === REACHED_NETWORK) return { supported: true, client };
      if (error?.code === "provider_unsupported") {
        return { supported: false, client };
      }
      // Any other failure still means the action was accepted and got as far as
      // building or sending a request.
      return { supported: true, client };
    }
    return { supported: true, client };
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
}

test("ENVIRONMENT_PUSH_PROVIDERS is exactly the clients advertising safe envs.push", async () => {
  for (const kind of PROVIDER_KINDS) {
    const state = await isolatedStore();
    let supported;
    try {
      await state.store.upsertHostingProfile(kind, {
        provider: kind,
        credential: envCredential(defaultCredentialEnv(kind)),
        companyId: IDENTITY,
      });
      const factory = createHostingClientFactory({
        store: state.store,
        registry: PROVIDER_REGISTRY,
        env: Object.fromEntries(
          PROVIDER_KINDS.map((provider) => [
            defaultCredentialEnv(provider),
            PLACEHOLDER,
          ]),
        ),
      });
      const client = await factory.clientFromProfile(kind);
      const capabilities = await client.read({ kind: "capabilities" });
      supported = capabilities.some(
        (entry) => entry.name === "envs.push" && entry.supported,
      );
    } finally {
      await rm(state.root, { recursive: true, force: true });
    }
    assert.equal(
      ENVIRONMENT_PUSH_PROVIDERS.has(kind),
      supported,
      `${kind}: the set and the advertised granular capability disagree`,
    );
  }
  assert.deepEqual([...ENVIRONMENT_PUSH_PROVIDERS], ["kinsta"]);
});

test("NOVAMIRA_SETUP_PROVIDERS supports observable WP-CLI or bounded Hostinger setup", async () => {
  for (const kind of PROVIDER_KINDS) {
    const { supported, client } = await actionSupport(kind, {
      kind: "run-wp-cli",
      envId: "env-1",
      body: { command: "wp core version" },
    });
    // Both conditions, exactly as `provisionNovamira` applies them: Pressable
    // implements the action but reports its results unobservable, so a plugin
    // install could not be verified and the setup flow refuses it.
    const eligible =
      kind === "hostinger" || (supported && wpCliResultsObservable(client));
    assert.equal(
      NOVAMIRA_SETUP_PROVIDERS.has(kind),
      eligible,
      `${kind}: the set and the client disagree about novamira setup`,
    );
  }
  assert.deepEqual([...NOVAMIRA_SETUP_PROVIDERS].sort(), [
    "hostinger",
    "instawp",
    "kinsta",
    "rocketnet",
  ]);
  // The labels are what a disabled "Setup Novamira" button names, so they must
  // stay the same three providers spelled the way the rest of HQ spells them.
  assert.deepEqual(
    [...NOVAMIRA_SETUP_PROVIDERS].map(providerLabel).sort(),
    [...NOVAMIRA_SETUP_PROVIDER_LABELS].sort(),
  );
});
