// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Managing the site CLI's own site profiles: list them, sign one out, forget
 * one.
 *
 * **What the Go did.** It managed *its own* site profiles. `site_profiles` was
 * a section of Go's `config.json`, the dashboard had an "Add a site" form that
 * created a WordPress Application Password over the site's REST API and stored
 * it, and `/_dashboard/sites/remove` deleted the entry. Every part of that is
 * deleted under the boundary rule, and none of it is ported: HQ holds no
 * WordPress credential and has no site profiles to manage.
 *
 * **What HQ does instead, and why it is not the same thing.** The profiles this
 * module operates on are the **site CLI's**, and every operation is performed by
 * the site CLI in its own process, under its own credentials. HQ's whole
 * contribution is an argv array and a reading of the v1 envelope's `ok`:
 *
 * - `sites list` — which profiles exist (local; no network);
 * - `auth status --site <name>` — one authenticated round trip *by the child* to
 *   the site, per profile;
 * - `auth logout --site <name>` — the child removes its credential and, when it
 *   can, revokes the refresh token upstream;
 * - `sites remove <name>` — the child deletes the profile.
 *
 * HQ never holds a token, never issues a request to a configured site, never
 * reads the site CLI's configuration, profile store, credential store or
 * keychain records, and never reads or interprets `NOVAMIRA_HOME`. The one
 * argument any of these commands takes is a profile name or a non-secret URL.
 *
 * **The two commands that mutate are still just children.** `logout` and
 * `remove` inherit the same discipline as every other call in this package —
 * `shell: false`, an argv array, a per-child timeout, bounded output, output
 * parsed for `ok` and then discarded. Neither is retried: an operator who
 * pressed a button that timed out should press it again themselves, because a
 * silent retry of "revoke this credential" is a second remote effect nobody
 * asked for.
 *
 * **Every failure is a state, with one exception that is not a failure.**
 * {@link SiteProfileService.listProfiles} resolves for every input and never
 * throws; the two actions resolve to a {@link SiteProfileOutcome} and never
 * throw *for an integration failure*. A profile **name** that does not match
 * the site CLI's grammar throws `usage_error` instead, before anything is
 * spawned: that is a caller passing a value the CLI's argv cannot represent, not
 * the CLI being unreachable, and it must never reach a child — see
 * {@link isSiteProfileName} for the argv-injection reasoning.
 *
 * **Nothing is persisted, nothing is logged.** Child stdout and stderr are
 * parsed and discarded inside each call, and a {@link SiteProfileOutcome}'s
 * failure arm carries a reason enum with nowhere to put a string.
 */

import { CliError } from "../errors.js";
import type { UnavailableReason } from "../connection-state.js";
import {
  isSiteProfileName,
  type SiteProfileListing,
  type SiteProfileOutcome,
  type SiteProfileState,
  type SiteProfileSummary,
} from "../site-profiles.js";
import { childFailure, interpretChildOutcome } from "./classify.js";
import type { ChildResult } from "./classify.js";
import { runPool } from "./pool.js";
import type { ResolveSiteCli, SiteCliResolution } from "./resolve.js";
import {
  authLogoutArgs,
  authStatusArgs,
  parseSitesList,
  siteCliChildEnv,
  sitesListArgs,
  sitesRemoveArgs,
} from "./site-cli.js";
import {
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  type SpawnChild,
} from "./spawn.js";
import { verdictFor } from "./verdict.js";

export type {
  SiteProfileListing,
  SiteProfileOutcome,
  SiteProfileState,
  SiteProfileSummary,
} from "../site-profiles.js";

/**
 * `auth logout` reaches the site's authorization server to revoke a refresh
 * token, so it gets a longer budget than a status query — but a much shorter
 * one than `auth login`, because there is no human in it. Thirty seconds is one
 * network round trip plus slack, not an interactive flow.
 */
export const PROFILE_ACTION_TIMEOUT_MS = 30_000;

