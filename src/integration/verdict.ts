// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "What does one `auth status` answer mean?" — the reading of a single profile's
 * credential state, shared by the two questions that ask it.
 *
 * `connection.ts` asks it per *hosting environment* and aggregates several
 * profiles into one cell; `profiles.ts` asks it per *site-CLI profile* and
 * renders one row each. Both need the identical reading of "usable credential",
 * "authentication error" and "could not reach the site", and a second copy of
 * either table is how the two surfaces would end up disagreeing about the same
 * profile on the same page.
 *
 * The tables are exhaustive by construction: a sixth upstream credential state
 * is a compile error here rather than a silent "connected".
 */

import type { UnavailableReason } from "../connection-state.js";
import type { ChildResult } from "./classify.js";
import { parseAuthStatus, type CredentialState } from "./site-cli.js";
import type { SiteCliAuthStatus } from "./site-cli.js";

/** Whether a credential state can possibly back a connection. */
const CREDENTIAL_USABILITY: Readonly<
  Record<CredentialState, "usable" | "reconnect">
> = {
  absent: "reconnect",
  invalid: "reconnect",
  expired: "reconnect",
  fresh: "usable",
  near_expiry: "usable",
};

/**
 * The site CLI error codes that mean "authorize again", as opposed to "the site
 * could not be reached". Compared as opaque strings: they are the *site CLI's*
 * codes, not HQ's, and an unrecognized one degrades to a reachability failure
 * rather than to a false "reconnect".
 */
const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "auth_required",
  "auth_denied",
  "auth_expired",
  "insufficient_scope",
]);

export type ProfileVerdict =
  | { readonly kind: "connected" }
  | { readonly kind: "reconnect" }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason }
  | { readonly kind: "missing" };

const CONNECTED: ProfileVerdict = Object.freeze({ kind: "connected" as const });
const RECONNECT: ProfileVerdict = Object.freeze({ kind: "reconnect" as const });

export function verdictForStatus(status: SiteCliAuthStatus): ProfileVerdict {
  if (CREDENTIAL_USABILITY[status.credentialState] === "reconnect") {
    return RECONNECT;
  }
  if (status.restReachable === true) return CONNECTED;
  if (status.restReachable === null) {
    // The CLI reports `null` only for `absent`/`invalid`, which the line above
    // has already handled. `null` beside a usable credential is a shape HQ does
    // not know, and guessing either way would be worse than saying so.
    return { kind: "unavailable", reason: "malformed_output" };
  }
  const restError = status.restError;
  if (restError === "server_unsupported")
    return { kind: "unavailable", reason: "site_incompatible" };
  if (restError !== undefined && AUTH_ERROR_CODES.has(restError)) {
    return RECONNECT;
  }
  return { kind: "unavailable", reason: "site_unreachable" };
}

/**
 * The same reading, starting from the child's outcome.
 *
 * The parsed status is returned alongside the verdict because `profiles.ts`
 * renders `expiresAt` from it, and re-parsing the payload at the call site would
 * be a second place the required-field set is spelled out.
 */
export function verdictFor(result: ChildResult): {
  readonly verdict: ProfileVerdict;
  readonly status?: SiteCliAuthStatus;
} {
  switch (result.kind) {
    case "site_missing":
      return { verdict: { kind: "missing" } };
    case "failure":
      return { verdict: { kind: "unavailable", reason: result.reason } };
    case "data": {
      const status = parseAuthStatus(result.data);
      if (status === undefined) {
        return {
          verdict: { kind: "unavailable", reason: "malformed_output" },
        };
      }
      return { verdict: verdictForStatus(status), status };
    }
  }
}
