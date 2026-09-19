// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PushJob } from "../services/push-execution.js";
import * as ds from "../datastar.js";
import { getStream } from "../expr.js";
import { html, hrefAttr, url, type Html } from "../html.js";

import {
  pageHeader,
  panel,
  endpoint,
  operationStatus,
  technicalDetails,
  actionBar,
  actionButton,
} from "./components.js";

const LABELS: Record<PushJob["status"], string> = {
  running: "Push in progress",
  completed: "Push completed",
  failed: "Push failed",
  needs_verification: "Check previous push",
};

function elapsed(job: PushJob): Html {
  if (job.status === "needs_verification")
    return html`<span>Started <span${ds.checkedAt(job.startedAt)}>${new Date(job.startedAt).toLocaleDateString("en-GB")}</span> · outcome unconfirmed</span>`;
  const label =
    job.status === "running"
      ? "In progress for"
      : job.finishedAt === null
        ? "Started"
        : "Observed duration";
  const seconds = Math.max(
    0,
    Math.floor(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000),
  );
  return html`<span>${label} <span${ds.jobStartedAt(job.startedAt)}${ds.jobFinishedAt(job.finishedAt)}>${Math.floor(seconds / 60)} min ${seconds % 60} s</span>${job.finishedAt === null && job.status !== "running" ? " ago · status to verify" : false}</span>`;
}

export function renderPushJob(job: PushJob): Html {
  const plan = job.confirmation;
  const running = job.status === "running";
  const unresolved = running || job.status === "needs_verification";
  const actions = actionBar(
    html`${unresolved ? actionButton({ label: "Check result", action: getStream(url("/_dashboard/pushes/status", { job: plan.id, refresh: "1" }), { include: [] }), busy: "pushForm.submitting", pending: "Checking previous push…" }) : false}<a class="button secondary"${hrefAttr(url("/hosting-activity"))}>View history</a>`,
  );
  const body = panel(
    html`${operationStatus(job.message, running)}<p>${elapsed(job)}</p>${endpoint("Copy from", plan.sourceUrl)}${endpoint("Destination", plan.targetUrl, true)}<p>Content: ${plan.scope}</p>${unresolved ? html`<p class="field-help">${running ? "You can close Novamira HQ. Monitoring resumes when you reopen it." : "Do not repeat this push until you have checked its outcome."}</p>` : false}${actions}${technicalDetails(html`<p>Source: ${plan.source}</p><p>Destination: ${plan.target}</p><p>Started: ${new Date(job.startedAt).toISOString()}</p>${job.operationId ? html`<p>Operation: ${job.operationId}</p>` : false}`)}`,
  );
  return html`<section class="page flow-page"${unresolved ? ds.init(getStream(url("/_dashboard/pushes/status", { job: plan.id }), { include: [] })) : false}>${pageHeader(LABELS[job.status], { description: plan.name, back: { label: "All pushes", href: url("/push") } })}${body}</section>`;
}

export function renderPushJobs(jobs: readonly PushJob[]): Html | false {
  if (jobs.length === 0) return false;
  return panel(
    html`${jobs.map((job) => html`<a class="push-job-link"${hrefAttr(url("/push", { job: job.confirmation.id }))}><strong>${LABELS[job.status]}</strong><span>${job.confirmation.sourceUrl.replace(/^https?:\/\//i, "")} → ${job.confirmation.targetUrl.replace(/^https?:\/\//i, "")}</span><small>${job.confirmation.name} · ${elapsed(job)}</small></a>`)}`,
    {
      title: "Push history",
      description: "Saved on this computer. Unfinished pushes appear first.",
    },
  );
}
