// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Which site profiles does the operator's `novamira` hold, and what shape are
 * they in?" — the vocabulary, and nothing else.
 *
 * **Why a second module at the repository root.** `src/connection-state.ts`
 * answers a question about a *hosting environment*: given a domain the provider
 * reported, is Novamira connected there? This module answers a question about
 * the *site CLI's own configuration*: what is in `novamira sites list`, and what
 * can be done to each entry. They are different questions with different
 * subjects, so they are different types — a {@link SiteProfileSummary} is keyed
 * by a profile name and carries a URL, where a `ConnectionResult` is keyed by a
 * provider environment and deliberately cannot carry one.
 *
 * It lives at the root for the same reason its sibling does: `src/integration/`
 * computes these values and `src/web/` renders them, and the two are **peer
 * layers** that may share only a root module. It imports exactly one thing —
 * {@link UnavailableReason}, from that sibling — because the ways HQ can fail to
 * reach the site CLI are the same ways whichever question it was asking.
 *
 * **The boundary rule, restated for this surface.** Managing a site profile is
 * something HQ asks the *site CLI* to do, in the site CLI's own process, under
 * the site CLI's own credentials. HQ passes a profile name or a non-secret URL
 * on an argv array and reads the v1 envelope's `ok`. Nothing here describes a
 * token, a refresh token, a client secret or an Application Password, and there
 * is no field one could be put in: {@link SiteProfileSummary} carries a name, a
 * URL, an origin, a state and — at most — the *time* a credential expires.
 *
 * **`expiresAt` is a time, not a credential.** It is the one field on this type
 * that comes out of the site CLI's credential record, and it is carried because
 * it is the fact an operator needs in order to decide whether to reconnect
 * before a deploy. It is an ISO-8601 stamp, opaque to HQ, rendered as text and
 * never parsed for meaning.
 */

import type { UnavailableReason } from "./connection-state.js";

/* -------------------------------------------------------------------------- */
/* The state union                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What HQ can say about one site-CLI profile.
 *
 * It parallels `ConnectionState` without being it, because the subject differs
 * and so does one of the arms:
 *
 * - `connected` — the profile holds a usable credential and the CLI reports the
 *   site's REST surface reachable;
 * - `reconnect_required` — the credential is absent, invalid or expired, or the
 *   site answered with an authentication error;
 * - `unreachable` — the credential looks usable but the site could not be
 *   reached to confirm it. This is split out from `unknown` deliberately: it is
 *   the one failure the operator can act on *without* touching the profile, and
 *   collapsing it into "unknown" would invite a pointless reconnect.
 * - `unknown` — HQ could not tell, because the site CLI failed, timed out, or
 *   answered with a shape HQ does not read. {@link SiteProfileSummary.reason}
 *   says which.
 */
export type SiteProfileState =
  "connected" | "reconnect_required" | "unreachable" | "unknown";

export interface SiteProfileSummary {
  /** The site CLI's profile name; the argument every action takes. */
  readonly name: string;
  readonly siteUrl: string;
  /** The CLI's own normalized origin, used to match against hosting domains. */
  readonly origin: string;
  readonly state: SiteProfileState;
  /** ISO-8601, straight from the CLI. A time, never a credential. */
  readonly expiresAt?: string;
  /** Present only for `unknown`, and it selects the fixed hint. */
  readonly reason?: UnavailableReason;
}

/**
 * One round of `sites list` plus one `auth status` per profile.
 *
 * `cliAvailable: false` with an empty list is "HQ cannot tell", which the panel
 * renders as the install hint — never as "you have no sites", which would be a
 * wrong answer rather than a degraded one. That is the same distinction
 * `ConnectionSnapshot` draws, and for the same reason.
 */
export interface SiteProfileListing {
  readonly profiles: readonly SiteProfileSummary[];
  /** Unix milliseconds; `relative-time.js` renders it from `data-checked-at`. */
  readonly checkedAt: number;
  readonly cliAvailable: boolean;
  /** Why the *listing itself* failed. Absent when the list is trustworthy. */
  readonly reason?: UnavailableReason;
}

/**
 * What one management action did.
 *
 * The failure arm carries a reason enum and *nothing else* — no message, no
 * child output — exactly as `ConnectOutcome` does, so a view has only
 * `unavailableHint(reason)` to render and cannot put a subprocess's stderr on
 * the page. `missing` is separate because "that profile is already gone" is a
 * success from the operator's point of view and a fixed sentence of its own.
 */
export type SiteProfileOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly reason: UnavailableReason };

/* -------------------------------------------------------------------------- */
/* Profile names                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The site CLI's `validateProfileName` grammar (`src/config/profiles.ts`
 * upstream), copied rather than imported because `@novamira/cli` is never a
 * dependency of any kind.
 *
 * HQ checks it for a reason that is not politeness. A profile name becomes an
 * **argv element** of `sites remove <name>` and of `--site <name>`, and
 * commander parses a leading `-` as an option: an unchecked `--help` or
 * `--json` reaching that position would not remove a profile, it would run a
 * different command than the one HQ meant. The grammar's first character class
 * forbids that outright, which is why the check happens before the value can
 * reach an array and not after.
 */
export const SITE_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSiteProfileName(value: string): boolean {
  return SITE_PROFILE_NAME.test(value);
}
