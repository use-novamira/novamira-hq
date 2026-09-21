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
import {
  pageHeader,
  actionButton,
  panel,
  endpoint,
  field,
  actionBar,
  technicalDetails,
  operationStatus,
  confirmationCheckbox,
} from "./components.js";

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
    body = html`<div${job.status === "running" ? ds.init(getStream(url("/_dashboard/backups/status", { job: job.review.id }), { include: [] })) : false}></div>${endpoint("Site", job.review.targetUrl)}${operationStatus(job.status === "running" ? "Restoring your selected backup. Keep Novamira HQ open while it checks the result." : job.status === "completed" ? "Your backup has been restored." : "Novamira HQ could not confirm whether the restore completed. Check the site and your hosting account before trying again; the restore may still be running.", job.status === "running")}${actionBar(html`<a class="button secondary"${hrefAttr(url("/sites"))}>Back to Sites</a><a${hrefAttr(url("/hosting-activity", { profile: job.review.profile }))}>View history</a>`)}${technicalDetails(html`<p>Hosting account: ${job.review.profile}</p><p>Environment: ${job.review.env}</p><p>Backup: ${job.review.backupId}</p>`)}`;
  } else if (review) {
    body = html`${endpoint("Site to restore", review.targetUrl, true)}<p>Backup: ${review.backupId}</p><p class="notice warn">All files and the database on this site will be overwritten. No new backup will be created by HQ.</p>${actionBar(submit("Confirm and restore", "/_dashboard/backups/apply", { confirmation: review.id }))}${technicalDetails(html`<p>Hosting account: ${review.profile}</p><p>Environment: ${review.env}</p><p>Confirmation expires: ${new Date(review.expiresAt).toISOString()}</p>`)}`;
  } else if (catalog) {
    body = html`${endpoint("Site", catalog.targetUrl)}${catalog.backups.length ? html`${field("Backup to restore", html`<select id="restore-backup"${ds.bind("restoreForm.backupId")}><option value="">Select a backup</option>${catalog.backups.map((backup) => html`<option${attr("value", backup.id)}>${backup.label}</option>`)}</select>`)}${catalog.provider === "kinsta" ? field("Kinsta user ID to notify", html`<input id="restore-user" type="text"${ds.bind("restoreForm.notifiedUserId")}>`, "Kinsta requires the ID of the user who will receive the restore notification.") : false}${confirmationCheckbox("I understand that all files and the database on this destination will be overwritten.", "restoreForm.allContent")}<p>Creating a backup is a separate action. HQ does not create one before restoring.</p>${actionBar(submit("Continue", "/_dashboard/backups/plan", { ...catalog.target }, true))}` : operationStatus("No backups are available to restore for this site.")}${technicalDetails(html`<p>Hosting account: ${catalog.target.profile}</p><p>Environment: ${catalog.target.env}</p>`)}`;
  } else {
    body = html`${view.target.profile ? html`<div${!view.error ? ds.init(post(url("/_dashboard/backups/catalog", { ...view.target }), { include: [] })) : false}>${view.error ? submit("Try again", "/_dashboard/backups/catalog", { ...view.target }) : operationStatus("Loading available backups…", true)}</div>` : html`<p>Select Restore backup from a site’s menu in Sites.</p>`}`;
  }
  const title = job
    ? job.status === "completed"
      ? "Restore completed"
      : job.status === "running"
        ? "Restoring backup…"
        : "Restore not confirmed"
    : review
      ? "Confirm restore"
      : "Restore backup";
  const recent =
    view.jobs?.filter((item) => item.review.operation !== "create") ?? [];
  return html`<section class="page flow-page">${pageHeader(title, { back: { label: "Back to Sites", href: url("/sites") } })}${view.error ? html`<p class="notice danger" role="alert">${view.error}</p>` : false}${panel(body)}${recent.length ? panel(html`${recent.map((item) => html`<p><a${hrefAttr(url("/backup-restore", { job: item.review.id }))}>${item.review.targetUrl.replace(/^https?:\/\//i, "")} · ${item.status === "completed" ? "Completed" : item.status === "running" ? "In progress" : "Not confirmed"}</a></p>`)}`, { title: "Recent restores" }) : false}</section>`;
}
