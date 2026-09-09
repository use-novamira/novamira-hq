// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { ConfigStore } from "../../config/profiles.js";
import type { DeployPath } from "../../config/schema.js";
import { CliError } from "../../errors.js";
import type { HostingClientFactory } from "../../hosting/factory.js";
import {
  prepareEnvironmentPush,
  executeEnvironmentPush,
  type EnvironmentPushPlan,
} from "../../hosting/environment-push.js";

export interface DeployConfirmation {
  readonly id: string;
  readonly name: string;
  readonly profile: string;
  readonly source: string;
  readonly target: string;
  readonly scope: string;
  readonly expiresAt: string;
}

export function createDeployExecutionService(
  store: ConfigStore,
  hosting: HostingClientFactory,
  now: () => number = Date.now,
) {
  const plans = new Map<
    string,
    { path: DeployPath; plan: EnvironmentPushPlan; expires: number }
  >();
  const pending = new Map<string, Promise<void>>();
  const controller = new AbortController();
  return {
    async plan(name: string): Promise<DeployConfirmation> {
      controller.signal.throwIfAborted();
      for (const [id, value] of plans)
        if (value.expires <= now()) plans.delete(id);
      if (plans.size >= 100)
        throw new CliError(
          "conflict",
          "Too many pending deploy plans. Wait for old plans to expire.",
        );
      const path = await store.requireDeployPath(name);
      const client = await hosting.clientFromProfile(path.hostingProfile);
      const plan = await prepareEnvironmentPush(client, {
        siteId: path.siteId,
        sourceEnvironmentId: path.sourceEnvId,
        targetEnvironmentId: path.targetEnvId,
        database: path.pushDb,
        allFiles: path.pushFiles,
        files: [],
        searchReplace: path.searchReplace,
      });
      controller.signal.throwIfAborted();
      const id = randomUUID();
      if (plans.size >= 100)
        throw new CliError(
          "conflict",
          "Too many pending deploy plans. Wait for old plans to expire.",
        );
      const expires = now() + 5 * 60_000;
      plans.set(id, { path, plan, expires });
      return {
        id,
        name: path.name,
        profile: path.hostingProfile,
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
          "Deploy confirmation expired or was already used. Create a new plan.",
        );
      const key = JSON.stringify([
        entry.path.hostingProfile,
        entry.path.targetEnvId,
      ]);
      if (pending.has(key))
        throw new CliError(
          "conflict",
          "A deploy to this target is already running in this dashboard.",
        );
      const run = (async () => {
        const current = await store.requireDeployPath(entry.path.name);
        if (JSON.stringify(current) !== JSON.stringify(entry.path))
          throw new CliError(
            "conflict",
            "The deploy path changed after planning. Review a new plan.",
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

export type DeployExecutionService = ReturnType<
  typeof createDeployExecutionService
>;
