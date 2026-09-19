// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  attentionEntries,
  type HistoryEntry,
  type HistoryStatus,
} from "../../history/index.js";
import * as ds from "../datastar.js";
import { copyReport } from "../expr.js";
import { html, attr, idAttr, hrefAttr, url, type Html } from "../html.js";

export type HistoryView = readonly HistoryEntry[];
const LABELS: Record<HistoryStatus, string> = {
  accepted: "Awaiting confirmation",
  succeeded: "Completed",
  failed: "Failed",
  needs_verification: "To verify",
};

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    "run-wp-cli": "WordPress operation",
    "push-environment": "Push",
    "create-backup": "Backup",
    "restore-backup": "Restore backup",
  };
  return (
    labels[action] ??
    action.replaceAll("-", " ").replace(/^./, (c) => c.toUpperCase())
  );
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function detail(label: string, value: string | undefined): Html | false {
  return value === undefined
    ? false
    : html`<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

function requestCard(entry: HistoryEntry): Html {
  const uncertain =
    entry.status === "accepted" || entry.status === "needs_verification";
  return html`<article${idAttr(`request-${entry.id}`)} class="history-request"><header class="history-request-head"><div><h3>${actionLabel(entry.action)}</h3><p>${entry.targetUrl ?? entry.profile}</p></div><div class="history-request-status"><strong>${LABELS[entry.status]}</strong><time>${dateLabel(entry.startedAt)}</time></div></header>${uncertain ? html`<p class="field-help">Completion has not been confirmed. Check before repeating this action.</p>` : false}${entry.action === "push-environment" ? html`<a class="text-link"${hrefAttr(url("/push", { job: entry.pushJobId ?? entry.id }))}>Open push and check status</a>` : false}<details><summary>Request details</summary><dl class="details-list">${detail("Request", entry.action)}${detail("Hosting account", entry.profile)}${detail("Started", entry.startedAt)}${detail("Last observed", entry.updatedAt)}${detail("Source", entry.channel)}${detail("Site ID", entry.siteId)}${detail("Source environment ID", entry.sourceEnvironmentId)}${detail("Target environment ID", entry.environmentId)}${detail("Scope", entry.scope)}${detail("Provider operation", entry.operationId)}${detail("Request error", entry.errorCode)}${detail("Workflow", entry.workflowKind)}${detail("Workflow ID", entry.workflowId)}${detail("Workflow outcome", entry.workflowStatus)}${detail("Workflow error", entry.workflowErrorCode)}</dl></details></article>`;
}

export function renderHistoryPage(
  allEntries: HistoryView,
  profile = "",
  configuredProfiles: readonly string[] = [],
): Html {
  const entries = profile
    ? allEntries.filter((entry) => entry.profile === profile)
    : allEntries;
  const profiles = [
    ...new Set([
      ...configuredProfiles,
      ...allEntries.map((entry) => entry.profile),
      ...(profile ? [profile] : []),
    ]),
  ].sort();
  const historyUrl = url("/hosting-activity", profile ? { profile } : {});
  const attention = attentionEntries(entries);
  return html`<section class="page history-page"><header class="page-head"><div><h1>Hosting history</h1><p>Your recent hosting actions.</p></div><div class="button-row"><a class="button secondary" href="/hosting-accounts">Hosting accounts</a><a class="button secondary"${hrefAttr(historyUrl)}>Refresh list</a></div></header><form class="panel history-filter" method="get" action="/hosting-activity"><label for="history-profile">Hosting account</label><select id="history-profile" name="profile"><option value="">All accounts</option>${profiles.map((name) => html`<option${attr("value", name)}${name === profile ? attr("selected", "") : false}>${name}</option>`)}</select><button class="button secondary" type="submit">Apply</button></form><section class="how-to-card">${attention.length ? html`<p class="field-help">Needs attention (${attention.length}) · See the status beside each action below.</p>` : false}${entries.length ? html`<div class="history-requests">${entries.map(requestCard)}</div>` : html`<p>No hosting actions yet.</p>`}<details class="history-help"><summary>Technical report</summary><p>Refresh reads local history only; it does not check the provider or repeat operations. To check a push, open its job.</p><p>Up to 500 requests are kept; unresolved work is retained. WordPress actions through Novamira CLI and changes made outside Novamira HQ are not included. A failed workflow does not undo its earlier requests.</p>${
    entries.length
      ? html`<button class="button secondary" type="button"${ds.on("click", copyReport("history-copy-report", "history-copy-status"))}>Copy report</button><span id="history-copy-status" role="status" aria-live="polite"></span><pre id="history-copy-report" class="code-output">${entries
          .map((entry) =>
            Object.entries(entry)
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join("\n"),
          )
          .join("\n\n")}</pre>`
      : false
  }</details></section></section>`;
}
