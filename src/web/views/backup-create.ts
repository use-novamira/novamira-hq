// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RestoreView } from "./restore.js";
import { html, hrefAttr, url, type Html } from "../html.js";
import * as ds from "../datastar.js";
import { getStream, post } from "../expr.js";

import {
  pageHeader,
  actionButton,
  panel,
  actionBar,
  operationStatus,
  technicalDetails,
  endpoint,
} from "./components.js";

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
  const body = html`${target ? html`${endpoint("Site", target.targetUrl)}<p class="field-help">${target.profile}</p>` : false}${job ? html`${operationStatus(running ? "The backup is being created. Keep Novamira HQ open while it checks the result." : job.status === "completed" ? "Your backup is ready." : "Novamira HQ could not confirm whether the backup was created. Open the backup list and check before creating another one.", running)}${actionBar(html`<a class="button secondary"${hrefAttr(url("/backup-restore", { profile: job.review.profile, site: job.review.site, env: job.review.env }))}>View backups</a><a${hrefAttr(url("/hosting-activity", { profile: job.review.profile }))}>View history</a>`)}` : review ? html`<p>A copy of this site’s files and database will be saved with your hosting account. Your site will not be overwritten.</p>${target?.provider === "instawp" ? html`<p class="field-help">Saved as an InstaWP Site Version.</p>` : false}${actionBar(submit("Create backup", "/_dashboard/backups/apply", { confirmation: review.id }))}` : view.target.profile ? html`<div${!view.error ? ds.init(post(url("/_dashboard/backups/create-plan", { ...view.target }), { include: [] })) : false}>${view.error ? submit("Try again", "/_dashboard/backups/create-plan", { ...view.target }) : operationStatus("Loading site details…", true)}</div>` : html`<p>Select Create backup from a site’s menu in Sites.</p>`}${target ? technicalDetails(html`<p>Environment: ${target.env}</p><p>Backup label: ${target.backupId}</p><p>The backup stays with your hosting account, not on this computer.</p>`) : false}`;
  const recent =
    view.jobs?.filter((item) => item.review.operation === "create") ?? [];
  return html`<section class="page flow-page"${running ? ds.init(getStream(url("/_dashboard/backups/status", { job: job.review.id }), { include: [] })) : false}>${pageHeader(title, { back: { label: "Back to Sites", href: url("/sites") } })}${view.error ? html`<p class="notice danger" role="alert">${view.error}</p>` : false}${panel(body)}${recent.length ? panel(html`${recent.map((item) => html`<p><a${hrefAttr(url("/backup-create", { job: item.review.id }))}>${item.review.targetUrl.replace(/^https?:\/\//i, "")} · ${item.status === "completed" ? "Completed" : item.status === "running" ? "In progress" : "Not confirmed"}</a></p>`)}`, { title: "Recent backups" }) : false}</section>`;
}
