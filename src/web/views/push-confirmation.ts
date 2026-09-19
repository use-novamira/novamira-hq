// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PushConfirmation } from "../services/push-execution.js";
import { post } from "../expr.js";
import { html, hrefAttr, url, type Html } from "../html.js";
import {
  pageHeader,
  panel,
  endpoint,
  technicalDetails,
  actionBar,
  actionButton,
} from "./components.js";

export function renderPushConfirmation(plan: PushConfirmation): Html {
  const submit = actionButton({
    label: "Confirm and push",
    action: post(url("/_dashboard/pushes/apply", { confirmation: plan.id }), {
      include: [],
    }),
    busy: "pushForm.submitting",
    pending: "Starting push… Do not submit again.",
  });
  return html`<section class="page flow-page">${pageHeader("Review push", { description: "Check the destination before confirming.", back: { label: "Cancel", href: url("/push") } })}${panel(html`${endpoint("Copy from", plan.sourceUrl)}${endpoint("Destination — selected content will be overwritten", plan.targetUrl, true)}<p><strong>Content to copy:</strong> ${plan.scope}</p><p class="field-help">Novamira HQ uses the hosting provider's native push. It does not create a separate backup.</p>${actionBar(html`${submit}<a class="button secondary"${hrefAttr(url("/push"))}>Cancel</a>`)}${technicalDetails(html`<p>Source environment: ${plan.source}</p><p>Destination environment: ${plan.target}</p><p>Confirmation expires (UTC): ${plan.expiresAt}</p><p>This confirmation can be used once. If the connection is interrupted, check History and the provider before trying again.</p>`)}`, { title: plan.name, description: plan.profile })}</section>`;
}
