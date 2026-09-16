// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isProviderKind } from "../../config/schema.js";
import {
  HQ_PUBLIC_CAPABILITIES,
  applyHqCapabilityPolicy,
} from "../../hosting/capabilities.js";
import {
  ENVIRONMENT_PUSH_PROVIDERS,
  NOVAMIRA_SETUP_PROVIDERS,
} from "../../hosting/types.js";
import { html, hrefAttr, url, type Html } from "../html.js";
import { providerLabelFor } from "./types.js";

export interface ProviderActionsView {
  readonly profile: string;
  readonly provider: string;
  readonly capabilities?: unknown;
}

/** Only actions exposed through the dashboard or typed AI tools belong here. */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  "providers.validate": "Check the hosting account connection",
  "sites.list": "List sites",
  "sites.get": "View site details",
  "envs.list": "List site environments",
  "envs.push": "Push content between environments",
  "ops.get": "Check an operation’s progress",
  "backups.list": "List backups",
  "backups.create": "Create a backup",
  "backups.restore": "Restore a backup",
};

/** Contract tests verify these against the actual MCP tools/list response. */
export const ACTION_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "providers.validate": ["hosting_provider_validate"],
  "sites.list": ["hosting_sites_list"],
  "sites.get": ["hosting_site_get"],
  "envs.list": ["hosting_environments_list"],
  "envs.push": [
    "hosting_environment_push_plan",
    "hosting_environment_push_apply",
  ],
  "ops.get": ["hosting_operation_get"],
  "backups.list": ["hosting_backups_list"],
  "backups.create": ["hosting_backup_create"],
  "backups.restore": [
    "hosting_backup_restore_plan",
    "hosting_backup_restore_apply",
  ],
};

export function renderProviderActionsPage(view: ProviderActionsView): Html {
  const header = html`<header class="page-head"><div><h1>Available actions</h1><p>${view.profile} · ${providerLabelFor(view.provider)}</p></div><a class="button secondary"${hrefAttr(url("/providers"))}>Back to Hosting accounts</a></header>`;
  const document = applyHqCapabilityPolicy(view.capabilities);
  if (
    !Array.isArray(document) ||
    !document.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        typeof entry.name === "string" &&
        "supported" in entry &&
        typeof entry.supported === "boolean",
    )
  ) {
    return html`<section class="page flow-page">${header}<section class="empty empty-block"><h2>Available actions could not be loaded</h2><p>Return to Hosting accounts and check this account’s connection, then try again.</p></section></section>`;
  }
  const supported = new Set(
    (document as { name: string; supported: boolean }[])
      .filter((entry) => entry.supported)
      .map((entry) => entry.name),
  );
  const provider = isProviderKind(view.provider) ? view.provider : undefined;
  if (!provider || !ENVIRONMENT_PUSH_PROVIDERS.has(provider))
    supported.delete("envs.push");
  if (!supported.has("backups.create") || !supported.has("backups.list"))
    supported.delete("backups.restore");
  const available: string[] = [];
  if (
    provider &&
    NOVAMIRA_SETUP_PROVIDERS.has(provider) &&
    supported.has("wp-cli.run")
  )
    available.push("Install and set up Novamira");
  for (const [capability, label] of Object.entries(ACTION_LABELS)) {
    if (!HQ_PUBLIC_CAPABILITIES.has(capability)) continue;
    if (supported.has(capability)) available.push(label);
  }
  return html`<section class="page flow-page">${header}<p>What you can do with this hosting account through Novamira HQ. Some actions are available through your AI client rather than the dashboard. Availability also depends on your hosting plan, account permissions and environment.</p><section class="panel"><div class="panel-head"><h2>Available with ${providerLabelFor(view.provider)}</h2></div>${available.length ? html`<ul class="provider-action-list">${available.map((label) => html`<li>${label}</li>`)}</ul>` : html`<p class="empty">No actions are currently available for this account.</p>`}</section></section>`;
}
