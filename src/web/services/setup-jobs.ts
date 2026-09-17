// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Novamira-setup job registry: ids, the bounded event log, the
 * running/latest-for-target lookups, and the runner that calls
 * `provisionNovamira`.
 *
 * **What the Go did.** `*Server` carried `setupJobs map[string]*novamiraSetupJob`
 * behind `jobsMu`, and `startNovamiraSetupJob` (`server.go:1020-1057`) minted an
 * id, wrote a `running` record and launched a goroutine running
 * `setupNovamiraWithProgress` — a second, dashboard-local copy of the whole
 * provisioning sequence, which ended by creating a WordPress application
 * password and writing a `site_profiles` entry (`server.go:1254-1296`). The map
 * was unbounded in both dimensions: jobs were never evicted and an event log
 * grew for as long as the process lived.
 *
 * **What HQ does instead, and what it deletes.** The sequence is not
 * reimplemented at all: this service calls `provisionNovamira` from
 * `src/provisioning/` — the same function `hosting novamira setup` calls, with no
 * commander, no `Renderer` and no `CommandIo` in the graph — and wires its
 * `report` channel to {@link SetupJobService}'s event log. That channel exists
 * for exactly this caller; `src/provisioning/setup.ts:147` says so. The two
 * deleted steps are simply absent: HQ creates no WordPress user, holds no site
 * token and writes no site profile, so the flow ends at the last `wp option
 * update` and the run's value is the `novamira auth login` handoff the result
 * already carries.
 *
 * **Three departures from Go, each with a reason.**
 *
 * 1. *The registry is bounded.* {@link MAX_JOBS} records, evicting the oldest
 *    **finished** job first and never a running one, and {@link MAX_EVENTS}
 *    events per job, keeping the most recent. An operator's dashboard session is
 *    not a transcript store, and an unbounded map on a process that lives for a
 *    working day is a slow leak nobody notices.
 * 2. *The hosting client is resolved before the job is minted.* Go started the
 *    goroutine first, so a typo in `?profile=` produced a job that failed
 *    instantly with a provider error in its log. Here it is an ordinary
 *    `profile_not_found` from {@link SetupJobService.start}, which the handler
 *    turns into a `danger` notice — no job record is created for a target that
 *    does not exist. Everything the provisioning service itself refuses (an
 *    unobservable WP-CLI provider, PHP below 8.0, a failing compatibility
 *    preflight) still lands as a job error, because those verdicts belong to
 *    `provisionNovamira` and must not be second-guessed here.
 * 3. *The stored error is `{ code, message }`, never the `CliError`.* In
 *    particular never its `details`: a failed compatibility preflight carries the
 *    entire install record there (`setup.ts:213-226`), `failureEnvelope`'s
 *    `redact()` runs on the JSON path only, and this value is rendered into a
 *    page.
 *
 * **Nothing here renders.** A service may not import a view; `views/setup.ts`
 * takes a {@link SetupJobSnapshot} and turns it into markup. Snapshots are
 * copies, so a caller cannot mutate a live job by holding one.
 */

import { randomBytes } from "node:crypto";
import {
  inspectExistingNovamira,
  type ExistingNovamira,
} from "../../provisioning/existing.js";

import { asCliError, CliError, type ErrorCode } from "../../errors.js";
import type { HostingClientFactory } from "../../hosting/factory.js";
import {
  provisionNovamira,
  checkSiteCompatibility,
  normalizeSiteUrl,
  type HttpFetch,
  type NovamiraSetupResult,
  type ProgressLevel,
} from "../../provisioning/index.js";

/** Go's three job states, unchanged. There is no `queued`: a job starts running. */
export type SetupJobStatus = "running" | "done" | "error";

/**
 * `provisionNovamira`'s two progress levels plus the terminal `error` the runner
 * appends itself. `views/setup.ts` maps them onto notice levels.
 */
export type SetupJobEventLevel = ProgressLevel | "error";

export interface SetupJobEvent {
  /** Unix milliseconds, from the injected clock. */
  readonly at: number;
  readonly level: SetupJobEventLevel;
  readonly message: string;
}

export interface SetupJobFailure {
  readonly code: ErrorCode;
  readonly message: string;
}

export interface SetupJobSnapshot {
  readonly id: string;
  readonly status: SetupJobStatus;
  readonly profile: string;
  readonly envId: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly events: readonly SetupJobEvent[];
  readonly result: NovamiraSetupResult | null;
  /** `{ code, message }` only — never a `CliError`, never its `details`. */
  readonly error: SetupJobFailure | null;
}

export interface SetupJobStartInput {
  readonly profile: string;
  readonly envId: string;
  /** Explicit activation on an existing installation; new installs enable it. */
  readonly aiAbilities: boolean;
}

