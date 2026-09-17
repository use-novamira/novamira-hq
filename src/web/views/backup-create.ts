// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RestoreView } from "./restore.js";
import { html, hrefAttr, url, type Html } from "../html.js";
import * as ds from "../datastar.js";
import { getStream, post, seq, set, jsBoolean, signal } from "../expr.js";

export function renderBackupCreate(view: RestoreView): Html {
  const { job, review } = view;
  const target = job?.review ?? review;
  const running = job?.status === "running";
  const submit = (
    label: string,
    endpoint: string,
    params: Record<string, string>,
  ) =>
    html`<button class="button primary" type="button"${ds.attrs({ disabled: signal("restoreForm.submitting") })}${ds.on("click", seq(set("restoreForm.submitting", jsBoolean(true)), post(url(endpoint, params), { include: [] })))}>${label}</button><span class="loading-inline ds-toggle"${ds.classes({ open: signal("restoreForm.submitting") })} role="status">Contacting your hosting provider… Please wait.</span>`;
  return html`<section class="page flow-page"${running ? ds.init(getStream(url("/_dashboard/backups/status", { job: job.review.id }), { include: [] })) : false}><header class="page-head"><div><h1>Create backup</h1><p>Save a backup with your hosting provider.</p></div><a class="button secondary"${hrefAttr(url("/sites"))}>Back to Sites</a></header>${view.error ? html`<p class="notice danger" role="alert">${view.error}</p>` : false}<section class="panel push-review flow-panel">${target?.provider === "instawp" ? html`<p class="notice">InstaWP saves a Site Version: a copy of this site’s files and database that can be restored onto the same site. Availability and limits depend on your InstaWP plan. Version labels are limited to 25 characters.</p>` : false}${target ? html`<p>Hosting account: ${target.profile}</p><p class="push-review-url">${target.targetUrl}</p><p>Environment: ${target.env}</p><p>Backup label: ${target.backupId}</p>` : html`<p>Review the selected environment before creating its backup.</p>`}${job ? html`<h2>${running ? "Creating backup…" : job.status === "completed" ? "Backup completed" : "Outcome needs verification"}</h2><p role="status">${running ? "Waiting for the hosting provider. Keep Novamira HQ running; closing this browser tab does not cancel the operation." : job.status === "completed" ? "The hosting provider reports that the backup completed." : "The backup could not be confirmed. Check Activity and your hosting provider before retrying; it may still be running."}</p><div class="button-row"><a class="button secondary"${hrefAttr(url("/backup-create", { job: job.review.id }))}>Refresh status</a><a class="button secondary"${hrefAttr(url("/history", { profile: job.review.profile }))}>View Activity</a></div>` : review ? html`<p>This creates a backup; it does not restore or overwrite your site. Provider retention rules and plan limits apply. The backup stays with your provider, not on this computer.</p>${submit("Confirm and create backup", "/_dashboard/backups/apply", { confirmation: review.id })}` : view.target.profile ? submit("Review backup", "/_dashboard/backups/create-plan", { ...view.target }) : html`<p>Select Create backup from an environment’s menu in Sites.</p>`}</section>${view.jobs?.length ? html`<section class="panel push-review"><h2>Recent backups</h2>${view.jobs.filter((job) => job.review.operation === "create").map((job) => html`<p><a${hrefAttr(url("/backup-create", { job: job.review.id }))}>${job.review.targetUrl} · ${job.status}</a></p>`)}</section>` : false}</section>`;
}
