// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The site inventory the dashboard renders: the provider listing, its
 * five-minute cache, the one connected-state round per listing, and the two
 * cache readers the deploy-path pages need.
 *
 * **What the Go did.** `*Server` carried `sitesCache map[sitesCacheKey]
 * sitesCacheEntry` behind the same `sync.Mutex` that guarded the config file
 * (`server.go:49`), `listSiteGroups` walked the profiles (`:1436-1481`),
 * `deployPathSummaries` reached into the warm `__all__` entry to resolve
 * environment names and domains (`:1534-1588`), and `deployNewViewFromRequest`
 * did the same to find one site (`:920-957`). Every one of those was a method on
 * the HTTP server, so none could be exercised without one.
 *
 * **What HQ does instead.** A value with five methods and no HTTP in sight. Node
 * is single-threaded, so Go's mutex becomes a plain `Map` — but a mutex is not
 * the only thing that was doing work there. Two simultaneous loads of the same
 * key (the toolbar's `data-init` racing an operator's Refresh) would have issued
 * two full rounds of provider calls, so an **in-flight promise map** collapses
 * them into one. That is the port of the lock, not of the locking.
 *
 * **What the cache holds, and what it deliberately does not.** It holds the
 * provider listing — the expensive part, one HTTP round trip per profile — for
 * {@link SITES_CACHE_TTL_MS}, which is Go's `sitesCacheTTL`. It does **not** hold
 * the {@link ConnectionSnapshot}: connected state is cheap next to a provider
 * API call, it goes stale faster (a `novamira auth login` in another window
 * changes it), and `/_dashboard/connect` has to be able to refresh it *alone*,
 * without re-listing. So `list` recomputes it on the cached path too, and
 * {@link SitesService.refreshConnections} exposes it on its own.
 *
 * **Connected state degrades, it never fails.** `connectionStates` is documented
 * never to throw, but if an injected one does, this module answers with an empty
 * snapshot whose `cliAvailable` is `false`. That is not swallowing the failure:
 * `connectionView` turns `cliAvailable: false` into `unavailable` plus the
 * install hint for every environment, which is the honest "HQ cannot tell"
 * rendering. Returning an empty *map* with `cliAvailable: true` would instead
 * claim every environment is `not_configured`, which is a wrong answer rather
 * than a degraded one.
 *
 * **A group error is data, not an exception — for `__all__` only.** Go made the
 * same distinction (`server.go:1458-1481`): listing every profile must survive
 * one provider being down, so the failure becomes `group.error` and the other
 * groups still render; listing *one* named profile has nothing left to render,
 * so the error propagates and the handler turns it into a page-level notice.
 *
 * **Layering.** This module may import `src/config/`, `src/hosting/` and
 * `src/connection-state.ts`, and it imports no view and no handler. The
 * connected-state dependency is declared **structurally**
 * ({@link ConnectedStateSource}) rather than imported from `src/web/server.ts`,
 * so there is no edge — not even a type-only one — between a service and the
 * server that constructs it.
 */

import type { HostingProfileEntry } from "../../config/profiles.js";
import type { ConfigStore } from "../../config/profiles.js";
import type { ProviderKind } from "../../config/schema.js";
import {
  NOT_CONFIGURED_CONNECTION,
  type ConnectionQuery,
  type ConnectionResult,
  type ConnectionSnapshot,
} from "../../connection-state.js";
import { asCliError } from "../../errors.js";
import type { HostingClientFactory } from "../../hosting/factory.js";
import type { HostingEnvironment, HostingSite } from "../../hosting/types.js";
import { ALL_PROFILES_SENTINEL } from "../signals.js";

/** Five minutes — Go's `sitesCacheTTL` (`server.go:49`), unchanged. */
export const SITES_CACHE_TTL_MS = 300_000;

/** One hosting profile's sites, or the reason they could not be listed. */
export interface SiteGroup {
  readonly profile: string;
  readonly provider: ProviderKind;
  readonly sites: readonly HostingSite[];
  /** A message, never a `CliError`: `details` must not reach a rendered page. */
  readonly error?: string;
}

export interface SitesResult {
  /** The cache key's profile: a profile name, or `__all__`. */
  readonly profile: string;
  readonly includeEnvs: boolean;
  /** True when the provider listing came from the cache rather than the API. */
  readonly cached: boolean;
  /** Unix milliseconds the listing was stored; feeds `#sites-status`. */
  readonly storedAt: number | null;
  readonly expiresAt: number | null;
  readonly groups: readonly SiteGroup[];
  /** `null` when there was no environment to ask about. */
  readonly connections: ConnectionSnapshot | null;
}

/** Go's `envDisplay` (`server.go:1534-1552`). */
export interface EnvDisplay {
  readonly name: string;
  readonly domain: string;
}