export interface SetupJobService {
  inspect(
    profile: string,
    envId: string,
    signal: AbortSignal,
    siteUrl?: string,
  ): Promise<ExistingNovamira | undefined>;
  /**
   * Start a run, or return the id of the one already running against this
   * target. Rejects when the hosting profile cannot be resolved.
   */
  start(input: SetupJobStartInput): Promise<string>;
  snapshot(id: string): SetupJobSnapshot | undefined;
  /** The most recently started job for a target, whatever its status. */
  latestForTarget(profile: string, envId: string): SetupJobSnapshot | undefined;
  /** Cancel and await every accepted run. Idempotent. */
  shutdown(): Promise<void>;
}

export interface SetupJobServiceOptions {
  readonly hosting: HostingClientFactory;
  /** Injected record; nothing under `src/web/` reads `process.env`. */
  readonly environment: NodeJS.ProcessEnv;
  /** The one outbound-HTTP seam, handed straight to `provisionNovamira`. */
  readonly fetch: HttpFetch;
  readonly now: () => number;
  /** Overridable so a contract test can pin a job id. */
  readonly randomId?: () => string;
  readonly maxJobs?: number;
  readonly maxEvents?: number;
  /** Runner seam for lifecycle tests; production uses the shared service. */
  readonly provision?: typeof provisionNovamira;
}

/**
 * How many job records the process keeps. An operator installs Novamira onto a
 * handful of environments in a session; thirty-two is generous for that and
 * bounded for everything else.
 */
export const MAX_JOBS = 32;

/**
 * How many events one job keeps, most recent first out of the *front*.
 * `provisionNovamira` reports about a dozen; two hundred and fifty-six is room
 * for a pathological retry loop and a hard stop for a runaway one.
 */
export const MAX_EVENTS = 256;

/** The first event of every job, exactly Go's (`server.go:1039`). */
const STARTED_MESSAGE = "Setup job started.";

/** The last event of a successful job, exactly Go's (`server.go:1126`). */
const FINISHED_MESSAGE = "Setup finished.";

interface SetupJob {
  readonly id: string;
  status: SetupJobStatus;
  readonly profile: string;
  readonly envId: string;
  readonly startedAt: number;
  finishedAt: number | null;
  events: SetupJobEvent[];
  result: NovamiraSetupResult | null;
  error: SetupJobFailure | null;
}

function snapshotOf(job: SetupJob): SetupJobSnapshot {
  return {
    id: job.id,
    status: job.status,
    profile: job.profile,
    envId: job.envId,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    // A copy: the stream handler holds a snapshot across an await, and a live
    // array would let the runner mutate what has already been rendered.
    events: [...job.events],
    result: job.result,
    error: job.error,
  };
}

