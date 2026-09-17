// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  sendGuardedAction,
  waitForVerifiedAction,
} from "../../hosting/verified-action.js";
import { asRecord } from "../../json.js";
import type { ConfigStore } from "../../config/profiles.js";
import type { HostingClientFactory } from "../../hosting/factory.js";
import { applyHqCapabilityPolicy } from "../../hosting/capabilities.js";
import {
  prepareBackupRestore,
  executeBackupRestore,
  type BackupRestorePlan,
} from "../../hosting/backup-restore.js";
import { CliError } from "../../errors.js";
import { normalizeSiteUrl } from "../../provisioning/site-url.js";

export interface RestoreTarget {
  readonly profile: string;
  readonly site: string;
  readonly env: string;
}
export interface RestoreReview extends RestoreTarget {
  readonly operation?: "create";
  readonly id: string;
  readonly targetUrl: string;
  readonly backupId: string;
  readonly expiresAt: number;
}
export interface RestoreJob {
  readonly review: RestoreReview;
  readonly status: "running" | "completed" | "needs_verification";
}
export interface RestoreCatalog {
  readonly target: RestoreTarget;
  readonly targetUrl: string;
  readonly provider: string;
  readonly backups: readonly { id: string; label: string }[];
}

/** Extract display-only catalog entries; authorization remains in prepareBackupRestore. */
export function backupChoices(value: unknown): { id: string; label: string }[] {
  const entries = new Map<string, string>();
  function visit(value: unknown, collection: boolean): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, collection);
      return;
    }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (collection) {
      const id = row.backup_id ?? row.backupId ?? row.id ?? row.uuid;
      if (typeof id === "string" || typeof id === "number") {
        const date =
          row.created_at ?? row.createdAt ?? row.timestamp ?? row.date;
        entries.set(
          String(id),
          `${String(id)}${typeof date === "string" ? ` · ${date}` : ""}`,
        );
      }
    }
    for (const [key, child] of Object.entries(row))
      visit(
        child,
        collection ||
          ["backups", "data", "items", "result", "results"].includes(key),
      );
  }
  visit(value, Array.isArray(value));
  return [...entries].map(([id, label]) => ({ id, label }));
}

