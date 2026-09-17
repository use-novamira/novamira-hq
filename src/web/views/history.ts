// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  attentionEntries,
  type HistoryEntry,
  type HistoryStatus,
} from "../../history/index.js";
import * as ds from "../datastar.js";
import { copyReport } from "../expr.js";
import {
  html,
  attr,
  idAttr,
  hrefAttr,
  fragmentUrl,
  url,
  type Html,
} from "../html.js";

export type HistoryView = readonly HistoryEntry[];
const LABELS: Record<HistoryStatus, string> = {
  accepted: "Accepted · completion not verified",
  succeeded: "Provider reports completed",
  failed: "Failed",
  needs_verification: "Needs verification",
};

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    "run-wp-cli": "Run WordPress command",
    "push-environment": "Push content",
    "create-backup": "Create backup",
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
    : date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function detail(label: string, value: string | undefined): Html | false {
  return value === undefined
    ? false
    : html`<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

function requestCard(entry: HistoryEntry): Html {
  return html`<article${idAttr(`request-${entry.id}`)} class="history-request"><header class="history-request-head"><div><h3>${actionLabel(entry.action)}</h3><p>${entry.profile} · ${entry.provider}</p></div><div class="history-request-status"><strong>${LABELS[entry.status]}</strong><time>${dateLabel(entry.startedAt)}</time></div></header><details><summary>Request details</summary><dl class="details-list">${detail("Request", entry.action)}${detail("Started", entry.startedAt)}${detail("Last observed", entry.updatedAt)}${detail("Source", entry.channel)}${detail("Site ID", entry.siteId)}${detail("Source environment ID", entry.sourceEnvironmentId)}${detail("Target environment ID", entry.environmentId)}${detail("Scope", entry.scope)}${detail("Provider operation", entry.operationId)}${detail("Request error", entry.errorCode)}${detail("Workflow", entry.workflowKind)}${detail("Workflow ID", entry.workflowId)}${detail("Workflow outcome", entry.workflowStatus)}${detail("Workflow error", entry.workflowErrorCode)}</dl></details></article>`;
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
  const historyUrl = url("/history", profile ? { profile } : {});
  const filter = html`<form class="panel history-filter" method="get" action="/history"><label for="history-profile">Hosting account</label><select id="history-profile" name="profile"><option value="">All accounts</option>${profiles.map((name) => html`<option${attr("value", name)}${name === profile ? attr("selected", "") : false}>${name}</option>`)}</select><button class="button secondary" type="submit">Apply</button></form>`;
  const attention = attentionEntries(entries);
  return html`<section class="page history-page"><header class="page-head"><div><h1>Hosting history</h1><p>Hosting requests made through Novamira HQ on this computer.</p></div><div class="button-row"><a class="button secondary" href="/providers">Back to Hosting accounts</a><a class="button secondary"${hrefAttr(historyUrl)}>Refresh</a></div></header>${filter}<section class="how-to-card"><h2>Needs attention (${attention.length})</h2><p>Check the provider before retrying. Requests with an unconfirmed outcome may still be running.</p>${attention.length === 0 ? html`<p>No recorded failures or uncertain requests.</p>` : html`<ul class="history-attention">${attention.map((entry) => html`<li><a${hrefAttr(fragmentUrl(historyUrl, `request-${entry.id}`))}>${actionLabel(entry.action)} · ${entry.profile}</a><span>${LABELS[entry.status]}${entry.workflowStatus === "failed" ? " · Workflow failed" : ""}</span></li>`)}</ul>`}</section><section class="how-to-card"><div class="report-actions"><h2>Requests (${entries.length})</h2>${entries.length ? html`<button class="button secondary" type="button"${ds.on("click", copyReport("history-copy-report", "history-copy-status"))}>Copy report</button><span id="history-copy-status" role="status" aria-live="polite"></span>` : false}</div><p>Refresh reads local history only; it does not check the provider or repeat operations.</p><details class="history-help"><summary>What this history includes</summary><p>Up to 500 requests; unresolved work is retained. WordPress operations through Novamira CLI (including Novamira HQ MCP) and changes made directly at the provider are not included. Request completion and workflow outcome are shown separately. A failed workflow does not mean its earlier requests were undone.</p></details>${
    entries.length === 0
      ? html`<p>No hosting requests recorded yet.</p>`
      : html`<div class="history-requests">${entries.map(requestCard)}</div><details class="history-help"><summary>Plain-text report</summary><pre id="history-copy-report" class="code-output">${entries
          .map((entry) =>
            Object.entries(entry)
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join("\n"),
          )
          .join("\n\n")}</pre></details>`
  }</section></section>`;
}
