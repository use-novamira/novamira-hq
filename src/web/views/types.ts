// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The view models every dashboard page is rendered from.
 *
 * **The rule this file exists to state.** The dashboard renders credential
 * *references* — `credentialSource(ref)` from `src/config/schema.ts`, which
 * spells them `env:NAME`, `file:PATH`, `stored:ID` — and never a secret value. A
 * provider secret travels exactly once, in the body of a local HTTP request,
 * straight to the credential store. It never appears in HTML, in a URL, in a
 * query string, in an SSE frame, in a log, or in an error. {@link ConfigView} is
 * built to make that structural: there is no field on it that could hold one.
 *
 * **What the Go did.** `configResponse` (types.go) carried `Providers`,
 * `DeployPaths`, `SiteProfiles` and `Token` in one struct that handlers passed
 * around, and `statusClass` (views.go:1563-1574) lower-cased an arbitrary
 * `string` level and matched it against four groups of words, defaulting to
 * `neutral`. A level nobody had thought of styled itself silently.
 *
 * **What HQ does instead.** `SiteProfiles` is gone with the rest of the
 * site-profile surface — HQ's schema has no site profiles, so there is nothing
 * to render. {@link NoticeLevel} is a four-member union and
 * {@link statusClass} is an exhaustive lookup over it, so an unmapped level is
 * a compile error rather than a silent `neutral`. The token is not on the view
 * model at all: it reaches the page through `defaultDashboardSignals`, and
 * nothing else may read it.
 *
 * **The connection types moved down.** Go decided "connected" with
 * `novamiraLinkedToEnv`, which matched a hostname against a `site_profiles`
 * entry — a boolean, derived from data HQ deliberately no longer holds, and
 * wrong in both directions (`novamira auth logout` removes the credential and
 * keeps the profile). 6a replaced it with a four-state union that was declared
 * *twice*, here and in `src/integration/connection.ts`, because the two are peer
 * layers. 6b collapsed both copies into `src/connection-state.ts`, the root
 * module both may import, and this file now re-exports them. What stays here is
 * {@link ConnectionView}, which is the *view projection*: state plus the fixed
 * hint a pill or a disabled button renders.
 *
 * **`HostingProfileView.credentialAvailable` is a deliberate departure from
 * Go.** Go's `credentialAvailable` (`server.go:1654-1657`) called
 * `credential.Resolve()`, which for a `stored` reference probes the OS keychain
 * — on **every page render**, once per profile. An operator with twelve profiles
 * would pay twelve keychain round trips per navigation, and on Linux with a
 * locked keyring several of those block. HQ answers cheaply instead:
 *
 * - `env` → the named variable is present and non-empty in the server's injected
 *   `environment` record (no I/O at all);
 * - `file` → `true`; the path is checked when the credential is actually used;
 * - `stored` → `true`; the keychain is probed when the credential is used.
 *
 * The failure mode of a wrong `true` is that the connection cell says "Not
 * checked" instead of "No credential" — and the operator finds out from **Check
 * connection**, which is the button that exists for exactly that. The failure
 * mode of Go's version is a dashboard that stalls on navigation.
 *
 * **`DeployPathView` carries three derived fields, and one imported type.** Go's
 * `deployPathSummary` (`types.go:20-32`) resolved each environment's display
 * name and domain against the warm sites inventory and asked whether the path's
 * provider could push at all; {@link deployPathView} does the same, taking the
 * resolver as a parameter rather than reaching for a cache. That is the one
 * place this module imports from `src/web/services/` — type-only, and in the
 * views → services direction. The reverse is forbidden: a service that imported
 * a view could not be exercised without one.
 */

import {
  SITE_CLI_INSTALL_HINT,
  unavailableHint,
  type ConnectionResult,
  type ConnectionState,
} from "../../connection-state.js";
import type {
  SiteProfileListing,
  SiteProfileState,
  SiteProfileSummary,
} from "../../site-profiles.js";
import {
  credentialSource,
  isProviderKind,
  PROVIDER_KINDS,
  type CredentialRef,
  type DeployPath,
  type HostingProfile,
  type ProviderKind,
} from "../../config/schema.js";
import { DEPLOY_PUSH_PROVIDERS, providerLabel } from "../../hosting/types.js";
// Type-only, and the direction is views → services: a service may never import
// a view. `EnvResolver` is declared where it is produced so that the resolver
// `services/sites.ts` builds and the one `deployPathView` consumes cannot drift.
import type { EnvResolver } from "../services/sites.js";

