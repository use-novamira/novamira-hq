// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The site inventory the dashboard renders: the provider listing, its
 * five-minute cache, the one connected-state round per listing, and the two
 * cache readers the push pages need.
 *
 * **What the Go did.** `*Server` carried `sitesCache map[sitesCacheKey]
 * sitesCacheEntry` behind the same `sync.Mutex` that guarded the config file
 * (`server.go:49`), `listSiteGroups` walked the profiles (`:1436-1481`),
 * `pushSummaries` reached into the warm `__all__` entry to resolve
 * environment names and domains (`:1534-1588`), and `deployNewViewFromRequest`
 * did the same to find one site (`:920-957`). Every one of those was a method on
 * the HTTP server, so none could be exercised without one.
 *
 * **What HQ does instead.** A value with six methods and no HTTP in sight. Node
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
 * {@link SitesService.refreshWarm} exposes an atomic warm-only refresh.
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
import { asCliError, CliError } from "../../errors.js";
import type { HostingClientFactory } from "../../hosting/factory.js";
import type { HostingEnvironment, HostingSite } from "../../hosting/types.js";
import type {
  SiteInventorySnapshot,
  SiteProfileListing,
} from "../../site-profiles.js";
import { ALL_PROFILES_SENTINEL, MANUAL_PROFILES_SENTINEL } from "../signals.js";

/** Five minutes — Go's `sitesCacheTTL` (`server.go:49`), unchanged. */
export const SITES_CACHE_TTL_MS = 300_000;

/** One hosting profile's sites, or the reason they could not be listed. */
export interface SiteGroup {
  readonly profile: string;
  readonly provider: ProviderKind;
  readonly sites: readonly HostingSite[];
  /** A message, never a `CliError`: `details` must not reach a rendered page. */
  readonly error?: string;
  /** True when `sites` is the last successful listing after this provider failed. */
  readonly stale?: boolean;
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
  /** The same site-CLI round used to compute `connections`. */
  readonly siteProfiles: SiteProfileListing;
}

/** Go's `envDisplay` (`server.go:1534-1552`). */
export interface EnvDisplay {
  readonly name: string;
  readonly domain: string;
}

/**
 * Go's `resolve` closure inside `pushSummaries`: the warm inventory's name
 * and domain for an environment's full ownership tuple, falling back to the
 * name stored on the push and then to the raw id.
 */
export interface EnvResolution {
  readonly profile: string;
  readonly siteId: string;
  readonly envId: string;
  readonly storedName: string;
}

export type EnvResolver = (resolution: EnvResolution) => EnvDisplay;

/** One site found in the warm cache, for the new-push page. */
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
  snapshot(profile: string, includeEnvs: boolean): SitesResult | undefined;
  verifyConnections(
    profile: string,
    includeEnvs: boolean,
  ): Promise<SitesResult>;
  /** List, from the cache when it is warm and `refresh` is false. */
  list(options: SitesListOptions): Promise<SitesResult>;
  /** The warm cache only — never triggers a provider call. */
  warm(profile: string, includeEnvs: boolean): SitesResult | undefined;
  /** Refresh local CLI state for a still-current warm entry, without providers. */
  refreshWarm(
    profile: string,
    includeEnvs: boolean,
  ): Promise<SitesResult | undefined>;
  /** Drop everything. Go's `clearSitesCacheLocked`, on any provider mutation. */
  invalidate(): void;
  /** Owned environment → name and domain, from the warm `__all__` inventory. */
  envResolver(): EnvResolver;
  /**
   * Find one site in the warm cache, trying `{profile, envs}` then
   * `{__all__, envs}` — Go's `deployNewViewFromRequest` order (`server.go:931`).
   */
  resolveSite(profile: string, siteId: string): ResolvedSite | undefined;
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
  siteInventory?(
    queries: readonly ConnectionQuery[],
  ): Promise<SiteInventorySnapshot>;
  connectionStates(
    queries: readonly ConnectionQuery[],
  ): Promise<ConnectionSnapshot>;
  listProfiles?(): Promise<SiteProfileListing>;
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
 * `("a\01", false)` cannot collide the way a `:` separator would allow.
 *
 * The separator is written `\u0000` rather than as a raw byte. A literal NUL
 * makes this whole file binary to `grep` and `rg`, which then skip it in
 * silence — a repository-wide search for `listSites` does not find the call
 * in `loadGroup` below.
 */
