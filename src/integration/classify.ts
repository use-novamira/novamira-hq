// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How a site-CLI child's outcome becomes an {@link UnavailableReason}, in one
 * place.
 *
 * **Why this is its own module.** In the Go program the equivalent logic did not
 * exist: every call site folded every failure into "not linked". HQ's port put
 * the tables inside `connection.ts`, which was correct while `connectionStates`
 * was the only thing that spawned a child. 6b adds a second one — `connect.ts`'s
 * `novamira auth login` — and it must classify *identically*, or a timed-out
 * login and a timed-out status check would tell the operator different stories
 * about the same failure.
 *
 * `connection.ts` and `connect.ts` are siblings, so neither may own the tables
 * without the other importing it, and importing each other would make a cycle
 * out of two files that are conceptually independent. So the shared half lives
 * here, imports nothing but `spawn.ts`, `site-cli.ts` and the root
 * `connection-state.ts`, and both siblings import it.
 *
 * **The one rule worth restating.** The child's *exit code* is never consulted,
 * in either direction. The v1 envelope on stdout is authoritative for a child
 * that ran, and a killed child carries no meaningful status at all — which is
 * exactly why `spawn.ts` reports `code: null` for every kind but `"exited"`.
 */

import type { UnavailableReason } from "../connection-state.js";
import { parseEnvelope } from "./site-cli.js";
import type { ChildOutcome, ChildOutcomeKind } from "./spawn.js";

/**
 * How a child stopped, mapped to why the answer is unavailable. Exhaustive over
 * every kind except `"exited"`, which is the only kind whose stdout is read.
 */
export const OUTCOME_REASONS: Readonly<
  Record<Exclude<ChildOutcomeKind, "exited">, UnavailableReason>
> = {
  not_found: "cli_absent",
  spawn_failed: "cli_failed",
  timed_out: "cli_timeout",
  aborted: "deadline_exceeded",
  truncated: "output_truncated",
};

/**
 * The site CLI error codes HQ classifies specifically. `usage_error` means the
 * installed CLI does not know the command or the flag — an old version, not a
 * transport failure. `site_required` cannot happen (HQ always passes `--site`
 * where the command takes one), so if it ever does it is an HQ bug and is
 * surfaced rather than hidden. Every other code, including one HQ has never
 * seen, degrades to `cli_failed`.
 */
const ENVELOPE_REASONS: Readonly<Record<string, UnavailableReason>> = {
  usage_error: "cli_incompatible",
  site_required: "cli_failed",
};

/** The site CLI's `error.code` meaning "that profile is not configured here". */
export const PROFILE_GONE_CODE = "site_not_found";

export function envelopeReason(code: string): UnavailableReason {
  return ENVELOPE_REASONS[code] ?? "cli_failed";
}

/**
 * What one child produced, as far as HQ is concerned.
 *
 * `site_missing` is stage two's case only: the profile vanished between
 * `sites list` and `auth status`.
 */
export type ChildResult =
  | { readonly kind: "data"; readonly data: unknown }
  | {
      readonly kind: "failure";
      readonly reason: UnavailableReason;
      /** Fixed envelope code only; child messages and output never cross here. */
      readonly code?: string;
    }
  | { readonly kind: "site_missing" };

export function childFailure(reason: UnavailableReason): ChildResult {
  return { kind: "failure", reason };
}

/** Turn a raw {@link ChildOutcome} into the three-way answer above. */
export function interpretChildOutcome(outcome: ChildOutcome): ChildResult {
  if (outcome.kind !== "exited") {
    return childFailure(OUTCOME_REASONS[outcome.kind]);
  }
  const envelope = parseEnvelope(outcome.stdout);
  if (envelope.ok === "malformed") return childFailure("malformed_output");
  if (envelope.ok) return { kind: "data", data: envelope.data };
  if (envelope.code === PROFILE_GONE_CODE) return { kind: "site_missing" };
  return {
    kind: "failure",
    reason: envelopeReason(envelope.code),
    code: envelope.code,
  };
}
