// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { setInterval, clearInterval } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import type { HistoryStore, HistoryEntry } from "../../history/index.js";
import { withPushHistory } from "../../operation-context.js";
import { hasVerifiedCompletion } from "../../hosting/verified-action.js";
import type { ConfigStore } from "../../config/profiles.js";
import type { SavedPush } from "../../config/schema.js";
import { asCliError, CliError } from "../../errors.js";
import type { HostingClientFactory } from "../../hosting/factory.js";
import { normalizeSiteUrl } from "../../provisioning/site-url.js";
import {
  prepareEnvironmentPush,
  executeEnvironmentPush,
  type EnvironmentPushPlan,
} from "../../hosting/environment-push.js";

export interface PushConfirmation {
  readonly id: string;
  readonly name: string;
  readonly profile: string;
  readonly source: string;
  readonly target: string;
  readonly sourceUrl: string;
  readonly targetUrl: string;
  readonly scope: string;
  readonly expiresAt: string;
}

export interface PushJob {
  readonly targetEnvironmentId?: string;
  readonly operationId?: string;
  readonly confirmation: PushConfirmation;
  readonly status: "running" | "completed" | "needs_verification" | "failed";
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly message: string;
}

/**
 * Re-read one push whose outcome was never confirmed, and say what became of it.
 *
 * Every way this can go wrong — a profile that no longer exists, an operation ID
 * the provider has forgotten, an answer about some other operation, a network
 * that is down — means "could not check", never "the push failed". The
 * distinction is the whole point: telling an operator that a push failed, when
 * all that failed was the check, invites them to push again over a push that may
 * well have succeeded. So the catch returns the job with a message saying the
 * check did not happen, and leaves the status alone.
 */
async function recheckedAgainstProvider(
  hosting: HostingClientFactory,
  row: HistoryEntry,
  operationId: string,
  job: PushJob,
  now: () => number,
): Promise<PushJob> {
  try {
    const client = await hosting.clientFromProfile(row.profile);
    if (client.provider !== row.provider) throw new Error("Provider changed");
    const status = await client.operationStatus(operationId);
    if (
      status.provider !== row.provider ||
      status.operationId !== operationId ||
      status.raw == null
    )
      throw new Error("Unverified response");

    const completed = hasVerifiedCompletion(status, row.provider, operationId);
    const failed = status.failed;
    // Neither completed nor failed, yet the provider says it is done or answered
    // outside 2xx: the answer does not describe a state we can act on.
    if (
      !completed &&
      !failed &&
      (status.done || status.status < 200 || status.status >= 300)
    )
      throw new Error("Unknown operation state");

    return {
      ...job,
      status: completed ? "completed" : failed ? "failed" : "running",
      finishedAt: completed || failed ? now() : null,
      message: completed
        ? "Push completed according to the hosting provider."
        : failed
          ? "The provider reported that the push failed."
          : "The provider reports that this push is still in progress.",
    };
  } catch {
    return {
      ...job,
      message:
        "The previous operation could not be checked. Its status may no longer be available, or the account may be unreachable. Check your hosting account before starting another push.",
    };
  }
}

