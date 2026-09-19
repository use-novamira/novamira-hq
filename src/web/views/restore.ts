// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  RestoreCatalog,
  RestoreJob,
  RestoreReview,
  RestoreTarget,
} from "../services/restore.js";
import { html, hrefAttr, attr, url, type Html } from "../html.js";
import * as ds from "../datastar.js";
import { getStream, post } from "../expr.js";
import { renderBackupCreate } from "./backup-create.js";

export interface RestoreView {
  readonly create?: boolean;
  readonly target: RestoreTarget;
  readonly catalog?: RestoreCatalog;
  readonly review?: RestoreReview;
  readonly job?: RestoreJob;
  readonly jobs?: readonly RestoreJob[];
  readonly error?: string;
}
import { pageHeader, actionButton } from "./components.js";

export function renderRestore(view: RestoreView): Html {
  if (
    view.create ||
    view.review?.operation === "create" ||
    view.job?.review.operation === "create"
  )
    return renderBackupCreate(view);
  const submit = (
    label: string,
    endpoint: string,
    params: Record<string, string>,
    form = false,
  ) =>
    actionButton({
      label,
      action: post(url(endpoint, params), {
        include: form ? ["restoreForm"] : [],
      }),
      busy: "restoreForm.submitting",
      pending: "Please wait…",
    });
  let body: Html;
  const { job, review, catalog } = view;
  if (job) {
    body = html`<section${job.status === "running" ? ds.init(getStream(url("/_dashboard/backups/status", { job: job.review.id }), { include: [] })) : false}><h2>${job.status === "completed" ? "Restore completed" : job.status === "running" ? "Restore in progress" : "Outcome needs verification"}</h2><p class="push-review-url">${job.review.targetUrl}</p><p>Backup: ${job.review.backupId}</p><p role="status">${job.status === "running" ? "Creating and verifying a safety backup, then restoring the selected backup. Waiting for the hosting provider. Keep Novamira HQ running." : job.status === "completed" ? "The hosting provider reports that the restore completed." : "The restore could not be confirmed. Check hosting Activity and your provider before trying again; the operation may still be running."}</p><a class="button secondary"${hrefAttr(url("/backup-restore", { job: job.review.id }))}>Refresh status</a><a class="button secondary"${hrefAttr(url("/hosting-activity", { profile: job.review.profile }))}>View Activity</a></section>`;
  } else if (review) {
    body = html`<h2>Confirm backup restore</h2><p>Hosting account: ${review.profile}</p><p class="push-review-url">${review.targetUrl}</p><p>Environment: ${review.env}</p><p>Backup: ${review.backupId}</p><p class="notice warn">All files and the database on this destination will be overwritten. HQ must successfully create a fresh safety backup before restoring.</p><p>Confirmation expires: ${new Date(review.expiresAt).toISOString()}</p>${submit("Confirm and restore", "/_dashboard/backups/apply", { confirmation: review.id })}`;
  } else if (catalog) {
    body = html`<h2>Select a backup</h2><p>Hosting account: ${catalog.target.profile}</p><p class="push-review-url">${catalog.targetUrl}</p><p>Environment: ${catalog.target.env}</p>${catalog.backups.length ? html`<div class="field"><label for="restore-backup">Backup</label><select id="restore-backup"${ds.bind("restoreForm.backupId")}><option value="">Select a backup</option>${catalog.backups.map((backup) => html`<option${attr("value", backup.id)}>${backup.label}</option>`)}</select></div>${catalog.provider === "kinsta" ? html`<div class="field"><label for="restore-user">Kinsta user ID to notify</label><input id="restore-user" type="text"${ds.bind("restoreForm.notifiedUserId")}><p class="field-help">Kinsta requires the ID of the user who will receive the restore notification.</p></div>` : false}<label><input type="checkbox"${ds.bind("restoreForm.allContent")}> I understand that all files and the database on this destination will be overwritten.</label><p>A fresh safety backup must complete before the restore starts.</p>${submit("Review restore", "/_dashboard/backups/plan", { ...catalog.target }, true)}` : html`<p>No selectable backups were returned for this environment.</p>`}`;
  } else {
    body = html`<h2>Restore a backup</h2>${view.target.profile ? html`<div${!view.error ? ds.init(post(url("/_dashboard/backups/catalog", { ...view.target }), { include: [] })) : false}><p role="status">Loading available backups…</p>${view.error ? submit("Try again", "/_dashboard/backups/catalog", { ...view.target }) : false}</div>` : html`<p>Select Restore backup from a hosting environment’s menu in Sites.</p>`}`;
  }
  return html`<section class="page flow-page">${pageHeader("Restore backup", { back: { label: "Back to Sites", href: url("/sites") } })}${view.error ? html`<p class="notice danger" role="alert">${view.error}</p>` : false}<section class="panel push-review flow-panel">${body}</section>${view.jobs?.some((item) => item.review.operation !== "create") ? html`<section class="panel push-review"><h2>Recent restores</h2>${view.jobs.filter((item) => item.review.operation !== "create").map((job) => html`<p><a${hrefAttr(url("/backup-restore", { job: job.review.id }))}>${job.review.targetUrl} · ${job.status === "completed" ? "Completed" : job.status === "running" ? "In progress" : "Outcome not confirmed"}</a></p>`)}</section>` : false}</section>`;
}