export interface SiteProfileServiceOptions {
  readonly spawn: SpawnChild;
  readonly resolve: ResolveSiteCli;
  /** The injected process environment, passed through to each child. */
  readonly environment: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly perChildTimeoutMs?: number;
  readonly overallDeadlineMs?: number;
  /** `logout` and `remove`'s own budget; see {@link PROFILE_ACTION_TIMEOUT_MS}. */
  readonly actionTimeoutMs?: number;
  readonly concurrency?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface SiteProfileService {
  /** One `sites list`, then one `auth status` per profile. Never throws. */
  listProfiles(): Promise<SiteProfileListing>;
  /** `novamira auth logout --site <name>`. */
  logoutProfile(name: string): Promise<SiteProfileOutcome>;
  /** `novamira sites remove <name>`. */
  removeProfile(name: string): Promise<SiteProfileOutcome>;
}

const DONE: SiteProfileOutcome = Object.freeze({ kind: "done" as const });
const MISSING: SiteProfileOutcome = Object.freeze({ kind: "missing" as const });

function failed(reason: UnavailableReason): SiteProfileOutcome {
  return { kind: "failed", reason };
}

/**
 * Refuse a name the site CLI's grammar cannot represent, before it can become
 * an argv element. See {@link isSiteProfileName}: the leading-character rule is
 * what stops a `--json` in this position from running a different command.
 */
function requireProfileName(name: string): string {
  if (!isSiteProfileName(name)) {
    throw new CliError(
      "usage_error",
      "A Novamira site profile name must start with a letter or digit and may contain only letters, digits, '.', '_' and '-'.",
    );
  }
  return name;
}

/** The state one profile's `auth status` verdict projects to. */
function stateFor(result: ChildResult): {
  readonly state: SiteProfileState;
  readonly reason?: UnavailableReason;
  readonly expiresAt?: string;
} {
  const { verdict, status } = verdictFor(result);
  const expiresAt =
    status?.expiresAt === undefined ? {} : { expiresAt: status.expiresAt };
  switch (verdict.kind) {
    case "connected":
      return { state: "connected", ...expiresAt };
    case "reconnect":
      return { state: "reconnect_required", ...expiresAt };
    case "missing":
      // The profile was listed a moment ago and is gone now. Nothing is known
      // about it, and inventing "reconnect" would offer an action against a
      // profile that no longer exists.
      return { state: "unknown", reason: "cli_failed" };
    case "unavailable":
      return verdict.reason === "site_unreachable"
        ? { state: "unreachable", ...expiresAt }
        : { state: "unknown", reason: verdict.reason, ...expiresAt };
  }
}

export function createSiteProfileService(
  options: SiteProfileServiceOptions,
): SiteProfileService {
  const perChildTimeoutMs = options.perChildTimeoutMs ?? 10_000;
  const overallDeadlineMs = options.overallDeadlineMs ?? 20_000;
  const actionTimeoutMs = options.actionTimeoutMs ?? PROFILE_ACTION_TIMEOUT_MS;
  const concurrency = options.concurrency ?? 4;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;

  /** Resolve the executable, or say which way resolution failed. */
  const resolveCli = async (): Promise<
    SiteCliResolution | UnavailableReason
  > => {
    try {
      const resolution = await options.resolve();
      // A probe that answers "nothing here" is an absent CLI; a probe that
      // throws is a failed one. The two get different hints.
      return resolution ?? "cli_absent";
    } catch {
      return "cli_failed";
    }
  };

  const spawnOnce = async (
    cli: SiteCliResolution,
    args: readonly string[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ChildResult> => {
    if (signal.aborted) return childFailure("deadline_exceeded");
    return interpretChildOutcome(
      await options.spawn({
        command: cli.command,
        args: [...cli.prefixArgs, ...args],
        env: siteCliChildEnv(options.environment),
        timeoutMs,
        maxStdoutBytes,
        maxStderrBytes,
        signal,
      }),
    );
  };

  /** One `logout`/`remove`: resolve, spawn once, read `ok`, discard the rest. */
  const runAction = async (
    args: (timeoutMs: number) => readonly string[],
  ): Promise<SiteProfileOutcome> => {
    const cli = await resolveCli();
    if (typeof cli === "string") return failed(cli);
    // The signal is the belt to the child timer's braces, exactly as
    // `connect.ts` does it: one action, one deadline.
    const signal = AbortSignal.timeout(actionTimeoutMs + 1_000);
    const result = await spawnOnce(
      cli,
      args(actionTimeoutMs),
      actionTimeoutMs,
      signal,
    );
    switch (result.kind) {
      case "data":
        // The payload is deliberately not inspected. `ok: true` is the CLI
        // saying it did the thing; anything HQ read out of it would be site
        // state HQ must not hold.
        return DONE;
      case "site_missing":
        return MISSING;
      case "failure":
        return failed(result.reason);
    }
  };

  return {
    listProfiles: async () => {
      const checkedAt = options.now();
      const cli = await resolveCli();
      if (typeof cli === "string") {
        return {
          profiles: [],
          checkedAt,
          cliAvailable: false,
          reason: cli,
        };
      }

      // One deadline for the whole round, shared by every child; the per-child
      // timeout applies too, and whichever fires first wins.
      const signal = AbortSignal.timeout(overallDeadlineMs);

      const listed = await spawnOnce(
        cli,
        sitesListArgs(perChildTimeoutMs),
        perChildTimeoutMs,
        signal,
      );
      if (listed.kind !== "data") {
        // `site_not_found` is meaningless for a command that takes no `--site`;
        // outside stage two it is just another failure.
        const reason =
          listed.kind === "failure" ? listed.reason : ("cli_failed" as const);
        return {
          profiles: [],
          checkedAt,
          cliAvailable: reason !== "cli_absent",
          reason,
        };
      }
      const listing = parseSitesList(listed.data);
      if (listing === undefined) {
        return {
          profiles: [],
          checkedAt,
          cliAvailable: true,
          reason: "malformed_output",
        };
      }

      // One `auth status` per profile, bounded. The listing's order is the
      // CLI's own and is preserved: a panel whose rows reorder between two
      // refreshes is a panel whose buttons move under the cursor.
      const summaries = new Map<string, SiteProfileSummary>();
      await runPool(listing, concurrency, async (profile) => {
        const status = await spawnOnce(
          cli,
          authStatusArgs(perChildTimeoutMs, profile.name),
          perChildTimeoutMs,
          signal,
        );
        summaries.set(profile.name, {
          name: profile.name,
          siteUrl: profile.siteUrl,
          origin: profile.origin,
          ...stateFor(status),
        });
      });

      return {
        profiles: listing.map(
          (profile) =>
            summaries.get(profile.name) ?? {
              name: profile.name,
              siteUrl: profile.siteUrl,
              origin: profile.origin,
              state: "unknown" as const,
              reason: "deadline_exceeded" as const,
            },
        ),
        checkedAt,
        cliAvailable: true,
      };
    },

    logoutProfile: async (name) => {
      const site = requireProfileName(name);
      return runAction((timeoutMs) => authLogoutArgs(timeoutMs, site));
    },

    removeProfile: async (name) => {
      const target = requireProfileName(name);
      return runAction((timeoutMs) => sitesRemoveArgs(timeoutMs, target));
    },
  };
}
