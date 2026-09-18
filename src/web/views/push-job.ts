// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PushJob } from "../services/push-execution.js";
import * as ds from "../datastar.js";
import { getStream } from "../expr.js";
import { html, hrefAttr, url, type Html } from "../html.js";

const LABELS: Record<PushJob["status"], string> = {
  running: "Push in progress",
  completed: "Push completed",
  failed: "Push did not start",
  needs_verification: "Push outcome needs verification",
};

export function renderPushJob(job: PushJob): Html {
  const plan = job.confirmation;
  const running = job.status === "running";
  return html`<section class="page"${running ? ds.init(getStream(url("/_dashboard/pushes/status", { job: plan.id }), { include: [] })) : false}><header class="page-head"><div><h1>${LABELS[job.status]}</h1><p>${plan.name}</p></div><a class="button secondary"${hrefAttr(url("/push"))}>All pushes</a></header><section class="panel push-review flow-panel"><div role="status">${running ? html`<span class="spinner" aria-hidden="true"></span> ` : false}<strong>${job.message}</strong></div><div class="push-review-endpoint"><span class="eyebrow">Copy from</span><strong class="push-review-url">${plan.sourceUrl}</strong></div><div class="push-review-endpoint push-review-target"><span class="eyebrow">Destination</span><strong class="push-review-url">${plan.targetUrl}</strong></div><p>Content: ${plan.scope}</p><p class="field-help">Started: ${new Date(job.startedAt).toISOString()}${job.finishedAt === null ? false : html` · Finished: ${new Date(job.finishedAt).toISOString()}`}</p>${running ? html`<p>This page updates automatically when the provider finishes. You can return to this job from Push. Keep Novamira HQ running; closing this browser tab does not cancel the push.</p>` : job.status === "needs_verification" ? html`<p class="notice warn">Do not repeat the push until you have checked the provider and History. A lost response does not mean the operation failed.</p>` : false}<div class="button-row"><a class="button secondary"${hrefAttr(url("/push", { job: plan.id }))}>Refresh status</a><a class="button secondary"${hrefAttr(url("/hosting-activity"))}>View History</a></div></section></section>`;
}

export function renderPushJobs(jobs: readonly PushJob[]): Html | false {
  if (jobs.length === 0) return false;
  return html`<section class="panel push-review"><h2>Recent push jobs</h2><p class="field-help">Jobs from this dashboard session. Earlier provider requests remain in History.</p>${jobs.map((job) => html`<a class="push-job-link"${hrefAttr(url("/push", { job: job.confirmation.id }))}><strong>${LABELS[job.status]}</strong><span>${job.confirmation.targetUrl}</span><small>${job.confirmation.name} · ${new Date(job.startedAt).toISOString()}</small></a>`)}</section>`;
}
