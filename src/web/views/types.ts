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
 * **The connection types.** Go decided "connected" with `novamiraLinkedToEnv`,
 * which matched a hostname against a `site_profiles` entry — a boolean, derived
 * from data HQ deliberately no longer holds, and wrong in both directions
 * (`novamira auth logout` removes the credential and keeps the profile). They
 * are replaced here by a four-state union and are, by design, *view* types: an
 * unreachable site CLI is a connection state, never a hosting error.
 *
 * They are declared here rather than imported because `src/web/` and
 * `src/integration/` are peer layers — neither may depend on the other — and 6a
 * needs the union to type the server's optional integration dependency before a
 * page ever consumes it. `SiteCliIntegration`'s own `ConnectionState`,
 * `UnavailableReason`, `ConnectionResult`, `ConnectionQuery` and
 * `ConnectionSnapshot` are these declarations member for member, so the two
 * satisfy each other structurally; when 6b wires the provider table to the
 * integration it should collapse them into whichever module both can import.
 */

import {
  credentialSource,
  type DeployPath,
  type HostingProfile,
} from "../../config/schema.js";

/* -------------------------------------------------------------------------- */
/* Pages and notices                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The seven routed pages, and Go's `currentDashboardPage` return values
 * (server.go:205-222) unchanged. `deploy-path-new` and `novamira-setup` are
 * pages in their own right but highlight another nav link; see `navLink`.
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
}

/** The eleven `DeployPath` fields, verbatim; nothing here is sensitive. */
export interface DeployPathView {
  readonly name: string;
  readonly hostingProfile: string;
  readonly siteId: string;
  readonly siteLabel: string;
  readonly sourceEnvId: string;
  readonly sourceEnvName: string;
  readonly targetEnvId: string;
  readonly targetEnvName: string;
  readonly pushDb: boolean;
  readonly pushFiles: boolean;
  readonly searchReplace: boolean;
}

export interface ConfigView {
  readonly profiles: readonly HostingProfileView[];
  readonly deployPaths: readonly DeployPathView[];
  /** HQ's own version, rendered in the sidebar pill. */
  readonly version: string;
  /** The resolved `config.json` path. A location, never a content. */
  readonly configFile: string;
}

export function hostingProfileView(
  name: string,
  profile: HostingProfile,
): HostingProfileView {
  return {
    name,
    provider: profile.provider,
    credential: credentialSource(profile.credential),
    companyId: profile.companyId ?? null,
    apiBaseUrl: profile.apiBaseUrl ?? null,
  };
}

export function deployPathView(path: DeployPath): DeployPathView {
  return {
    name: path.name,
    hostingProfile: path.hostingProfile,
    siteId: path.siteId,
    siteLabel: path.siteLabel,
    sourceEnvId: path.sourceEnvId,
    sourceEnvName: path.sourceEnvName,
    targetEnvId: path.targetEnvId,
    targetEnvName: path.targetEnvName,
    pushDb: path.pushDb,
    pushFiles: path.pushFiles,
    searchReplace: path.searchReplace,
  };
}

/* -------------------------------------------------------------------------- */
/* Connection state                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The four answers to "is this environment connected to Novamira?".
 *
 * - `not_configured` — no site-CLI profile matches the environment's origin;
 * - `connected` — a matching profile holds a usable credential and the site CLI
 *   reports its REST surface reachable;
 * - `reconnect_required` — every matching profile reports an absent, invalid or
 *   expired credential, or an authentication error;
 * - `unavailable` — the site CLI is missing or incompatible, a child timed out,
 *   its output was malformed, or reachability could not be established because
 *   of a network or server failure.
 */
export type ConnectionState =
  "not_configured" | "connected" | "reconnect_required" | "unavailable";

export type UnavailableReason =
  | "cli_absent"
  | "cli_incompatible"
  | "cli_timeout"
  | "cli_failed"
  | "malformed_output"
  | "output_truncated"
  | "deadline_exceeded"
  | "site_unreachable";

export interface ConnectionResult {
  readonly state: ConnectionState;
  /** Matching profile names; empty for `not_configured` and most `unavailable`. */
  readonly profiles: readonly string[];
  readonly reason?: UnavailableReason;
}

export interface ConnectionQuery {
  /** The caller's own key for finding its result again, e.g. `${site}/${env}`. */
  readonly key: string;
  readonly origins: readonly string[];
}

export interface ConnectionSnapshot {
  readonly byKey: ReadonlyMap<string, ConnectionResult>;
  /** Unix milliseconds; `relative-time.js` renders it from `data-checked-at`. */
  readonly checkedAt: number;
  readonly cliAvailable: boolean;
}

export interface ConnectionView {
  readonly state: ConnectionState;
  readonly profiles: readonly string[];
  /** Present only for `unavailable`: a fixed, non-secret install or retry hint. */
  readonly hint?: string;
}