function cacheKey(profile: string, includeEnvs: boolean): string {
  return `${includeEnvs ? "1" : "0"}\u0000${profile}`;
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
  const snapshots = new Map<string, SitesResult>();
  const inFlight = new Map<number, Map<string, Promise<CacheEntry>>>();
  let generation = 0;

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
    previousGroups: readonly SiteGroup[],
  ): Promise<{
    readonly groups: readonly SiteGroup[];
    readonly usedSnapshot: boolean;
  }> => {
    if (
      profile === ALL_PROFILES_SENTINEL ||
      profile === MANUAL_PROFILES_SENTINEL
    ) {
      // Sequential, as Go's loop was: a dashboard that fans out across twelve
      // provider APIs at once is how an operator finds their rate limit.
      const groups: SiteGroup[] = [];
      const previousByProfile = new Map(
        previousGroups.map((group) => [group.profile, group]),
      );
      let usedSnapshot = false;
      for (const entry of await options.store.listHostingProfiles()) {
        try {
          groups.push(await loadGroup(entry, includeEnvs));
        } catch (error) {
          const previous = previousByProfile.get(entry.name);
          if (previous?.provider === entry.profile.provider) {
            usedSnapshot = true;
            groups.push({
              profile: entry.name,
              provider: entry.profile.provider,
              sites: previous.sites,
              error: asCliError(error).message,
              stale: true,
            });
          } else {
            groups.push({
              profile: entry.name,
              provider: entry.profile.provider,
              sites: [],
              error: asCliError(error).message,
            });
          }
        }
      }
      return { groups, usedSnapshot };
    }
    // One named profile: a failure has nothing left to render, so it propagates
    // and becomes the page-level notice (Go, `server.go:1458-1460`).
    const entry = await options.store.requireHostingProfile(profile);
    return {
      groups: [await loadGroup(entry, includeEnvs)],
      usedSnapshot: false,
    };
  };

  /** Fill the cache, collapsing concurrent loads of one key into one round. */
  const fill = (
    key: string,
    profile: string,
    includeEnvs: boolean,
    startedGeneration: number,
  ): Promise<CacheEntry> => {
    const generationWork =
      inFlight.get(startedGeneration) ?? new Map<string, Promise<CacheEntry>>();
    inFlight.set(startedGeneration, generationWork);
    const pending = generationWork.get(key);
    if (pending !== undefined) return pending;
    const started = (async (): Promise<CacheEntry> => {
      const previous = snapshots.get(key);
      const loaded = await loadGroups(
        profile,
        includeEnvs,
        previous?.groups ?? [],
      );
      const refreshedAt = options.now();
      // The page-level timestamp is deliberately conservative: if even one
      // provider used its last-known listing, the inventory as a whole is no
      // newer than the snapshot that supplied it. Healthy providers still get
      // their fresh groups and the failed provider is retried on manual refresh.
      const storedAt = loaded.usedSnapshot
        ? (previous?.storedAt ?? refreshedAt)
        : refreshedAt;
      const entry: CacheEntry = {
        groups: loaded.groups,
        storedAt,
        expiresAt: refreshedAt + ttlMs,
      };
      if (startedGeneration === generation) cache.set(key, entry);
      return entry;
    })();
    const tracked = started.finally(() => {
      generationWork.delete(key);
      if (generationWork.size === 0) inFlight.delete(startedGeneration);
    });
    generationWork.set(key, tracked);
    return tracked;
  };

  const refreshInventory = async (
    groups: readonly SiteGroup[],
  ): Promise<SiteInventorySnapshot> => {
    const queries: ConnectionQuery[] = [];
    for (const group of groups) {
      for (const site of group.sites) {
        for (const env of site.environments ?? []) {
          const key = connectionKey(group.profile, site.id, env.id);
          queries.push({
            key,
            // Most specific first. They are heterogeneous by provider — a bare
            // hostname or a full URL — and `src/integration/origin.ts`
            // normalizes them, so nothing here parses a URL.
            origins: [env.primaryDomain, site.primaryDomain].filter(nonEmpty),
          });
        }
      }
    }
    try {
      const inventory =
        options.integration.siteInventory === undefined
          ? {
              connections: await options.integration.connectionStates(queries),
              profiles:
                options.integration.listProfiles === undefined
                  ? {
                      profiles: [],
                      checkedAt: options.now(),
                      cliAvailable: true,
                    }
                  : await options.integration.listProfiles(),
            }
          : await options.integration.siteInventory(queries);
      return inventory;
    } catch {
      // See this file's header: an empty map with `cliAvailable: false` renders
      // as "Unknown" plus the install hint, which is the honest degradation. An
      // empty map with `cliAvailable: true` would claim "Not connected".
      const checkedAt = options.now();
      return {
        connections: {
          byKey: new Map<string, ConnectionResult>(),
          checkedAt,
          cliAvailable: false,
        },
        profiles: {
          profiles: [],
          checkedAt,
          cliAvailable: false,
          reason: "cli_failed",
        },
      };
    }
  };

  const resultFrom = (
    profile: string,
    includeEnvs: boolean,
    entry: CacheEntry,
    cached: boolean,
    inventory: SiteInventorySnapshot,
  ): SitesResult => ({
    profile,
    includeEnvs,
    cached,
    storedAt: entry.storedAt,
    expiresAt: entry.expiresAt,
    groups: entry.groups,
    connections: queriesExist(entry.groups) ? inventory.connections : null,
    siteProfiles: inventory.profiles,
  });

  const queriesExist = (groups: readonly SiteGroup[]): boolean =>
    groups.some((group) =>
      group.sites.some((site) => (site.environments?.length ?? 0) > 0),
    );

  /** The warm `__all__` inventory every push resolution reads. */
  const warmAll = (): CacheEntry | undefined =>
    read(cacheKey(ALL_PROFILES_SENTINEL, true));

  return {
    snapshot: (profile, includeEnvs) =>
      snapshots.get(cacheKey(profile, includeEnvs)),
    verifyConnections: async (profile, includeEnvs) => {
      const key = cacheKey(profile, includeEnvs);
      const previous = snapshots.get(key);
      const startedGeneration = generation;
      const inventory = await refreshInventory(previous?.groups ?? []);
      if (generation !== startedGeneration || snapshots.get(key) !== previous)
        throw new CliError(
          "conflict",
          "Inventory changed during the connection check. Check connections again.",
        );
      const result: SitesResult = {
        profile,
        includeEnvs,
        cached: true,
        storedAt: previous?.storedAt ?? null,
        expiresAt: previous?.expiresAt ?? 0,
        groups: previous?.groups ?? [],
        connections: inventory.connections,
        siteProfiles: inventory.profiles,
      };
      snapshots.set(key, result);
      return result;
    },
    list: async (request) => {
      const key = cacheKey(request.profile, request.includeEnvs);
      for (;;) {
        const startedGeneration = generation;
        const warmEntry = request.refresh ? undefined : read(key);
        let entry: CacheEntry;
        try {
          entry =
            warmEntry ??
            (await fill(
              key,
              request.profile,
              request.includeEnvs,
              startedGeneration,
            ));
        } catch (error) {
          if (startedGeneration !== generation) continue;
          throw error;
        }
        if (startedGeneration !== generation) continue;
        const inventory = await refreshInventory(entry.groups);
        if (startedGeneration !== generation || read(key) !== entry) continue;
        const result = resultFrom(
          request.profile,
          request.includeEnvs,
          entry,
          warmEntry !== undefined,
          inventory,
        );
        snapshots.set(key, result);
        return result;
      }
    },

    warm: (profile, includeEnvs) => {
      const entry = read(cacheKey(profile, includeEnvs));
      return entry === undefined
        ? undefined
        : resultFrom(profile, includeEnvs, entry, true, {
            connections: {
              byKey: new Map(),
              checkedAt: options.now(),
              cliAvailable: false,
            },
            profiles: {
              profiles: [],
              checkedAt: options.now(),
              cliAvailable: false,
              reason: "cli_failed",
            },
          });
    },

    refreshWarm: async (profile, includeEnvs) => {
      const key = cacheKey(profile, includeEnvs);
      for (;;) {
        const startedGeneration = generation;
        const entry = read(key);
        if (entry === undefined) return undefined;
        const inventory = await refreshInventory(entry.groups);
        if (startedGeneration !== generation || read(key) !== entry) continue;
        const result = resultFrom(profile, includeEnvs, entry, true, inventory);
        snapshots.set(key, result);
        return result;
      }
    },

    invalidate: () => {
      generation += 1;
      cache.clear();
      snapshots.clear();
    },

    envResolver: () => {
      const known = new Map<string, Map<string, Map<string, EnvDisplay>>>();
      const pleskInstallations = new Map<string, Map<string, EnvDisplay>>();
      for (const group of warmAll()?.groups ?? []) {
        for (const site of group.sites) {
          for (const env of site.environments ?? []) {
            const bySite =
              known.get(group.profile) ??
              new Map<string, Map<string, EnvDisplay>>();
            known.set(group.profile, bySite);
            const byEnv = bySite.get(site.id) ?? new Map<string, EnvDisplay>();
            bySite.set(site.id, byEnv);
            const display = {
              name: displayLabel(env.displayName, env.name, env.id),
              domain: env.primaryDomain ?? "",
            };
            byEnv.set(env.id, display);
            if (group.provider === "plesk" && env.id.startsWith("wp:")) {
              const byInstallation =
                pleskInstallations.get(group.profile) ??
                new Map<string, EnvDisplay>();
              pleskInstallations.set(group.profile, byInstallation);
              byInstallation.set(env.id, display);
            }
          }
        }
      }
      return ({ profile, siteId, envId, storedName }) => {
        const found =
          known.get(profile)?.get(siteId)?.get(envId) ??
          pleskInstallations.get(profile)?.get(envId);
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
          if (group.profile !== profile) continue;
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
  };
}