export function createSetupJobService(
  options: SetupJobServiceOptions,
): SetupJobService {
  const maxJobs = options.maxJobs ?? MAX_JOBS;
  const maxEvents = options.maxEvents ?? MAX_EVENTS;
  const jobs = new Map<string, SetupJob>();
  const reservations = new Map<string, Promise<string>>();
  const tasks = new Set<Promise<void>>();
  const controller = new AbortController();
  const provision = options.provision ?? provisionNovamira;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const append = (id: string, level: SetupJobEventLevel, message: string) => {
    const job = jobs.get(id);
    if (job === undefined) return;
    job.events.push({ at: options.now(), level, message });
    if (job.events.length > maxEvents) {
      job.events = job.events.slice(job.events.length - maxEvents);
    }
  };

  /**
   * Make room for one more record.
   *
   * Only a finished job is ever evicted, and the oldest one first. Dropping a
   * running job would strand a page whose `#setup-work` is streaming: the stream
   * loop reads "the job disappeared" and stops, and the operator is left looking
   * at a half-finished install with no way to learn how it ended.
   */
  const evict = (): void => {
    while (jobs.size >= maxJobs) {
      let oldest: SetupJob | undefined;
      for (const job of jobs.values()) {
        if (job.status === "running") continue;
        if (oldest === undefined || job.startedAt < oldest.startedAt) {
          oldest = job;
        }
      }
      if (oldest === undefined) return;
      jobs.delete(oldest.id);
    }
  };

  const hasCapacity = (): boolean => {
    let running = 0;
    for (const job of jobs.values()) {
      if (job.status === "running") running += 1;
    }
    return running + reservations.size < maxJobs;
  };

  const runningForTarget = (
    profile: string,
    envId: string,
  ): SetupJob | undefined => latestMatch(jobs, profile, envId, true);

  const finishOk = (id: string, result: NovamiraSetupResult): void => {
    const job = jobs.get(id);
    if (job === undefined) return;
    job.finishedAt = options.now();
    job.status = "done";
    job.result = result;
    append(id, "ok", FINISHED_MESSAGE);
  };

  const finishError = (id: string, error: unknown): void => {
    const job = jobs.get(id);
    if (job === undefined) return;
    const cliError = asCliError(error);
    job.finishedAt = options.now();
    job.status = "error";
    // `code` and `message`, and nothing else. `details` on a compatibility
    // failure carries the whole install record, and this value is rendered.
    job.error = { code: cliError.code, message: cliError.message };
    append(id, "error", cliError.message);
  };

  const targetKey = (profile: string, envId: string): string =>
    JSON.stringify([profile, envId]);

  const unavailable = (): CliError =>
    new CliError(
      "conflict",
      shuttingDown
        ? "The dashboard is shutting down and cannot start setup."
        : "All setup job capacity is occupied; wait for a running setup to finish.",
    );

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shuttingDown = true;
    controller.abort(
      new CliError(
        "conflict",
        "Setup was cancelled because the dashboard stopped.",
      ),
    );
    shutdownPromise = (async () => {
      while (reservations.size > 0 || tasks.size > 0) {
        await Promise.allSettled([...reservations.values(), ...tasks]);
      }
    })();
    return shutdownPromise;
  };

  return {
    inspect: async (profile, envId, signal, siteUrl) => {
      if (shuttingDown) throw unavailable();
      const client = await options.hosting.clientFromProfile(profile);
      signal.throwIfAborted();
      const existing = await inspectExistingNovamira(client, envId, {
        intervalSeconds: 2,
        timeoutSeconds: 60,
        signal: AbortSignal.any([signal, controller.signal]),
      });
      if (client.provider === "hostinger" && existing?.active && siteUrl) {
        const site = normalizeSiteUrl(siteUrl, options.environment, "--url");
        try {
          await checkSiteCompatibility(site, { fetch: options.fetch, signal });
          return { ...existing, aiEnabled: true, aiDomain: site.host };
        } catch {
          signal.throwIfAborted();
        }
      }
      return existing;
    },
    start: (input) => {
      const profile = input.profile.trim();
      const envId = input.envId.trim();
      if (profile === "" || envId === "") {
        throw new CliError(
          "usage_error",
          "Setup needs a hosting profile and an environment; open it from the Sites page.",
        );
      }
      if (shuttingDown) return Promise.reject(unavailable());
      // The double-click guard, and Go's (`server.go:1023-1025`): two installs
      // racing on one environment is the one outcome an impatient operator can
      // produce with a mouse.
      const running = runningForTarget(profile, envId);
      if (running !== undefined) return Promise.resolve(running.id);

      const key = targetKey(profile, envId);
      const reserved = reservations.get(key);
      if (reserved !== undefined) return reserved;
      if (!hasCapacity()) return Promise.reject(unavailable());

      const reservation = (async (): Promise<string> => {
        try {
          // Before the record exists, so an unknown profile or an unreadable
          // credential is a start failure rather than an instant failed job.
          const client = await options.hosting.clientFromProfile(profile);
          controller.signal.throwIfAborted();

          reservations.delete(key);
          evict();
          const id = options.randomId?.() ?? randomBytes(16).toString("hex");
          const startedAt = options.now();
          jobs.set(id, {
            id,
            status: "running",
            profile,
            envId,
            startedAt,
            finishedAt: null,
            events: [
              { at: startedAt, level: "info", message: STARTED_MESSAGE },
            ],
            result: null,
            error: null,
          });

          const task = (async () => {
            try {
              const result = await provision(
                {
                  client,
                  hostingProfile: profile,
                  environment: options.environment,
                  fetch: options.fetch,
                  signal: controller.signal,
                  report: (level, message) => {
                    append(id, level, message);
                  },
                },
                { envId, aiAbilities: input.aiAbilities },
              );
              finishOk(id, result);
            } catch (error) {
              finishError(id, error);
            }
          })();
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
          return id;
        } finally {
          reservations.delete(key);
        }
      })();
      reservations.set(key, reservation);
      return reservation;
    },

    snapshot: (id) => {
      const job = jobs.get(id);
      return job === undefined ? undefined : snapshotOf(job);
    },

    latestForTarget: (profile, envId) => {
      const job = latestMatch(jobs, profile.trim(), envId.trim(), false);
      return job === undefined ? undefined : snapshotOf(job);
    },
    shutdown,
  };
}

/**
 * Go's `runningSetupJobForTarget` / `latestSetupJobForTarget`
 * (`server.go:1059-1091`), which differed only in one `continue`.
 */
function latestMatch(
  jobs: ReadonlyMap<string, SetupJob>,
  profile: string,
  envId: string,
  runningOnly: boolean,
): SetupJob | undefined {
  let match: SetupJob | undefined;
  for (const job of jobs.values()) {
    if (job.profile !== profile || job.envId !== envId) continue;
    if (runningOnly && job.status !== "running") continue;
    if (match === undefined || job.startedAt > match.startedAt) match = job;
  }
  return match;
}