export type {
  ConnectionQuery,
  ConnectionResult,
  ConnectionSnapshot,
  ConnectionState,
  UnavailableReason,
} from "../../connection-state.js";

export type {
  SiteProfileListing,
  SiteProfileOutcome,
  SiteProfileState,
  SiteProfileSummary,
} from "../../site-profiles.js";

/* -------------------------------------------------------------------------- */
/* Pages and notices                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The routed pages. Seven of them are Go's `currentDashboardPage` return values
 * (server.go:205-222) unchanged; `deploy-path-new` and `novamira-setup` are
 * pages in their own right but highlight another nav link, see `navLink`.
 *
 * `site-profiles` is the one addition, and it has no Go counterpart: Go managed
 * *its own* site profiles from a form on the Sites page, which is deleted under
 * the boundary rule. This page manages the **site CLI's** profiles by running
 * `novamira`, and it is a page rather than a panel on `/sites` because the two
 * listings have different subjects, different costs and different refresh
 * lifetimes — see `views/site-profiles.ts`.
 */
export type DashboardPage =
  | "providers"
  | "sites"
  | "deploy-paths"
  | "deploy-path-new"
  | "novamira-setup"
  | "diagnostics"
  | "settings";

export const DASHBOARD_PAGES: readonly DashboardPage[] = Object.freeze([
  "providers",
  "sites",
  "deploy-paths",
  "deploy-path-new",
  "novamira-setup",
  "diagnostics",
  "settings",
] as const);

export type NoticeLevel = "ok" | "warn" | "danger" | "neutral";

export interface DashboardNotice {
  readonly level: NoticeLevel;
  readonly message: string;
}

/** No notice. An empty message is what suppresses the toast. */
export const EMPTY_NOTICE: DashboardNotice = Object.freeze({
  level: "neutral",
  message: "",
});

const STATUS_CLASSES: Readonly<Record<NoticeLevel, string>> = {
  ok: "ok",
  warn: "warn",
  danger: "danger",
  neutral: "neutral",
};

