// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RestoreView } from "./restore.js";
import { html, hrefAttr, url, type Html } from "../html.js";
import * as ds from "../datastar.js";
import { getStream, post } from "../expr.js";

import { pageHeader, actionButton } from "./components.js";

export function renderBackupCreate(view: RestoreView): Html {
  const { job, review } = view;
  const target = job?.review ?? review;
  const running = job?.status === "running";
  const submit = (
    label: string,
    endpoint: string,
    params: Record<string, string>,
  ) =>
    actionButton({
      label,
      action: post(url(endpoint, params), { include: [] }),
      busy: "restoreForm.submitting",
      pending: "Please wait…",
    });
  const title = job
    ? running
      ? "Creating backup…"
      : job.status === "completed"
        ? "Backup completed"
        : "Backup not confirmed"
    : "Create backup";
  return html`<section class="page flow-page"${running ? ds.init(getStream(url("/_dashboard/backups/status", { job: job.review.id }), { include: [] })) : false}>${pageHeader(title, { back: { label: "Back to Sites", href: url("/sites") } })}${view.error ? html`<p class="notice danger" role="alert">${view.error}</p>` : false}<section class="panel push-review flow-panel">${target ? html`<h2>${target.targetUrl.replace(/^https?:\/\//i, "")}</h2><p class="field-help">${target.profile}</p>` : html`<p role="status">Loading site details…</p>`}${job ? html`<p role="status">${running ? "The backup is being created. Keep Novamira HQ open while it checks the result." : job.status === "completed" ? "Your backup is ready." : "Novamira HQ could not confirm the result. Check your backups before creating another one."}</p><div class="button-row"><a class="button secondary"${hrefAttr(url("/backup-restore", { profile: job.review.profile, site: job.review.site, env: job.review.env }))}>View backups</a><a class="text-link"${hrefAttr(url("/hosting-activity", { profile: job.review.profile }))}>View history</a></div>` : review ? html`<p>A copy of this site’s files and database will be saved with your hosting account. Your site will not be overwritten.</p>${target?.provider === "instawp" ? html`<p class="field-help">Saved as an InstaWP Site Version.</p>` : false}${submit("Create backup", "/_dashboard/backups/apply", { confirmation: review.id })}` : view.target.profile ? html`<div${!view.error ? ds.init(post(url("/_dashboard/backups/create-plan", { ...view.target }), { include: [] })) : false}>${view.error ? submit("Try again", "/_dashboard/backups/create-plan", { ...view.target }) : false}</div>` : html`<p>Select Create backup from a site’s menu in Sites.</p>`}${target ? html`<details><summary>Details</summary><dl class="details-list"><div><dt>Environment</dt><dd>${target.env}</dd></div><div><dt>Backup label</dt><dd>${target.backupId}</dd></div></dl><p>Availability and retention depend on your plan. The backup stays with your hosting provider, not on this computer.</p></details>` : false}</section>${view.jobs?.some((item) => item.review.operation === "create") ? html`<section class="panel push-review"><h2>Recent backups</h2>${view.jobs.filter((item) => item.review.operation === "create").map((item) => html`<p><a${hrefAttr(url("/backup-create", { job: item.review.id }))}>${item.review.targetUrl.replace(/^https?:\/\//i, "")} · ${item.status === "completed" ? "Completed" : item.status === "running" ? "In progress" : "To verify"}</a></p>`)}</section>` : false}</section>`;
}
