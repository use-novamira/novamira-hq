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
import { type ResolveSiteCli, type SiteCliResolution } from "./resolve.js";
import {
  authStatusArgs,
  parseAuthStatus,
  parseSitesList,
  siteCliChildEnv,
  sitesListArgs,
  type CredentialState,
  type SiteCliAuthStatus,
} from "./site-cli.js";
import {
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  type SpawnChild,
} from "./spawn.js";

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
/* Per-profile verdict                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Whether a credential state can possibly back a connection. Exhaustive by
 * construction: a sixth upstream state is a compile error here rather than a
 * silent "connected".
 */
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

type ProfileVerdict =
  | { readonly kind: "connected" }
  | { readonly kind: "reconnect" }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason }
  | { readonly kind: "missing" };

const CONNECTED: ProfileVerdict = Object.freeze({ kind: "connected" as const });
const RECONNECT: ProfileVerdict = Object.freeze({ kind: "reconnect" as const });

function verdictForStatus(status: SiteCliAuthStatus): ProfileVerdict {
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
  if (restError !== undefined && AUTH_ERROR_CODES.has(restError)) {
    return RECONNECT;
  }
  return { kind: "unavailable", reason: "site_unreachable" };
}

function verdictFor(result: ChildResult): ProfileVerdict {
  switch (result.kind) {
    case "site_missing":
      return { kind: "missing" };
    case "failure":
      return { kind: "unavailable", reason: result.reason };
    case "data": {
      const status = parseAuthStatus(result.data);
      return status === undefined
        ? { kind: "unavailable", reason: "malformed_output" }
        : verdictForStatus(status);
    }
  }
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
  readonly concurrency?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface SiteCliIntegration {
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

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Deliberately hand-rolled rather than chunked: a chunked `Promise.all` runs at
 * the speed of the slowest member of each chunk, which with a ten-second
 * per-child timeout is exactly the case that matters.
 */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: width }, lane));
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

  return {
    connect,
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
        verdicts.set(
          name,
          verdictFor(await run(authStatusArgs(perChildTimeoutMs, name))),
        );
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
