// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  attentionEntries,
  type HistoryEntry,
  type HistoryStatus,
} from "../../history/index.js";
import { html, type Html } from "../html.js";

export type HistoryView = readonly HistoryEntry[];
const LABELS: Record<HistoryStatus, string> = {
  accepted: "Accepted · completion not verified",
  succeeded: "Provider reports completed",
  failed: "Failed",
  needs_verification: "Needs verification",
};

export function renderHistoryPage(entries: HistoryView): Html {
  const attention = attentionEntries(entries);
  return html`<section class="page"><header class="page-head"><div><h1 style="font-size: clamp(28px, 4vw, 36px)">Hosting history</h1><p>Recent hosting requests made through HQ on this machine. WordPress operations through Novamira CLI (including HQ MCP) and changes made directly at the provider are not included.</p></div><div class="button-row"><a class="button secondary" href="/diagnostics">Back to Diagnostics</a><a class="button secondary" href="/history">Refresh</a></div></header><section class="how-to-card"><h2>Needs attention (${attention.length})</h2><p>Failures and requests whose outcome could not be confirmed. Check the provider before repeating an action. An unconfirmed request may still be running; this is not an automatic site health check.</p>${attention.length === 0 ? html`<p>No recorded failures or uncertain requests.</p>` : html`<ul>${attention.map((entry) => html`<li>${entry.profile} · ${entry.action} · ${entry.environmentId ?? entry.siteId ?? "target not recorded"} — ${LABELS[entry.status]}${entry.errorCode === undefined ? false : html` (${entry.errorCode})`}${entry.workflowErrorCode ? html` · Workflow: ${entry.workflowErrorCode}` : false} · Last observed: ${entry.updatedAt}. Next: check ${entry.operationId ? html`provider operation ${entry.operationId}` : html`the target in the provider dashboard`} before retrying.</li>`)}</ul>`}</section><section class="how-to-card"><h2>Requests</h2><p>Up to 500 requests; unresolved work is retained. Refresh reads local history only: it does not poll the provider or repeat operations. Request completion and workflow outcome are shown separately. A failed workflow does not mean its earlier requests were undone.</p>${entries.length === 0 ? html`<p>No hosting requests recorded yet.</p>` : html`<div class="table-wrap"><table><thead><tr><th>Started / last observed (UTC)</th><th>Source</th><th>Profile / provider</th><th>Request / target</th><th>Workflow</th><th>Outcome</th><th>Provider operation</th></tr></thead><tbody>${entries.map((entry) => html`<tr><td>${entry.startedAt}<br>${entry.updatedAt}</td><td>${entry.channel}</td><td>${entry.profile}<br>${entry.provider}</td><td>${entry.action}<br>${entry.sourceEnvironmentId ? html`${entry.sourceEnvironmentId} → ` : false}${entry.environmentId ?? entry.siteId ?? "—"}${entry.scope ? html`<br>${entry.scope}` : false}</td><td>${entry.workflowKind ?? "standalone"}<br>${entry.workflowId ?? "—"}<br>${entry.workflowStatus ?? "—"}${entry.workflowErrorCode ? html`<br>${entry.workflowErrorCode}` : false}</td><td>${LABELS[entry.status]}${entry.errorCode === undefined ? false : html`<br>${entry.errorCode}`}</td><td>${entry.operationId ?? "—"}</td></tr>`)}</tbody></table></div>`}</section></section>`;
}
