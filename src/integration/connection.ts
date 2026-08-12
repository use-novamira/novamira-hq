// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Is this hosting environment connected to Novamira?" — the two-stage answer.
 *
 * **What the Go did.** `novamiraLinkedToEnv` (views.go) normalized the
 * environment's hostname, walked the operator's `site_profiles`, and returned a
 * *boolean*. Two things are wrong with that beyond the schema it reads. First,
 * HQ has no site profiles and never will: a profile is a thing the site CLI
 * owns, and holding one here would mean holding a site token. Second, and worse
 * for an operator, a profile is not a connection — `novamira auth logout`
 * removes the credential and keeps the profile, so Go's boolean answered "yes"
 * for a site nothing can talk to, and the dashboard's only offer was a button
 * that would fail.
 *
 * **What HQ does instead.** Four states, derived from the site CLI's own
 * answers rather than from stored data:
 *
 * - `not_configured` — no profile's origin matches the environment;
 * - `connected` — a matching profile holds a `fresh` or `near_expiry`
 *   credential *and* the CLI reports the site's REST surface reachable;
 * - `reconnect_required` — every matching profile reports an absent, invalid or
 *   expired credential, or an authentication error;
 * - `unavailable` — the CLI is missing or incompatible, a child timed out, its
 *   output was malformed, or reachability could not be established because of a
 *   network or server failure.
 *
 * The algorithm is two stages because the cheap question and the expensive one
 * are different questions. Stage one is a single `sites list`: local, no
 * network, and it answers "which profiles could possibly be this environment?".
 * Only for the profiles that actually matched does stage two run
 * `auth status`, which costs a real authenticated round trip *to the site* —
 * made by the child CLI, under the child's own credential. HQ still holds no
 * token and issues no request, so the boundary rule holds; but that round trip
 * is why the bounded concurrency, the per-child timeout and the overall
 * deadline below are load-bearing rather than decorative.
 *
 * **Every failure is a state, never an exception.** `connectionStates` resolves
 * for every input; nothing in this module throws, and an unreachable site CLI
 * is never a hosting error. {@link integrationUnavailableError} exists so a
 * view can *carry* an `integration_unavailable` `CliError` with its hint into a
 * view model — it is constructed, never raised.
 *
 * **Nothing is persisted and nothing is logged.** Child stdout and stderr are
 * parsed and discarded inside this call. A `ConnectionResult` carries a profile
 * name and one member of a fixed reason enum, and can carry nothing else — no
 * message, no output, no path.
 *
 * **No cache.** Go kept a five-minute TTL (`sitesCacheTTL`, server.go:48); that
 * is a page concern and belongs with the page that owns it (6b's
 * `src/web/services/sites.ts`).
 *
 * **Two pieces moved down to leaves, and one service moved out.** The reading
 * of a single `auth status` answer — the credential-usability table, the
 * authentication-error codes, `verdictForStatus` — is now `verdict.ts`, and the
 * bounded-concurrency helper is `pool.ts`, because `profiles.ts` asks the same
 * question per *site-CLI profile* that this module asks per *hosting
 * environment* and a second copy of either is how the two surfaces would end up
 * disagreeing about the same profile on the same page. `profiles.ts` itself is
 * composed in below, so `SiteCliIntegration` carries `listProfiles`,
 * `logoutProfile` and `removeProfile` without this file knowing their argv.
 *
 * **The state union lives at the root.** `ConnectionState`,
 * `UnavailableReason`, `ConnectionResult`, `ConnectionQuery`,
 * `ConnectionSnapshot`, `ConnectOutcome` and `unavailableHint` are declared in
 * `src/connection-state.ts` and re-exported below, because `src/web/` renders
 * them and `src/web/` and `src/integration/` are peer layers that may share only
 * a root module. What stays here is what *acts*: the algorithm, the spawn seam,
 * and {@link integrationUnavailableError}, which builds a `CliError` and is
 * therefore HQ taxonomy rather than shared vocabulary.
 */

import {
  NOT_CONFIGURED_CONNECTION,
  unavailableHint,
  type ConnectionQuery,
  type ConnectionResult,
  type ConnectionSnapshot,
  type ConnectOutcome,
  type UnavailableReason,
} from "../connection-state.js";
import { CliError } from "../errors.js";
import {
  childFailure,
  interpretChildOutcome,
  type ChildResult,
} from "./classify.js";
import { createConnectAction } from "./connect.js";
import { normalizeOrigins, originOf } from "./origin.js";
import { runPool } from "./pool.js";
import {
  createSiteProfileService,
  type SiteProfileService,
} from "./profiles.js";
import { type ResolveSiteCli, type SiteCliResolution } from "./resolve.js";
import {
  authStatusArgs,
  parseSitesList,
  siteCliChildEnv,
  sitesListArgs,
} from "./site-cli.js";
import {
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  type SpawnChild,
} from "./spawn.js";
import { verdictFor, type ProfileVerdict } from "./verdict.js";

