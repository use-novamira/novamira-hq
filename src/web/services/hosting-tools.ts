// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HostingClientFactory } from "../../hosting/factory.js";
import { inspectHosting } from "../../hosting/inspection.js";

export interface HostingToolsTarget {
  readonly profile: string;
  readonly site: string;
  readonly env: string;
}

export function createHostingToolsService(hosting: HostingClientFactory) {
  return {
    async run(target: HostingToolsTarget, option: string): Promise<unknown> {
      const client = await hosting.clientFromProfile(target.profile);
      return inspectHosting(client, {
        siteId: target.site,
        environmentId: target.env,
        option,
      });
    },
  };
}
export type HostingToolsService = ReturnType<typeof createHostingToolsService>;
