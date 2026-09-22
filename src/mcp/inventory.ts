// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { asCliError } from "../errors.js";
import type { McpServerDependencies } from "./server.js";

/** Preserve source identity; never invent a cross-provider/WordPress match. */
export async function listAllSites(
  deps: McpServerDependencies,
): Promise<unknown> {
  const sources: Record<string, unknown>[] = [];
  let complete = true;
  try {
    if (!deps.siteOperations) throw new Error("Unavailable integration");
    sources.push({
      source: "wordpress",
      status: "ok",
      data: await deps.siteOperations.execute({ kind: "list" }),
    });
  } catch {
    complete = false;
    sources.push({
      source: "wordpress",
      status: "unavailable",
      message:
        "Connected WordPress sites could not be listed. Check the Novamira CLI integration in HQ Diagnostics.",
    });
  }
  try {
    const profiles = await deps.store.listHostingProfiles();
    // Sequential to avoid competing credential prompts and unbounded provider calls.
    for (const entry of profiles) {
      const identity = {
        source: "hosting",
        account: entry.name,
        provider: entry.profile.provider,
      };
      try {
        const client = await deps.hosting.clientFromProfile(entry.name);
        sources.push({
          ...identity,
          status: "ok",
          data: await client.listSites({ includeEnvironments: true }),
        });
      } catch (error) {
        complete = false;
        sources.push({
          ...identity,
          status: "unavailable",
          code: asCliError(error).code,
          message:
            "This hosting account could not be listed. Check its connection in HQ.",
        });
      }
    }
    if (!profiles.length)
      sources.push({ source: "hosting", status: "ok", data: [] });
  } catch {
    complete = false;
    sources.push({
      source: "hosting",
      status: "unavailable",
      message: "Hosting accounts could not be loaded.",
    });
  }
  return {
    complete,
    sources,
    note: "Entries retain their source identity and may overlap. Do not merge by name or assume different domains are the same site.",
  };
}