/**
 * Go's `resolve` closure inside `deployPathSummaries`: the warm inventory's name
 * and domain for an environment id, falling back to the name stored on the
 * deploy path and then to the raw id.
 */
export type EnvResolver = (envId: string, storedName: string) => EnvDisplay;

/** One site found in the warm cache, for the new-deploy-path page. */
export interface ResolvedSite {
  readonly label: string;
  readonly envs: readonly HostingEnvironment[];
}

export interface SitesListOptions {
  readonly profile: string;
  readonly includeEnvs: boolean;
  readonly refresh: boolean;
}

export interface SitesService {
  /** List, from the cache when it is warm and `refresh` is false. */
  list(options: SitesListOptions): Promise<SitesResult>;
  /** The warm cache only — never triggers a provider call. */
  warm(profile: string, includeEnvs: boolean): SitesResult | undefined;
  /** Drop everything. Go's `clearSitesCacheLocked`, on any provider mutation. */
  invalidate(): void;
  /** Env id → name and domain, from the warm `__all__` inventory. */
  envResolver(): EnvResolver;
  /**
   * Find one site in the warm cache, trying `{profile, envs}` then
   * `{__all__, envs}` — Go's `deployNewViewFromRequest` order (`server.go:931`).
   */
  resolveSite(profile: string, siteId: string): ResolvedSite | undefined;
  /** Connected state for an already-listed set of groups, without re-listing. */
  refreshConnections(
    groups: readonly SiteGroup[],
  ): Promise<ConnectionSnapshot | null>;
}

/**
 * The connected-state dependency, declared structurally.
 *
 * `SiteCliIntegration` and `DashboardIntegration` both satisfy it member for
 * member. Declaring it here rather than importing either keeps `src/web/`'s
 * services free of an edge to `src/web/server.ts` and of one to
 * `src/integration/`, which is a peer layer.
 */
export interface ConnectedStateSource {
  connectionStates(
    queries: readonly ConnectionQuery[],
  ): Promise<ConnectionSnapshot>;
}

export interface SitesServiceOptions {
  readonly store: ConfigStore;
  readonly hosting: HostingClientFactory;
  readonly integration: ConnectedStateSource;
  readonly now: () => number;
  /** Overridable so a contract test can drive expiry without waiting. */
  readonly ttlMs?: number;
}

/**
 * The key one environment's connection state is filed under.
 *
 * Exported because `views/sites.ts` has to look the same key up, and a second
 * spelling of it would silently render every environment as `not_configured`.
 */
export function connectionKey(
  profile: string,
  siteId: string,
  envId: string,
): string {
  return `${profile}/${siteId}/${envId}`;
}

/**
 * One environment's result, or the shared "nothing matched" value.
 *
 * A missing key is `not_configured` rather than an error: the snapshot is built
 * from the same groups the view renders, so a key can only be missing when the
 * listing changed under a stale snapshot.
 */
export function connectionFor(
  snapshot: ConnectionSnapshot | null,
  key: string,
): ConnectionResult {
  return snapshot?.byKey.get(key) ?? NOT_CONFIGURED_CONNECTION;
}

interface CacheEntry {
  readonly groups: readonly SiteGroup[];
  readonly storedAt: number;
  readonly expiresAt: number;
}

/**
 * `includeEnvs` and the profile name, joined by a NUL.
 *
 * A profile name matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and so can never
 * contain a NUL, which makes the encoding injective — `("a", true)` and
 * `("a 1", false)` cannot collide the way a `:` separator would allow.
 */
