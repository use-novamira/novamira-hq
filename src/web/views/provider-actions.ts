// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isProviderKind } from "../../config/schema.js";
import { hostingInspectionOptions } from "../../hosting/inspection.js";
import {
  HQ_PUBLIC_CAPABILITIES,
  applyHqCapabilityPolicy,
} from "../../hosting/capabilities.js";
import {
  ENVIRONMENT_PUSH_PROVIDERS,
  NOVAMIRA_SETUP_PROVIDERS,
} from "../../hosting/types.js";
import { html, hrefAttr, url, type Html } from "../html.js";
import {
  EMPTY_NOTICE,
  providerLabelFor,
  type DashboardNotice,
} from "./types.js";
import { renderNotice } from "./layout.js";

export interface ProviderActionsView {
  readonly profile: string;
  readonly provider: string;
  readonly capabilities?: unknown;
  /** Only after a new account was saved and live access was verified. */
  readonly added?: boolean;
}

/** Only actions exposed through the dashboard or typed AI tools belong here. */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  "cache.clear": "Clear cache",
  "logs.get": "Read site logs",
  "activity.list": "Read provider activity",
  "analytics.usage": "Read site usage statistics",
  "analytics.env": "Read environment statistics",
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
  "cache.clear": ["hosting_cache_clear"],
  "logs.get": ["hosting_logs_get"],
  "activity.list": ["hosting_activity_list"],
  "analytics.usage": ["hosting_statistics_get"],
  "analytics.env": ["hosting_statistics_get"],
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

export interface ProviderActionGroups {
  readonly app: readonly string[];
  readonly ai: readonly string[];
}

/** Adapter support is necessary, but not sufficient: each surface must expose it. */
export function providerActionGroups(
  view: ProviderActionsView,
): ProviderActionGroups | undefined {
  const document = applyHqCapabilityPolicy(view.capabilities);
  if (
    !isProviderKind(view.provider) ||
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
  )
    return undefined;
  const provider = view.provider;
  const supported = new Set(
    (document as { name: string; supported: boolean }[])
      .filter((entry) => entry.supported)
      .map((entry) => entry.name),
  );
  if (!ENVIRONMENT_PUSH_PROVIDERS.has(provider)) supported.delete("envs.push");
  if (!supported.has("backups.create") || !supported.has("backups.list"))
    supported.delete("backups.restore");

  const app: string[] = [];
  const ai: string[] = [];
  if (
    NOVAMIRA_SETUP_PROVIDERS.has(provider) &&
    (supported.has("wp-cli.run") || supported.has("novamira.setup"))
  ) {
    app.push("Install and set up Novamira");
    ai.push("Install and set up Novamira");
  }
  const appCapabilities = new Set([
    "providers.validate",
    "sites.list",
    "envs.list",
    "envs.push",
    ...hostingInspectionOptions(provider).map((option) => option.capability),
  ]);
  // Keep these aligned with the concrete entry points in the Sites row menu.
  if (
    [
      "kinsta",
      "pantheon",
      "rocketnet",
      "wpengine",
      "cloudways",
      "instawp",
    ].includes(provider)
  )
    appCapabilities.add("backups.create");
  if (["kinsta", "pantheon", "rocketnet", "instawp"].includes(provider))
    appCapabilities.add("backups.restore");

  for (const [capability, defaultLabel] of Object.entries(ACTION_LABELS)) {
    if (!HQ_PUBLIC_CAPABILITIES.has(capability) || !supported.has(capability))
      continue;
    let label = defaultLabel;
    if (provider === "instawp" && capability.startsWith("backups."))
      label = `${defaultLabel} (InstaWP Site Versions)`;
    if (provider === "cloudways" && capability === "activity.list")
      label = "Read staging deployment activity";
    // Inspection tools have a second typed allowlist, shared by dashboard/MCP.
    if (
      [
        "cache.clear",
        "logs.get",
        "activity.list",
        "analytics.usage",
        "analytics.env",
        "backups.list",
      ].includes(capability) &&
      !appCapabilities.has(capability)
    )
      continue;
    if (appCapabilities.has(capability)) app.push(label);
    ai.push(label);
  }
  return { app, ai };
}

function actionPanel(
  title: string,
  description: string,
  actions: readonly string[],
): Html {
  return html`<section class="panel"><div class="panel-head"><div><h2>${title}</h2><p>${description}</p></div></div>${
    actions.length
      ? html`<ul class="provider-action-list">${actions.map((label) => html`<li>${label}</li>`)}</ul>`
      : html`<p class="empty">No actions are currently available for this account.</p>`
  }</section>`;
}

export function renderProviderActionsPage(
  view: ProviderActionsView,
  notice: DashboardNotice = EMPTY_NOTICE,
): Html {
  const groups = providerActionGroups(view);
  return html`<section class="page flow-page provider-actions-page"><header class="page-head"><div><h1>${view.added ? "Hosting account ready" : "Available actions"}</h1><p>${view.profile} · ${providerLabelFor(view.provider)}</p></div><a class="button secondary"${hrefAttr(url("/hosting-accounts"))}>Back to Hosting accounts</a></header>${view.added && notice.level === "ok" ? false : renderNotice(notice)}<p>Here’s what you can do with this hosting account.</p>${
    groups
      ? html`${actionPanel("In the app", "Select a site in Sites to see its available actions.", groups.app)}${actionPanel("With your AI", "Connect your AI client, then ask it to perform these actions.", groups.ai)}<p class="field-help">Some actions depend on your hosting plan and permissions.</p>`
      : html`<section class="empty empty-block"><h2>Available actions could not be loaded</h2><p>The account remains saved. Open Available actions from this account's menu to try again.</p></section>`
  }<section class="panel"><div class="panel-head"><div><h2>Connect your sites separately</h2><p>Adding a hosting account does not authorize access to WordPress. In Sites, set up Novamira where supported and authorize each site in your browser. Your AI can use site tools only after that separate connection, and only for the abilities the site exposes.</p><p>Hosting credentials stay on this computer. Do not paste them into an AI conversation.</p></div></div></section><div class="button-row"><a class="button primary"${hrefAttr(url("/sites"))}>View sites</a><a class="button secondary"${hrefAttr(url("/configure-ai"))}>Configure your AI</a></div></section>`;
}