/** The CSS class for a notice level. Exhaustive; an unmapped level cannot exist. */
export function statusClass(level: NoticeLevel): string {
  return STATUS_CLASSES[level];
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export interface HostingProfileView {
  readonly name: string;
  readonly provider: string;
  /** `env:NAME` / `file:PATH` / `stored:ID`. Never a secret value. */
  readonly credential: string;
  readonly companyId: string | null;
  readonly apiBaseUrl: string | null;
  /**
   * Whether a credential is *plausibly* readable, by the cheap rule documented
   * in this file's header. It is never the credential, and never proof.
   */
  readonly credentialAvailable: boolean;
  /**
   * When this profile last validated successfully, in unix milliseconds, or
   * `null` when it never has in this process.
   *
   * Go's comment at `views.go:425-428` is the reason this is a success-only
   * stamp and must stay one: a timestamp is recorded *only after a check
   * succeeds*, so the row can infer "connected" from a stamp being present. The
   * failure path renders an age without recording it, so the cell shows how
   * stale the failure is without ever claiming a success.
   */
  readonly lastCheckedMillis: number | null;
}

/**
 * The eleven `DeployPath` fields plus the three Go's `deployPathSummary`
 * (`types.go:20-32`) derived; nothing here is sensitive.
 *
 * `sourceEnvName` and `targetEnvName` are **resolved**, not stored: the warm
 * sites inventory's display name wins, the name saved on the deploy path is the
 * fallback, and the raw environment id is the last resort. That is Go's
 * `deployPathSummaries` `resolve` closure (`server.go:1553-1562`), and it is why
 * a path saved before a rename still shows the environment's current name.
 */
export interface DeployPathView {
  readonly name: string;
  readonly hostingProfile: string;
  readonly siteId: string;
  readonly siteLabel: string;
  readonly sourceEnvId: string;
  readonly sourceEnvName: string;
  readonly sourceEnvDomain: string;
  readonly targetEnvId: string;
  readonly targetEnvName: string;
  readonly targetEnvDomain: string;
  readonly pushDb: boolean;
  readonly pushFiles: boolean;
  readonly searchReplace: boolean;
  /** Whether this path's hosting profile can push environments at all. */
  readonly supported: boolean;
}

export interface ConfigView {
  readonly profiles: readonly HostingProfileView[];
  readonly deployPaths: readonly DeployPathView[];
  /** HQ's own version, rendered in the sidebar pill. */
  readonly version: string;
  /** The resolved `config.json` path. A location, never a content. */
  readonly configFile: string;
}

/**
 * A provider's human label, tolerating a value this build does not know.
 *
 * `HostingProfileView.provider` is a `string`, not a `ProviderKind`: it came out
 * of a config file that may have been written by a newer HQ. Go's
 * `providerLabel` had the same tolerance by accident — a map miss returned the
 * zero value and the caller fell back to the raw string — so this states it.
 */
export function providerLabelFor(provider: string): string {
  return (PROVIDER_KINDS as readonly string[]).includes(provider)
    ? providerLabel(provider as ProviderKind)
    : provider;
}

export interface HostingProfileViewContext {
  /** The server's injected environment record; nothing here reads `process.env`. */
  readonly environment: NodeJS.ProcessEnv;
  /** From `services/providers.ts`'s in-memory map; `null` when never checked. */
  readonly lastCheckedMillis: number | null;
}

/**
 * The cheap `credentialAvailable` rule. See this file's header for why it is not
 * `credential.Resolve()`.
 */
function credentialAvailable(
  credential: CredentialRef,
  environment: NodeJS.ProcessEnv,
): boolean {
  switch (credential.type) {
    case "env":
      return (environment[credential.name] ?? "") !== "";
    case "file":
    case "stored":
      return true;
  }
}

export function hostingProfileView(
  name: string,
  profile: HostingProfile,
  context: HostingProfileViewContext,
): HostingProfileView {
  return {
    name,
    provider: profile.provider,
    credential: credentialSource(profile.credential),
    companyId: profile.companyId ?? null,
    apiBaseUrl: profile.apiBaseUrl ?? null,
    credentialAvailable: credentialAvailable(
      profile.credential,
      context.environment,
    ),
    lastCheckedMillis: context.lastCheckedMillis,
  };
}

/**
 * Whether a provider can push one environment onto another.
 *
 * The argument is a `string` for the same reason {@link providerLabelFor}'s is:
 * it came out of a config file a newer HQ may have written. An unknown provider
 * is not deploy-capable, which is the safe answer — the Deploy button stays
 * disabled rather than promising something no client implements.
 */
export function deployPushSupported(provider: string): boolean {
  return isProviderKind(provider) && DEPLOY_PUSH_PROVIDERS.has(provider);
}

export interface DeployPathViewContext {
  /** From `services/sites.ts`; resolves an environment id against the warm cache. */
  readonly resolve: EnvResolver;
  /** From {@link deployPushSupported} over the path's hosting profile. */
  readonly supported: boolean;
}

export function deployPathView(
  path: DeployPath,
  context: DeployPathViewContext,
): DeployPathView {
  const source = context.resolve(path.sourceEnvId, path.sourceEnvName);
  const target = context.resolve(path.targetEnvId, path.targetEnvName);
  return {
    name: path.name,
    hostingProfile: path.hostingProfile,
    siteId: path.siteId,
    siteLabel: path.siteLabel,
    sourceEnvId: path.sourceEnvId,
    sourceEnvName: source.name,
    sourceEnvDomain: source.domain,
    targetEnvId: path.targetEnvId,
    targetEnvName: target.name,
    targetEnvDomain: target.domain,
    pushDb: path.pushDb,
    pushFiles: path.pushFiles,
    searchReplace: path.searchReplace,
    supported: context.supported,
  };
}

/* -------------------------------------------------------------------------- */
/* Connection state, as a view                                                */
/* -------------------------------------------------------------------------- */

/**
 * One environment's connection state, projected for rendering.
 *
 * It differs from {@link ConnectionResult} in exactly one way, and the
 * difference is the point: a `ConnectionResult` carries a *reason enum*, and a
 * `ConnectionView` carries the fixed sentence that reason selects. Views never
 * call `unavailableHint` themselves — {@link connectionView} is the one place it
 * is called from `src/web/` — so there is a single place to check that no child
 * output, no error message and no path can reach a `title=` attribute.
 */
export interface ConnectionView {
  readonly state: ConnectionState;
  readonly profiles: readonly string[];
  /** Present only for `unavailable`: a fixed, non-secret install or retry hint. */
  readonly hint?: string;
}

/**
 * Project one result, honouring the "site CLI absent" degradation.
 *
 * `CLAUDE.md` requires that when `novamira` is missing the dashboard "disables
 * connected-state detection with an install hint" — not that it reports every
 * environment as not connected, which would be a *wrong answer* rather than a
 * degraded one. So `cliAvailable === false` forces `unavailable` with
 * {@link SITE_CLI_INSTALL_HINT}, whatever the per-key result says, and the
 * per-environment Connect buttons render disabled with the same sentence.
 */
export function connectionView(
  result: ConnectionResult,
  cliAvailable: boolean,
): ConnectionView {
  if (!cliAvailable) {
    return {
      state: "unavailable",
      profiles: result.profiles,
      hint: SITE_CLI_INSTALL_HINT,
    };
  }
  if (result.state === "unavailable") {
    return {
      state: "unavailable",
      profiles: result.profiles,
      hint:
        result.reason === undefined
          ? SITE_CLI_INSTALL_HINT
          : unavailableHint(result.reason),
    };
  }
  return { state: result.state, profiles: result.profiles };
}

/* -------------------------------------------------------------------------- */
/* Site-CLI profiles, as a view                                               */
/* -------------------------------------------------------------------------- */

/**
 * One site-CLI profile, projected for rendering.
 *
 * It stands to {@link SiteProfileSummary} exactly as {@link ConnectionView}
 * stands to {@link ConnectionResult}: the model carries a *reason enum* and the
 * view carries the fixed sentence that reason selects. Both projections live
 * here for one reason — this is the only module under `src/web/` that calls
 * `unavailableHint`, so there is a single place to check that no child output,
 * no error message and no path can reach a `title=` attribute.
 *
 * `origin` is not projected: it exists so the integration can match a profile
 * against a hosting domain, and a panel that showed both it and `siteUrl` would
 * be showing the same address twice.
 */
export interface SiteProfileRowView {
  readonly name: string;
  readonly siteUrl: string;
  readonly state: SiteProfileState;
  /** ISO-8601, straight from the site CLI. Rendered as text, never parsed. */
  readonly expiresAt?: string;
  /** Present only for `unknown` and `unreachable`: a fixed, non-secret sentence. */
  readonly hint?: string;
}

/** Why one row cannot say more than "Unknown". */
const UNREACHABLE_HINT = unavailableHint("site_unreachable");

export function siteProfileRowView(
  summary: SiteProfileSummary,
): SiteProfileRowView {
  const expiresAt =
    summary.expiresAt === undefined ? {} : { expiresAt: summary.expiresAt };
  if (summary.state === "unreachable") {
    return {
      name: summary.name,
      siteUrl: summary.siteUrl,
      state: summary.state,
      ...expiresAt,
      hint: UNREACHABLE_HINT,
    };
  }
  if (summary.state === "unknown") {
    return {
      name: summary.name,
      siteUrl: summary.siteUrl,
      state: summary.state,
      ...expiresAt,
      hint:
        summary.reason === undefined
          ? SITE_CLI_INSTALL_HINT
          : unavailableHint(summary.reason),
    };
  }
  return {
    name: summary.name,
    siteUrl: summary.siteUrl,
    state: summary.state,
    ...expiresAt,
  };
}

/**
 * Why the *listing* could not be trusted, or `undefined` when it can.
 *
 * `cliAvailable: false` wins over the recorded reason, for the same reason
 * {@link connectionView} lets it win: `CLAUDE.md` requires a missing
 * `@novamira/cli` to disable the feature with an install hint rather than to
 * report an empty list, which would be a wrong answer rather than a degraded
 * one.
 */
export function siteProfilesHint(
  listing: SiteProfileListing,
): string | undefined {
  if (!listing.cliAvailable) return SITE_CLI_INSTALL_HINT;
  return listing.reason === undefined
    ? undefined
    : unavailableHint(listing.reason);
}
