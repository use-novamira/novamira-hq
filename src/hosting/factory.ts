// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The port of Go's `providers.ClientFromProfile`: turn a named hosting profile
 * into a ready `ProviderClient`.
 *
 * Go dispatches with a `switch` over eight `New*Client` constructors. HQ cannot,
 * because the provider modules land one at a time in Phase 3 and because the
 * composition root must stay testable without live provider calls. Instead the
 * factory owns everything that is provider-neutral — loading the profile,
 * resolving its credential (including WP Engine's legacy environment fallback),
 * normalizing the API base URL, and building a configured `HttpClient` — and
 * hands the result to an injected registry of per-provider constructors.
 *
 * Each provider module therefore exports a `ProviderClientFactory` and never
 * reads configuration, environment variables, or credentials itself; it decides
 * only its own authentication scheme, which is why the context hands out an
 * `HttpClient` builder rather than a finished authenticated client (Pressable,
 * Rocket.net and Cloudways exchange their credential for a short-lived token and
 * must supply `dynamicAuth`).
 */

import { CliError } from "../errors.js";
import type { ConfigStore, HostingProfileEntry } from "../config/profiles.js";
import {
  type HostingProfile,
  type ProviderKind,
  PROVIDER_KINDS,
  credentialSource,
  defaultCredentialEnv,
  envCredential,
  isProviderKind,
  profileApiBaseUrl,
  providerDefaults,
} from "../config/schema.js";
import {
  type CredentialResolver,
  type SecretValue,
  createCredentialResolver,
} from "../credentials/resolve.js";
import {
  type HttpClient,
  type HttpClientOptions,
  createHttpClient as createProviderHttpClient,
} from "./http-client.js";
import type { ProviderClient } from "./client.js";
import { secretSafeProviderClient } from "./redaction.js";
import { providerLabel } from "./types.js";

/**
 * Overrides for the per-provider `HttpClient`. `baseUrl` and `providerLabel`
 * are supplied by the factory; a provider overrides them only for a secondary
 * origin (none does today — Pressable's token endpoint shares its API origin and
 * is reached with an absolute path on the same client).
 */
export type ProviderHttpOptions = Partial<HttpClientOptions>;

/** Invocation-level limits that provider constructors cannot override. */
export interface HostingHttpLimits {
  readonly timeoutMs: number;
  readonly totalTimeoutMs?: number;
}

/**
 * Everything a provider module needs to construct itself. No field is a raw
 * secret: `secret` is a `SecretValue` whose `reveal()` must only be called while
 * building an authorization header.
 */
export interface ProviderClientContext {
  /** Secondary-origin transfers; injected alongside the provider HTTP seam. */
  readonly transferFetch?: typeof fetch;
  readonly provider: ProviderKind;
  /** Human-readable provider name for error messages, e.g. `WP Engine`. */
  readonly providerLabel: string;
  /** The hosting profile's name in `config.json`. */
  readonly profileName: string;
  readonly profile: HostingProfile;
  /** Profile `apiBaseUrl` or the provider default, without trailing slashes. */
  readonly baseUrl: string;
  readonly secret: SecretValue;
  /** Non-secret rendering of where the secret came from, e.g. `env:WPE_API_PASSWORD`. */
  readonly credentialSource: string;
  /** The profile's configured `companyId`, verbatim, when non-empty. */
  readonly companyId: string | undefined;
  /**
   * The non-secret identity half of a two-part credential: the profile's
   * `companyId`, else the provider's `identityEnv`, else its `fallbackIdentityEnv`
   * (WP Engine API user id, Rocket.net username, Cloudways email, Pressable
   * client id). Mirrors the resolution order of the Go constructors. A provider
   * that requires one raises `credential_missing` when this is `undefined`.
   */
  readonly identity: string | undefined;
  /** OAuth token endpoint from `PROVIDER_DEFAULTS`, when the provider has one. */
  readonly tokenUrl: string | undefined;
  /** The environment the factory read; providers must not read `process.env`. */
  readonly env: NodeJS.ProcessEnv;
  /** Build the provider's HTTP client, already bound to `baseUrl`. */
  createHttpClient(overrides?: ProviderHttpOptions): HttpClient;
}

/** A provider module's constructor. */
export type ProviderClientFactory = (
  context: ProviderClientContext,
) => ProviderClient | Promise<ProviderClient>;

/**
 * The set of provider constructors available to this process. It is partial by
 * design: Phase 3 registers providers as they land, and tests register fakes.
 */
export type ProviderRegistry = Readonly<
  Partial<Record<ProviderKind, ProviderClientFactory>>
>;

export interface HostingClientFactoryOptions {
  /** Composition-root wrapper; observes calls without changing provider APIs. */
  readonly decorateClient?: (
    client: ProviderClient,
    profile: string,
  ) => ProviderClient;
  readonly store: ConfigStore;
  readonly registry: ProviderRegistry;
  /** Defaults to a resolver over `env` with no credential store attached. */
  readonly resolver?: CredentialResolver;
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Shared `HttpClient` defaults (timeouts, retry policy, `onDiagnostic`, and
   * the `fetch`/`sleep`/`random` injection points used by tests). `baseUrl` and
   * `providerLabel` are always taken from the profile.
   */
  readonly http?: ProviderHttpOptions;
}

export interface HostingClientFactory {
  readonly registry: ProviderRegistry;
  /** Load the named hosting profile and construct its provider client. */
  clientFromProfile(
    profileName: string,
    limits?: HostingHttpLimits,
  ): Promise<ProviderClient>;
  clientFromEntry(
    entry: HostingProfileEntry,
    limits?: HostingHttpLimits,
  ): Promise<ProviderClient>;
  /** The provider-neutral construction context, without the client itself. */
  contextFromEntry(
    entry: HostingProfileEntry,
    limits?: HostingHttpLimits,
  ): Promise<ProviderClientContext>;
}

export function createHostingClientFactory(
  options: HostingClientFactoryOptions,
): HostingClientFactory {
  const env = options.env ?? process.env;
  const resolver = options.resolver ?? createCredentialResolver({ env });
  const shared = options.http;

  async function contextFromEntry(
    entry: HostingProfileEntry,
    limits?: HostingHttpLimits,
  ): Promise<ProviderClientContext> {
    const { profile } = entry;
    const provider = profile.provider;
    const label = providerLabel(provider);
    const defaults = providerDefaults(provider);
    const baseUrl = normalizeBaseUrl(profile, label);
    const resolved = await resolveProviderSecret(provider, profile, resolver);

    return {
      transferFetch: shared?.fetch ?? globalThis.fetch,
      provider,
      providerLabel: label,
      profileName: entry.name,
      profile,
      baseUrl,
      secret: resolved.secret,
      credentialSource: resolved.source,
      companyId: nonEmpty(profile.companyId),
      identity:
        nonEmpty(profile.companyId) ??
        lookupEnv(env, defaults.identityEnv) ??
        lookupEnv(env, defaults.fallbackIdentityEnv),
      tokenUrl: defaults.tokenUrl,
      env,
      createHttpClient(overrides?: ProviderHttpOptions): HttpClient {
        return createProviderHttpClient({
          ...shared,
          baseUrl,
          providerLabel: label,
          ...overrides,
          ...limits,
        });
      },
    };
  }

  async function clientFromEntry(
    entry: HostingProfileEntry,
    limits?: HostingHttpLimits,
  ): Promise<ProviderClient> {
    const factory = requireProviderFactory(
      options.registry,
      entry.profile.provider,
    );
    const client = await factory(await contextFromEntry(entry, limits));
    return secretSafeProviderClient(
      options.decorateClient?.(client, entry.name) ?? client,
    );
  }

  return {
    registry: options.registry,
    contextFromEntry,
    clientFromEntry,
    async clientFromProfile(
      profileName: string,
      limits?: HostingHttpLimits,
    ): Promise<ProviderClient> {
      return clientFromEntry(
        await options.store.requireHostingProfile(profileName),
        limits,
      );
    },
  };
}

/**
 * One-shot convenience mirroring Go's `ClientFromProfile(profile)`. Prefer
 * building a single `HostingClientFactory` per process and reusing it.
 */
export async function clientFromProfile(
  profileName: string,
  options: HostingClientFactoryOptions,
): Promise<ProviderClient> {
  return createHostingClientFactory(options).clientFromProfile(profileName);
}

/** The provider kinds that currently have a registered constructor. */
export function registeredProviders(
  registry: ProviderRegistry,
): ProviderKind[] {
  return PROVIDER_KINDS.filter((kind) => registry[kind] !== undefined);
}

function requireProviderFactory(
  registry: ProviderRegistry,
  provider: string,
): ProviderClientFactory {
  if (!isProviderKind(provider)) {
    throw new CliError(
      "provider_unsupported",
      `Unsupported hosting provider "${provider}".`,
      { details: { provider, providers: [...PROVIDER_KINDS] } },
    );
  }
  const factory = registry[provider];
  if (factory === undefined) {
    throw new CliError(
      "provider_unsupported",
      `The ${providerLabel(provider)} provider client is not available in this build.`,
      { details: { provider, registered: registeredProviders(registry) } },
    );
  }
  return factory;
}

/**
 * Resolve the profile's credential, falling back to the provider's legacy
 * environment variable when the configured reference is the default `env` one
 * and it is unset. Only WP Engine declares a `fallbackCredentialEnv`, so this
 * generalizes `NewWPEngineClient`'s behaviour without special-casing it. The
 * original failure is rethrown when the fallback is unavailable, so the error
 * still names the credential the profile actually points at.
 */
async function resolveProviderSecret(
  provider: ProviderKind,
  profile: HostingProfile,
  resolver: CredentialResolver,
): Promise<{ readonly secret: SecretValue; readonly source: string }> {
  const ref = profile.credential;
  try {
    return {
      secret: await resolver.resolve(ref),
      source: credentialSource(ref),
    };
  } catch (error) {
    const fallbackEnv = providerDefaults(provider).fallbackCredentialEnv;
    if (
      fallbackEnv === undefined ||
      ref.type !== "env" ||
      ref.name !== defaultCredentialEnv(provider)
    ) {
      throw error;
    }
    const fallbackRef = envCredential(fallbackEnv);
    try {
      return {
        secret: await resolver.resolve(fallbackRef),
        source: credentialSource(fallbackRef),
      };
    } catch {
      throw error;
    }
  }
}

function normalizeBaseUrl(profile: HostingProfile, label: string): string {
  const trimmed = profileApiBaseUrl(profile).replace(/\/+$/, "");
  if (trimmed === "" || !URL.canParse(trimmed)) {
    throw new CliError(
      "config_error",
      `The ${label} API base URL is not a valid absolute URL.`,
      { details: { apiBaseUrl: trimmed } },
    );
  }
  return trimmed;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function lookupEnv(
  env: NodeJS.ProcessEnv,
  name: string | undefined,
): string | undefined {
  return name === undefined ? undefined : nonEmpty(env[name]);
}