export type {
  ConnectionQuery,
  ConnectionResult,
  ConnectionSnapshot,
  ConnectionState,
  ConnectOutcome,
  UnavailableReason,
} from "../connection-state.js";
export { unavailableHint } from "../connection-state.js";

/**
 * The `CliError` a view may carry for an `unavailable` result.
 *
 * Constructed, never thrown: integration failure is a connection state, and a
 * dashboard page that cannot reach the site CLI still renders everything else.
 */
export function integrationUnavailableError(
  reason: UnavailableReason,
): CliError {
  return new CliError("integration_unavailable", unavailableHint(reason), {
    details: { reason },
  });
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

export interface SiteCliIntegrationOptions {
  readonly spawn: SpawnChild;
  readonly resolve: ResolveSiteCli;
  /**
   * The injected process environment, passed through to each child.
   * `NodeJS.ProcessEnv` rather than `RuntimeEnvironment`: that type lives in
   * `src/main.ts`, the composition root, and importing it here would invert the
   * layering. `src/web/server.ts` types its own `environment` the same way.
   */
  readonly environment: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly perChildTimeoutMs?: number;
  readonly overallDeadlineMs?: number;
  /** The Connect action's own budget; see `connect.ts`'s five-minute default. */
  readonly connectTimeoutMs?: number;
  /**
   * `auth logout` and `sites remove`'s own budget; see `profiles.ts`'s
   * thirty-second default. Longer than a query because a logout may revoke a
   * refresh token upstream, far shorter than a login because no human is in it.
   */
  readonly actionTimeoutMs?: number;
  readonly concurrency?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

/**
 * The integration's whole public behaviour: the connected-state question, the
 * Connect action, and the three site-profile management operations.
 *
 * The last three are {@link SiteProfileService}, composed in rather than
 * reimplemented. They are on this one interface because a composition root
 * builds *one* integration — `src/cli/dashboard.ts` does — and splitting them
 * across two objects would only mean two constructions of the same spawn seam,
 * the same resolver and the same environment.
 */
export interface SiteCliIntegration extends SiteProfileService {
  connectionStates(
    queries: readonly ConnectionQuery[],
  ): Promise<ConnectionSnapshot>;
  /**
   * Spawns `novamira auth login <url>`. Resolves for every failure and never
   * throws; see `connect.ts` for why the outcome carries a reason and no text.
   */
  connect(siteUrl: string): Promise<ConnectOutcome>;
}

export const DEFAULT_PER_CHILD_TIMEOUT_MS = 10_000;
export const DEFAULT_OVERALL_DEADLINE_MS = 20_000;
export const DEFAULT_CONCURRENCY = 4;

function unavailable(reason: UnavailableReason): ConnectionResult {
  return { state: "unavailable", profiles: [], reason };
}

export function createSiteCliIntegration(
  options: SiteCliIntegrationOptions,
): SiteCliIntegration {
  const perChildTimeoutMs =
    options.perChildTimeoutMs ?? DEFAULT_PER_CHILD_TIMEOUT_MS;
  const overallDeadlineMs =
    options.overallDeadlineMs ?? DEFAULT_OVERALL_DEADLINE_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;

  // Composed rather than inlined: the Connect action has its own timeout, its
  // own signal, and a deliberately different reading of the child's answer, and
  // `connect.ts` is where the boundary-rule reasoning for it lives.
  const connect = createConnectAction({
    spawn: options.spawn,
    resolve: options.resolve,
    environment: options.environment,
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.connectTimeoutMs }),
    maxStdoutBytes,
    maxStderrBytes,
  });

  // Composed for the same reason `connect` is: `profiles.ts` owns the argv, the
  // budgets and the boundary-rule reasoning for the three management commands,
  // and it shares this integration's spawn seam, resolver and environment.
  const profileService = createSiteProfileService({
    spawn: options.spawn,
    resolve: options.resolve,
    environment: options.environment,
    now: options.now,
    perChildTimeoutMs,
    overallDeadlineMs,
    ...(options.actionTimeoutMs === undefined
      ? {}
      : { actionTimeoutMs: options.actionTimeoutMs }),
    concurrency,
    maxStdoutBytes,
    maxStderrBytes,
  });

  return {
    connect,
    // Delegated through arrows rather than by reference: an unbound method
    // handed to a caller is a `this` waiting to be wrong, even when — as here —
    // the implementation is a closure that never reads one.
    listProfiles: () => profileService.listProfiles(),
    logoutProfile: (name) => profileService.logoutProfile(name),
    removeProfile: (name) => profileService.removeProfile(name),
    connectionStates: async (queries) => {
      // One deadline for the whole refresh, shared by every child. The
      // per-child timeout and this signal both apply; whichever fires first
      // wins, and once it has fired no further child is started.
      const signal = AbortSignal.timeout(overallDeadlineMs);

      const uniform = (
        result: ConnectionResult,
        cliAvailable: boolean,
      ): ConnectionSnapshot => ({
        byKey: new Map(queries.map((query) => [query.key, result])),
        checkedAt: options.now(),
        cliAvailable,
      });

      let resolution: SiteCliResolution | undefined;
      try {
        resolution = await options.resolve();
      } catch {
        // A probe that throws is a failed probe, not an absent CLI.
        return uniform(unavailable("cli_failed"), false);
      }
      if (resolution === undefined) {
        return uniform(unavailable("cli_absent"), false);
      }
      const cli = resolution;

      const run = async (args: readonly string[]): Promise<ChildResult> => {
        if (signal.aborted) return childFailure("deadline_exceeded");
        const outcome = await options.spawn({
          command: cli.command,
          args: [...cli.prefixArgs, ...args],
          env: siteCliChildEnv(options.environment),
          timeoutMs: perChildTimeoutMs,
          maxStdoutBytes,
          maxStderrBytes,
          signal,
        });
        return interpretChildOutcome(outcome);
      };

      /* Stage one: one `sites list`, for the whole refresh. */
      const listed = await run(sitesListArgs(perChildTimeoutMs));
      if (listed.kind !== "data") {
        // `site_not_found` is meaningless for a command that takes no `--site`.
        // Outside stage two it is just another failure code, and the table's
        // catch-all row applies.
        const reason = listed.kind === "failure" ? listed.reason : "cli_failed";
        return uniform(unavailable(reason), reason !== "cli_absent");
      }
      const profiles = parseSitesList(listed.data);
      if (profiles === undefined) {
        return uniform(unavailable("malformed_output"), true);
      }

      /* Match normalized origins to profile names. */
      const byOrigin = new Map<string, string[]>();
      for (const profile of profiles) {
        // `origin` is the CLI's own normalized value; `siteUrl` is the fallback
        // for a profile written before it carried one.
        const origin = originOf(profile.origin) ?? originOf(profile.siteUrl);
        if (origin === undefined) continue;
        const names = byOrigin.get(origin);
        if (names === undefined) byOrigin.set(origin, [profile.name]);
        else if (!names.includes(profile.name)) names.push(profile.name);
      }

      const matched = new Map<string, readonly string[]>();
      for (const query of queries) {
        const names: string[] = [];
        for (const origin of normalizeOrigins(query.origins)) {
          for (const name of byOrigin.get(origin) ?? []) {
            if (!names.includes(name)) names.push(name);
          }
        }
        matched.set(query.key, names);
      }

      /* Stage two: one `auth status` per *distinct* matched profile. Several
         environments commonly match the same profile, and one child per query
         would multiply a real network round trip by the size of the page. */
      const candidates = [...new Set([...matched.values()].flat())];
      const verdicts = new Map<string, ProfileVerdict>();
      await runPool(candidates, concurrency, async (name) => {
        // Only the verdict is used here: `expiresAt` is the site-profile
        // panel's business, and a connection cell has nowhere to render it.
        const { verdict } = verdictFor(
          await run(authStatusArgs(perChildTimeoutMs, name)),
        );
        verdicts.set(name, verdict);
      });

      /* Aggregate: any connected wins, then any reconnect, then the first
         unavailable reason observed among that query's own profiles. */
      const byKey = new Map<string, ConnectionResult>();
      for (const query of queries) {
        const names = (matched.get(query.key) ?? []).filter(
          (name) => verdicts.get(name)?.kind !== "missing",
        );
        if (names.length === 0) {
          byKey.set(query.key, NOT_CONFIGURED_CONNECTION);
          continue;
        }
        const states = names.map(
          (name) =>
            verdicts.get(name) ?? {
              kind: "unavailable" as const,
              reason: "deadline_exceeded" as const,
            },
        );
        if (states.some((verdict) => verdict.kind === "connected")) {
          byKey.set(query.key, { state: "connected", profiles: names });
          continue;
        }
        if (states.some((verdict) => verdict.kind === "reconnect")) {
          byKey.set(query.key, {
            state: "reconnect_required",
            profiles: names,
          });
          continue;
        }
        const first = states.find((verdict) => verdict.kind === "unavailable");
        byKey.set(query.key, {
          state: "unavailable",
          profiles: names,
          reason: first?.kind === "unavailable" ? first.reason : "cli_failed",
        });
      }

      return { byKey, checkedAt: options.now(), cliAvailable: true };
    },
  };
}