function cacheKey(profile: string, includeEnvs: boolean): string {
  return `${includeEnvs ? "1" : "0"} ${profile}`;
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** Go's `title` fallback chain, used for both sites and environments. */
export function displayLabel(
  displayName: string,
  name: string,
  id: string,
): string {
  if (displayName !== "") return displayName;
  if (name !== "") return name;
  return id;
}

export function createSitesService(options: SitesServiceOptions): SitesService {
  const ttlMs = options.ttlMs ?? SITES_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<CacheEntry>>();

  /** An entry that has not expired, deleting it when it has. Go's `cachedSites`. */
  const read = (key: string): CacheEntry | undefined => {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    if (options.now() >= entry.expiresAt) {
      cache.delete(key);
      return undefined;
    }
    return entry;
  };

  const loadGroup = async (
    entry: HostingProfileEntry,
    includeEnvs: boolean,
  ): Promise<SiteGroup> => {
    const client = await options.hosting.clientFromEntry(entry);
    const sites = await client.listSites({ includeEnvironments: includeEnvs });
    return { profile: entry.name, provider: entry.profile.provider, sites };
  };

  const loadGroups = async (
    profile: string,
    includeEnvs: boolean,
  ): Promise<readonly SiteGroup[]> => {
    if (profile === ALL_PROFILES_SENTINEL) {
      // Sequential, as Go's loop was: a dashboard that fans out across twelve
      // provider APIs at once is how an operator finds their rate limit.
      const groups: SiteGroup[] = [];
      for (const entry of await options.store.listHostingProfiles()) {
        try {
          groups.push(await loadGroup(entry, includeEnvs));
        } catch (error) {
          groups.push({
            profile: entry.name,
            provider: entry.profile.provider,
            sites: [],
            error: asCliError(error).message,
          });
        }
      }
      return groups;
    }
    // One named profile: a failure has nothing left to render, so it propagates
    // and becomes the page-level notice (Go, `server.go:1458-1460`).
    const entry = await options.store.requireHostingProfile(profile);
    return [await loadGroup(entry, includeEnvs)];
  };

  /** Fill the cache, collapsing concurrent loads of one key into one round. */
  const fill = (
    key: string,
    profile: string,
    includeEnvs: boolean,
  ): Promise<CacheEntry> => {
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;
    const started = (async (): Promise<CacheEntry> => {
      const groups = await loadGroups(profile, includeEnvs);
      const storedAt = options.now();
      const entry: CacheEntry = {
        groups,
        storedAt,
        expiresAt: storedAt + ttlMs,
      };
      cache.set(key, entry);
      return entry;
    })();
    const tracked = started.finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, tracked);
    return tracked;
  };

  const refreshConnections = async (
    groups: readonly SiteGroup[],
  ): Promise<ConnectionSnapshot | null> => {
    const queries: ConnectionQuery[] = [];
    for (const group of groups) {
      for (const site of group.sites) {
        for (const env of site.environments ?? []) {
          queries.push({
            key: connectionKey(group.profile, site.id, env.id),
            // Most specific first. They are heterogeneous by provider — a bare
            // hostname or a full URL — and `src/integration/origin.ts`
            // normalizes them, so nothing here parses a URL.
            origins: [env.primaryDomain, site.primaryDomain].filter(nonEmpty),
          });
        }
      }
    }
    if (queries.length === 0) return null;
    try {
      return await options.integration.connectionStates(queries);
    } catch {
      // See this file's header: an empty map with `cliAvailable: false` renders
      // as "Unknown" plus the install hint, which is the honest degradation. An
      // empty map with `cliAvailable: true` would claim "Not connected".
      return {
        byKey: new Map<string, ConnectionResult>(),
        checkedAt: options.now(),
        cliAvailable: false,
      };
    }
  };

  const resultFrom = (
    profile: string,
    includeEnvs: boolean,
    entry: CacheEntry,
    cached: boolean,
    connections: ConnectionSnapshot | null,
  ): SitesResult => ({
    profile,
    includeEnvs,
    cached,
    storedAt: entry.storedAt,
    expiresAt: entry.expiresAt,
    groups: entry.groups,
    connections,
  });

  /** The warm `__all__` inventory every deploy-path resolution reads. */
  const warmAll = (): CacheEntry | undefined =>
    read(cacheKey(ALL_PROFILES_SENTINEL, true));

  return {
    list: async (request) => {
      const key = cacheKey(request.profile, request.includeEnvs);
      const warmEntry = request.refresh ? undefined : read(key);
      const entry =
        warmEntry ?? (await fill(key, request.profile, request.includeEnvs));
      return resultFrom(
        request.profile,
        request.includeEnvs,
        entry,
        warmEntry !== undefined,
        await refreshConnections(entry.groups),
      );
    },

    warm: (profile, includeEnvs) => {
      const entry = read(cacheKey(profile, includeEnvs));
      return entry === undefined
        ? undefined
        : resultFrom(profile, includeEnvs, entry, true, null);
    },

    invalidate: () => {
      cache.clear();
    },

    envResolver: () => {
      const known = new Map<string, EnvDisplay>();
      for (const group of warmAll()?.groups ?? []) {
        for (const site of group.sites) {
          for (const env of site.environments ?? []) {
            known.set(env.id, {
              name: displayLabel(env.displayName, env.name, env.id),
              domain: env.primaryDomain ?? "",
            });
          }
        }
      }
      return (envId, storedName) => {
        const found = known.get(envId);
        if (found !== undefined) return found;
        if (storedName !== "") return { name: storedName, domain: "" };
        return { name: envId, domain: "" };
      };
    },

    resolveSite: (profile, siteId) => {
      if (profile === "" || siteId === "") return undefined;
      for (const key of [
        cacheKey(profile, true),
        cacheKey(ALL_PROFILES_SENTINEL, true),
      ]) {
        for (const group of read(key)?.groups ?? []) {
          for (const site of group.sites) {
            if (site.id !== siteId) continue;
            return {
              label: displayLabel(site.displayName, site.name, site.id),
              envs: site.environments ?? [],
            };
          }
        }
      }
      return undefined;
    },

    refreshConnections,
  };
}
