// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Post-processing of a provider's capability document, in one place below the
 * CLI.
 *
 * Provider APIs have broader surfaces than HQ. Capability output therefore
 * uses an explicit public allowlist: provider-native and newly-added adapter
 * operations remain private until HQ deliberately adopts them here. The rule
 * sits below CLI, dashboard, MCP and the environment-push operation so
 * every caller sees the same fail-closed public contract.
 */

import {
  serializeProviderCapability,
  type ProviderCapability,
} from "./types.js";

/** The complete provider capability vocabulary that HQ may publish. */
export const HQ_PUBLIC_CAPABILITIES: ReadonlySet<string> = new Set([
  "providers.validate",
  "providers.capabilities",
  "regions.list",
  "activity.list",
  "sites.list",
  "sites.get",
  "sites.create",
  "sites.create-plain",
  "sites.clone",
  "envs.list",
  "envs.get",
  "envs.create",
  "envs.create-plain",
  "envs.clone",
  "envs.push",
  "ops.get",
  "ops.wait",
  "domains.list",
  "domains.add",
  "domains.verify",
  "domains.primary",
  "dns.domains.list",
  "dns.records.list",
  "backups.list",
  "backups.downloadable",
  "backups.create",
  "backups.restore",
  "cache.clear",
  "php.restart",
  "php.set-version",
  "redirects.list",
  "redirects.apply",
  "denied-ips.list",
  "denied-ips.set",
  "wp.plugins.list",
  "wp.plugins.install",
  "wp.plugins.update",
  "wp.plugins.update-all",
  "wp.themes.list",
  "wp.themes.update",
  "wp.themes.update-all",
  "wp-cli.run",
  "logs.get",
  "analytics.usage",
  "analytics.env",
]);

/** True only for a capability deliberately present in HQ's public contract. */
export function isHqPublicCapability(name: string): boolean {
  return HQ_PUBLIC_CAPABILITIES.has(name);
}

function asCapability(value: unknown): ProviderCapability | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const name = record.name;
  const supported = record.supported;
  const notes = record.notes;
  if (typeof name !== "string" || typeof supported !== "boolean")
    return undefined;
  if (typeof notes === "string" && notes !== "")
    return { name, supported, notes };
  if (notes !== undefined && notes !== null && typeof notes !== "string")
    return undefined;
  return { name, supported };
}

/** Remove operations that do not exist in HQ's public capability surface. */
export function applyHqCapabilityPolicy(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const visible = value.filter((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return true;
    const name = (entry as Record<string, unknown>).name;
    return typeof name !== "string" || isHqPublicCapability(name);
  });
  const capabilities: ProviderCapability[] = [];
  for (const entry of visible) {
    const capability = asCapability(entry);
    if (capability === undefined)
      return visible.length === value.length ? value : visible;
    capabilities.push(capability);
  }
  return capabilities.map(serializeProviderCapability);
}