export function createRestoreService(
  store: ConfigStore,
  hosting: HostingClientFactory,
  now = Date.now,
) {
  const plans = new Map<
    string,
    { review: RestoreReview; plan: BackupRestorePlan | null; config: string }
  >();
  const jobs = new Map<string, RestoreJob>();
  const runs = new Map<string, Promise<void>>();
  const active = new Set<string>();
  const controller = new AbortController();
  async function targetClient(target: RestoreTarget, create = false) {
    if (!target.profile || !target.site || !target.env)
      throw new CliError(
        "usage_error",
        "Select a hosting environment from Sites.",
      );
    const config = JSON.stringify(
      await store.requireHostingProfile(target.profile),
    );
    const client = await hosting.clientFromProfile(target.profile);
    const caps = applyHqCapabilityPolicy(
      await client.read({ kind: "capabilities" }),
    );
    if (
      !Array.isArray(caps) ||
      !(
        create
          ? ["backups.create"]
          : ["backups.list", "backups.create", "backups.restore"]
      ).every((name) =>
        caps.some((c: unknown) => {
          const entry = asRecord(c);
          return entry?.name === name && entry.supported === true;
        }),
      )
    )
      throw new CliError(
        "provider_unsupported",
        "This backup operation is not available for this hosting account.",
      );
    const env = (await client.listEnvironments(target.site)).find(
      (env) => env.id === target.env,
    );
    if (!env?.primaryDomain)
      throw new CliError(
        "not_found",
        "The provider could not identify the destination environment and URL.",
      );
    const targetUrl = normalizeSiteUrl(env.primaryDomain, {}, "--url").siteUrl;
    return { client, config, targetUrl };
  }
  return {
    async planCreate(target: RestoreTarget): Promise<RestoreReview> {
      controller.signal.throwIfAborted();
      for (const [id, entry] of plans)
        if (entry.review.expiresAt <= now()) plans.delete(id);
      const { config, targetUrl } = await targetClient(target, true);
      controller.signal.throwIfAborted();
      if (plans.size >= 100)
        throw new CliError(
          "conflict",
          "Too many pending backup confirmations.",
        );
      const review: RestoreReview = {
        ...target,
        operation: "create",
        id: randomUUID(),
        targetUrl,
        backupId: `Novamira HQ ${new Date(now()).toISOString()}`,
        expiresAt: now() + 300_000,
      };
      plans.set(review.id, { review, plan: null, config });
      return review;
    },
    async catalog(target: RestoreTarget): Promise<RestoreCatalog> {
      const { client, targetUrl } = await targetClient(target);
      return {
        target,
        targetUrl,
        provider: client.provider,
        backups: backupChoices(
          await client.read({ kind: "backups", envId: target.env }),
        ),
      };
    },
    async plan(
      target: RestoreTarget,
      backupId: string,
      allContent: boolean,
      notifiedUserId: string,
    ): Promise<RestoreReview> {
      controller.signal.throwIfAborted();
      for (const [id, entry] of plans)
        if (entry.review.expiresAt <= now()) plans.delete(id);
      const { client, config, targetUrl } = await targetClient(target);
      const plan = await prepareBackupRestore(client, {
        targetEnvironmentId: target.env,
        backupId,
        allContent,
        ...(notifiedUserId ? { notifiedUserId } : {}),
      });
      controller.signal.throwIfAborted();
      if (plans.size >= 100)
        throw new CliError(
          "conflict",
          "Too many pending restore confirmations.",
        );
      const review = {
        ...target,
        id: randomUUID(),
        targetUrl,
        backupId: plan.backupId,
        expiresAt: now() + 300_000,
      };
      plans.set(review.id, { review, plan, config });
      return review;
    },
    start(id: string): RestoreJob {
      controller.signal.throwIfAborted();
      const existing = jobs.get(id);
      if (existing) return existing;
      const entry = plans.get(id);
      plans.delete(id);
      if (!entry || entry.review.expiresAt <= now())
        throw new CliError(
          "not_found",
          "Restore confirmation expired or was already used. Check Activity before retrying.",
        );
      const key = JSON.stringify([entry.review.profile, entry.review.env]);
      if (active.has(key))
        throw new CliError(
          "conflict",
          "A restore for this environment is already running.",
        );
      if (jobs.size >= 100) {
        const finished = [...jobs].find(([, job]) => job.status !== "running");
        if (!finished)
          throw new CliError("conflict", "Too many running restore jobs.");
        jobs.delete(finished[0]);
      }
      const job: RestoreJob = { review: entry.review, status: "running" };
      jobs.set(id, job);
      active.add(key);
      const run = (async () => {
        try {
          const current = await targetClient(entry.review, entry.plan === null);
          if (
            current.config !== entry.config ||
            current.targetUrl !== entry.review.targetUrl
          )
            throw new CliError(
              "conflict",
              "Destination changed after confirmation.",
            );
          controller.signal.throwIfAborted();
          const wait = {
            signal: controller.signal,
            intervalSeconds: 5,
            timeoutSeconds: 300,
          };
          if (entry.plan === null) {
            const result = await sendGuardedAction(
              current.client,
              {
                kind: "create-backup",
                envId: entry.review.env,
                body: { tag: entry.review.backupId },
              },
              controller.signal,
            );
            await waitForVerifiedAction(current.client, result, wait);
          } else await executeBackupRestore(current.client, entry.plan, wait);
          jobs.set(id, { ...job, status: "completed" });
        } catch {
          // Provider output is never rendered; an uncertain operation must not be retried automatically.
          jobs.set(id, { ...job, status: "needs_verification" });
        } finally {
          active.delete(key);
          runs.delete(id);
        }
      })();
      runs.set(id, run);
      return job;
    },
    snapshot(id: string) {
      return jobs.get(id);
    },
    list() {
      return [...jobs.values()].reverse();
    },
    async wait(id: string, signal: AbortSignal) {
      const run = runs.get(id);
      if (!run || signal.aborted) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          resolve();
        };
        signal.addEventListener("abort", done, { once: true });
        void run.then(done, done);
      });
    },
    async shutdown() {
      controller.abort();
      plans.clear();
      await Promise.allSettled(runs.values());
    },
  };
}
export type RestoreService = ReturnType<typeof createRestoreService>;
