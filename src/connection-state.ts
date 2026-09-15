// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Is this WordPress environment connected to Novamira?" — the vocabulary, and
 * nothing else.
 *
 * **Why a module at the repository root.** `src/integration/` computes this
 * answer and `src/web/` renders it, and the two are **peer layers**: neither may
 * import the other. Until 6b they coped by declaring the same five types twice,
 * member for member (`integration/connection.ts` and `web/views/types.ts`), and
 * both files carried a comment promising to collapse them "into whichever module
 * both can import". That module is this one: the root layer that already holds
 * `src/errors.ts` and `src/json.ts`, whose defining property is that it imports
 * nothing at all. Keep it that way — a single import here would become an edge
 * between two layers that are supposed to have none.
 *
 * **What lives here and what does not.** The union, its query and snapshot
 * shapes, and the fixed operator-facing sentence per `UnavailableReason` — the
 * hints are here because the dashboard renders them (a `title=` on a disabled
 * Connect button, a pill tooltip) and the integration returns the reason that
 * selects them, so they are shared vocabulary rather than either side's private
 * business. What stays in `src/integration/` is everything that *acts*:
 * `integrationUnavailableError` (it builds a `CliError`, which is HQ's own
 * taxonomy, not a connection state), the resolver, the spawn seam and the
 * two-stage algorithm.
 *
 * `SITE_CLI_OVERRIDE_ENV` moved down here with the hint that names it, so the
 * variable's spelling has exactly one definition; `src/integration/resolve.ts`
 * re-exports it and remains the only module that *reads* it.
 *
 * **The boundary rule, restated.** Nothing in this file describes a credential,
 * a token, a site profile or a REST route. A `ConnectionResult` carries a state,
 * a list of *site-CLI profile names*, and one member of a closed reason enum. It
 * cannot carry a message, child output, a path or a secret, and that is
 * structural rather than a convention: there is no field for one.
 */

/* -------------------------------------------------------------------------- */
/* The state union                                                            */
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
 *
 * Go answered the same question with `novamiraLinkedToEnv`, a *boolean* derived
 * from a `site_profiles` entry HQ deliberately no longer holds — and wrong in
 * both directions, because `novamira auth logout` removes the credential and
 * keeps the profile.
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
  | "site_incompatible"
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
  /**
   * Candidate values for the environment's public address, most specific
   * first — typically `env.primaryDomain` and then `site.primaryDomain`. They
   * are heterogeneous by provider (bare hostname or full URL) and are
   * normalized by the integration, never by the caller.
   */
  readonly origins: readonly string[];
}

export interface ConnectionSnapshot {
  readonly byKey: ReadonlyMap<string, ConnectionResult>;
  /** Unix milliseconds; `relative-time.js` renders it from `data-checked-at`. */
  readonly checkedAt: number;
  readonly cliAvailable: boolean;
}

/**
 * What the **Connect** action did.
 *
 * It lives beside the state union for the same reason the union does:
 * `src/integration/` produces it and `src/web/server.ts` declares the
 * integration's shape structurally, and the two are peers. The failure arm
 * carries a reason enum and *nothing else* — no message, no child output — so
 * that a view has only {@link unavailableHint} to render and cannot accidentally
 * put a subprocess's stderr on the page.
 */
export type ConnectOutcome =
  | { readonly kind: "connected" }
  | { readonly kind: "failed"; readonly reason: UnavailableReason };

/**
 * The result for an environment nothing matched.
 *
 * Frozen and shared: it is the default a renderer reaches for when a key is
 * absent from a snapshot, and both sides used to mint their own.
 */
export const NOT_CONFIGURED_CONNECTION: ConnectionResult = Object.freeze({
  state: "not_configured" as const,
  profiles: Object.freeze([]),
});

/* -------------------------------------------------------------------------- */
/* Hints                                                                      */
/* -------------------------------------------------------------------------- */

/** HQ's own override for the site CLI executable. Never the site CLI's own. */
export const SITE_CLI_OVERRIDE_ENV = "NOVAMIRA_HQ_SITE_CLI";

/**
 * What an operator is told when the site CLI is not there at all.
 *
 * `CLAUDE.md` requires the dashboard to "disable connected-state detection with
 * an install hint" rather than to fail, so this sentence is a product surface,
 * not a diagnostic.
 */
export const SITE_CLI_INSTALL_HINT =
  "Install the Novamira site CLI (npm install -g @novamira/cli) to see connection state, " +
  `or set ${SITE_CLI_OVERRIDE_ENV} to its executable.`;

/**
 * A fixed, non-secret sentence per reason. Exhaustive over the union, so a new
 * reason cannot ship without one. Nothing here interpolates child output — that
 * is the whole point of answering with a reason enum instead of a message.
 */
const UNAVAILABLE_HINTS: Readonly<Record<UnavailableReason, string>> = {
  cli_absent: SITE_CLI_INSTALL_HINT,
  cli_incompatible:
    "Update the Novamira site CLI: the installed version does not support the commands Novamira HQ uses.",
  cli_timeout: "The Novamira site CLI did not answer in time; try again.",
  cli_failed:
    "The Novamira site CLI could not be run; check the installation and try again.",
  malformed_output:
    "The Novamira site CLI returned output Novamira HQ could not read; check that its version is current.",
  output_truncated:
    "The Novamira site CLI returned more output than Novamira HQ reads; check that its version is current.",
  deadline_exceeded:
    "Checking connection state took too long and was stopped; try again.",
  site_unreachable:
    "The site could not be reached to confirm the connection; try again.",
  site_incompatible:
    "The site is not ready for Novamira. The plugin may be missing, inactive or incompatible, or required AI Abilities may be unavailable. Use Setup Novamira when this site belongs to a connected hosting account; otherwise install or update Novamira on the site, then reconnect.",
};

export function unavailableHint(reason: UnavailableReason): string {
  return UNAVAILABLE_HINTS[reason];
}
