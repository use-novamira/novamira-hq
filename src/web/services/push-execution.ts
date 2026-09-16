// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
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
  readonly confirmation: PushConfirmation;
  readonly status: "running" | "completed" | "needs_verification" | "failed";
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly message: string;
}

export function createPushExecutionService(
  store: ConfigStore,
  hosting: HostingClientFactory,
  now: () => number = Date.now,
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
    if (jobs.size >= 100) {
      const finished = [...jobs].find(([, job]) => job.status !== "running");
      if (!finished)
        throw new CliError("conflict", "Too many push jobs are running.");
      jobs.delete(finished[0]);
    }
    const started: PushJob = {
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
        await executeEnvironmentPush(client, entry.plan, {
          signal: controller.signal,
          intervalSeconds: 5,
          timeoutSeconds: 300,
        });
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
          finishedAt: now(),
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
    snapshot(id: string): PushJob | undefined {
      return jobs.get(id);
    },
    list(): readonly PushJob[] {
      return [...jobs.values()].reverse();
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
      if (!run || signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          signal?.removeEventListener("abort", done);
          resolve();
        };
        signal?.addEventListener("abort", done, { once: true });
        void run.then(done, done);
      });
    },
    async plan(name: string): Promise<PushConfirmation> {
      controller.signal.throwIfAborted();
      for (const [id, value] of plans)
        if (value.expires <= now()) plans.delete(id);
      if (plans.size >= 100)
        throw new CliError(
          "conflict",
          "Too many pending push plans. Wait for old plans to expire.",
        );
      const push = await store.requireSavedPush(name);
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
      plans.clear();
      await Promise.allSettled(pending.values());
    },
  };
}

export type PushExecutionService = ReturnType<
  typeof createPushExecutionService
>;
