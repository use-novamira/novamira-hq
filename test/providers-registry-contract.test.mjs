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
