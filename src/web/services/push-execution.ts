// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { ConfigStore } from "../../config/profiles.js";
import type { SavedPush } from "../../config/schema.js";
import { CliError } from "../../errors.js";
import type { HostingClientFactory } from "../../hosting/factory.js";
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
  readonly scope: string;
  readonly expiresAt: string;
}

export function createPushExecutionService(
  store: ConfigStore,
  hosting: HostingClientFactory,
  now: () => number = Date.now,
) {
  const plans = new Map<
    string,
    { push: SavedPush; plan: EnvironmentPushPlan; expires: number }
  >();
  const pending = new Map<string, Promise<void>>();
  const controller = new AbortController();
  return {
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
      const id = randomUUID();
      if (plans.size >= 100)
        throw new CliError(
          "conflict",
          "Too many pending push plans. Wait for old plans to expire.",
        );
      const expires = now() + 5 * 60_000;
      plans.set(id, { push, plan, expires });
      return {
        id,
        name: push.name,
        profile: push.hostingProfile,
        source: `${plan.source.displayName || plan.source.id} (${plan.source.id})`,
        target: `${plan.target.displayName || plan.target.id} (${plan.target.id})`,
        scope: [
          plan.database ? "database" : "",
          plan.allFiles ? "all files" : "",
          plan.searchReplace ? "search-replace" : "",
        ]
          .filter(Boolean)
          .join(", "),
        expiresAt: new Date(expires).toISOString(),
      };
    },
    async apply(id: string): Promise<void> {
      controller.signal.throwIfAborted();
      const entry = plans.get(id);
      // Consume before the first await; neither double clicks nor retries replay it.
      plans.delete(id);
      if (!entry || entry.expires <= now())
        throw new CliError(
          "not_found",
          "Push confirmation expired or was already used. Create a new plan.",
        );
      const key = JSON.stringify([
        entry.push.hostingProfile,
        entry.push.targetEnvId,
      ]);
      if (pending.has(key))
        throw new CliError(
          "conflict",
          "A push to this target is already running in this dashboard.",
        );
      const run = (async () => {
        const current = await store.requireSavedPush(entry.push.name);
        if (JSON.stringify(current) !== JSON.stringify(entry.push))
          throw new CliError(
            "conflict",
            "The push changed after planning. Review a new plan.",
          );
        const client = await hosting.clientFromProfile(current.hostingProfile);
        controller.signal.throwIfAborted();
        await executeEnvironmentPush(client, entry.plan, {
          signal: controller.signal,
          intervalSeconds: 5,
          timeoutSeconds: 300,
        });
      })();
      pending.set(key, run);
      try {
        await run;
      } finally {
        pending.delete(key);
      }
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