export function createPushExecutionService(
  store: ConfigStore,
  hosting: HostingClientFactory,
  now: () => number = Date.now,
  history?: Pick<HistoryStore, "list">,
  endpointLabel?: (
    profile: string,
    environment: string,
    site: string,
  ) => string | undefined,
) {
  const plans = new Map<
    string,
    {
      push: SavedPush;
      plan: EnvironmentPushPlan;
      expires: number;
      confirmation: PushConfirmation;
    }
  >();
  const pending = new Map<string, Promise<void>>();
  const jobs = new Map<string, PushJob>();
  const runs = new Map<string, Promise<void>>();
  const controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshRun: Promise<void> | undefined;

  function fromHistory(row: HistoryEntry): PushJob {
    const terminal = row.status === "succeeded" || row.status === "failed";
    return {
      ...(row.environmentId ? { targetEnvironmentId: row.environmentId } : {}),
      confirmation: {
        id: row.pushJobId ?? row.id,
        name: row.pushName ?? "Push",
        profile: row.profile,
        source: row.sourceEnvironmentId ?? "Unknown source",
        target: row.environmentId ?? "Unknown destination",
        sourceUrl:
          row.sourceUrl ??
          endpointLabel?.(
            row.profile,
            row.sourceEnvironmentId ?? "",
            row.siteId ?? "",
          ) ??
          "Source environment (name unavailable)",
        targetUrl:
          row.targetUrl ??
          endpointLabel?.(
            row.profile,
            row.environmentId ?? "",
            row.siteId ?? "",
          ) ??
          "Destination environment (name unavailable)",
        scope: row.scope ?? "Not recorded",
        expiresAt: row.startedAt,
      },
      ...(row.operationId ? { operationId: row.operationId } : {}),
      status:
        row.status === "succeeded"
          ? "completed"
          : row.status === "failed"
            ? "failed"
            : "needs_verification",
      startedAt: Date.parse(row.startedAt),
      finishedAt: terminal ? Date.parse(row.updatedAt) : null,
      message:
        row.status === "succeeded"
          ? "Push completed according to the hosting provider."
          : row.status === "failed"
            ? "The provider reported that the push failed."
            : row.operationId
              ? "The outcome has not yet been confirmed."
              : "This older push has no saved operation reference. Check its outcome in your hosting account before starting another push.",
    };
  }

  async function refresh(checkProvider = true): Promise<void> {
    if (!history || controller.signal.aborted) return;
    if (refreshRun) return refreshRun;
    refreshRun = (async () => {
      const rows = (await history.list()).filter(
        (row) => row.action === "push-environment",
      );
      // Bounded concurrency; only status reads, never action replay or inventory calls.
      let index = 0;
      const worker = async () => {
        while (index < rows.length && !controller.signal.aborted) {
          const row = rows[index++];
          if (!row) continue;
          const job = fromHistory(row);
          const id = job.confirmation.id;
          if (runs.has(id)) {
            const current = jobs.get(id);
            if (current && row.operationId)
              jobs.set(id, { ...current, operationId: row.operationId });
            continue;
          }
          if (
            !checkProvider &&
            job.status === "needs_verification" &&
            jobs.has(id)
          )
            continue;
          if (
            checkProvider &&
            job.status === "needs_verification" &&
            row.operationId
          ) {
            jobs.set(
              id,
              await recheckedAgainstProvider(
                hosting,
                row,
                row.operationId,
                job,
                now,
              ),
            );
            continue;
          }
          jobs.set(id, job);
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
    })().finally(() => {
      refreshRun = undefined;
    });
    return refreshRun;
  }

  function launch(id: string): Promise<void> {
    controller.signal.throwIfAborted();
    const entry = plans.get(id);
    plans.delete(id);
    if (!entry || entry.expires <= now())
      throw new CliError(
        "not_found",
        "Push confirmation expired or was already used. Check recent jobs before creating a new plan.",
      );
    const key = JSON.stringify([
      entry.push.hostingProfile,
      entry.push.targetEnvId,
    ]);
    if (pending.has(key))
      throw new CliError(
        "conflict",
        "A push to this target is already running in this dashboard. Open its job to check progress.",
      );
    if (
      [...jobs.values()].some(
        (job) =>
          job.confirmation.profile === entry.push.hostingProfile &&
          job.targetEnvironmentId === entry.push.targetEnvId &&
          (job.status === "running" || job.status === "needs_verification"),
      )
    )
      throw new CliError(
        "conflict",
        "An earlier push to this destination still needs verification. No new push was sent.",
      );
    if (jobs.size >= 100) {
      const finished = [...jobs].find(
        ([, job]) => job.status === "completed" || job.status === "failed",
      );
      if (!finished)
        throw new CliError("conflict", "Too many push jobs are running.");
      jobs.delete(finished[0]);
    }
    const started: PushJob = {
      targetEnvironmentId: entry.push.targetEnvId,
      confirmation: entry.confirmation,
      status: "running",
      startedAt: now(),
      finishedAt: null,
      message: "Push is starting. Waiting for the hosting provider.",
    };
    jobs.set(id, started);
    let dispatched = false;
    const run = (async () => {
      try {
        const current = await store.requireSavedPush(entry.push.name);
        if (JSON.stringify(current) !== JSON.stringify(entry.push))
          throw new CliError(
            "conflict",
            "The push changed after planning. Review a new plan.",
          );
        const client = await hosting.clientFromProfile(current.hostingProfile);
        controller.signal.throwIfAborted();
        dispatched = true;
        await withPushHistory(
          {
            pushJobId: id,
            pushName: entry.confirmation.name,
            sourceUrl: entry.confirmation.sourceUrl,
            targetUrl: entry.confirmation.targetUrl,
          },
          () =>
            executeEnvironmentPush(client, entry.plan, {
              signal: controller.signal,
              intervalSeconds: 5,
              timeoutSeconds: 86400,
            }),
        );
        jobs.set(id, {
          ...started,
          status: "completed",
          finishedAt: now(),
          message: "Push completed according to the hosting provider.",
        });
      } catch (error) {
        jobs.set(id, {
          ...started,
          status: dispatched ? "needs_verification" : "failed",
          finishedAt: dispatched ? null : now(),
          message: asCliError(error).message,
        });
        throw error;
      } finally {
        pending.delete(key);
        runs.delete(id);
      }
    })();
    pending.set(key, run);
    runs.set(id, run);
    return run;
  }
  return {
    refresh,
    startMonitoring(): void {
      if (timer || controller.signal.aborted) return;
      void refresh().catch(() => {
        /* Preserve unreadable history; never replay a write. */
      });
      timer = setInterval(() => {
        void refresh().catch(() => {
          /* Retry observation later, never the push. */
        });
      }, 30_000);
      timer.unref();
    },
    snapshot(id: string): PushJob | undefined {
      return jobs.get(id);
    },
    list(): readonly PushJob[] {
      return [...jobs.values()].sort((a, b) => {
        const active = (job: PushJob) =>
          job.status === "running" || job.status === "needs_verification"
            ? 0
            : 1;
        return active(a) - active(b) || b.startedAt - a.startedAt;
      });
    },
    start(id: string): PushJob {
      const existing = jobs.get(id);
      if (existing) return existing;
      void launch(id).catch(() => {
        /* The job holds the failure, never replay a mutation. */
      });
      const started = jobs.get(id);
      if (!started)
        throw new CliError("internal_error", "Push job could not be created.");
      return started;
    },
    async wait(id: string, signal?: AbortSignal): Promise<void> {
      const run = runs.get(id);
      if (signal?.aborted) return;
      if (!run) {
        const status = jobs.get(id)?.status;
        if (!history || status === "completed" || status === "failed") return;
        await delay(30_000, undefined, signal ? { signal } : {}).catch(() => {
          /* Observer disconnect does not cancel the provider job. */
        });
        if (!signal?.aborted) await refresh();
        return;
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          signal?.removeEventListener("abort", done);
          resolve();
        };
        signal?.addEventListener("abort", done, { once: true });
        void run.then(done, done);
      });
    },
    async previousUnresolved(name: string): Promise<PushJob | undefined> {
      await refresh();
      const push = await store.requireSavedPush(name);
      return [...jobs.values()].find(
        (job) =>
          job.confirmation.profile === push.hostingProfile &&
          job.targetEnvironmentId === push.targetEnvId &&
          (job.status === "running" || job.status === "needs_verification"),
      );
    },
    async plan(name: string): Promise<PushConfirmation> {
      controller.signal.throwIfAborted();
      await refresh();
      for (const [id, value] of plans)
        if (value.expires <= now()) plans.delete(id);
      if (plans.size >= 100)
        throw new CliError(
          "conflict",
          "Too many pending push plans. Wait for old plans to expire.",
        );
      const push = await store.requireSavedPush(name);
      if (
        [...jobs.values()].some(
          (job) =>
            job.confirmation.profile === push.hostingProfile &&
            job.targetEnvironmentId === push.targetEnvId &&
            (job.status === "running" || job.status === "needs_verification"),
        )
      )
        throw new CliError(
          "conflict",
          "A previous push to this destination is still in progress or needs verification. Check its job before starting another push.",
        );
      const client = await hosting.clientFromProfile(push.hostingProfile);
      const plan = await prepareEnvironmentPush(client, {
        siteId: push.siteId,
        sourceEnvironmentId: push.sourceEnvId,
        targetEnvironmentId: push.targetEnvId,
        database: push.pushDb,
        allFiles: push.pushFiles,
        files: [],
        searchReplace: push.searchReplace,
      });
      controller.signal.throwIfAborted();
      if (
        !plan.source.primaryDomain?.trim() ||
        !plan.target.primaryDomain?.trim()
      ) {
        throw new CliError(
          "provider_error",
          "The hosting provider did not supply both environment URLs. No push can be confirmed until the source and destination can be identified.",
        );
      }
      const sourceUrl = normalizeSiteUrl(
        plan.source.primaryDomain,
        {},
        "--url",
      ).siteUrl;
      const targetUrl = normalizeSiteUrl(
        plan.target.primaryDomain,
        {},
        "--url",
      ).siteUrl;
      if (sourceUrl === targetUrl)
        throw new CliError(
          "conflict",
          "The source and destination report the same URL. Verify the hosting environments before pushing.",
        );
      const id = randomUUID();
      if (plans.size >= 100)
        throw new CliError(
          "conflict",
          "Too many pending push plans. Wait for old plans to expire.",
        );
      const expires = now() + 5 * 60_000;
      const confirmation: PushConfirmation = {
        id,
        name: push.name,
        profile: push.hostingProfile,
        source: `${plan.source.displayName || plan.source.id} (${plan.source.id})`,
        target: `${plan.target.displayName || plan.target.id} (${plan.target.id})`,
        sourceUrl,
        targetUrl,
        scope: [
          plan.database ? "database" : "",
          plan.allFiles ? "all files" : "",
          plan.searchReplace ? "search-replace" : "",
        ]
          .filter(Boolean)
          .join(", "),
        expiresAt: new Date(expires).toISOString(),
      };
      plans.set(id, { push, plan, expires, confirmation });
      return confirmation;
    },
    async apply(id: string): Promise<void> {
      await launch(id);
    },
    async shutdown(): Promise<void> {
      controller.abort();
      if (timer) clearInterval(timer);
      plans.clear();
      await Promise.allSettled(pending.values());
      await refreshRun;
    },
  };
}

export type PushExecutionService = ReturnType<
  typeof createPushExecutionService
>;
