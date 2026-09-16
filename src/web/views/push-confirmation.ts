// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PushConfirmation } from "../services/push-execution.js";
import * as ds from "../datastar.js";
import { post, seq, set, jsBoolean, signal } from "../expr.js";
import { html, hrefAttr, url, type Html } from "../html.js";

export function renderPushConfirmation(plan: PushConfirmation): Html {
  const submit = html`<button class="button primary" type="button"${ds.attrs({ disabled: signal("pushForm.submitting") })}${ds.on("click", seq(set("pushForm.submitting", jsBoolean(true)), post(url("/_dashboard/pushes/apply", { confirmation: plan.id }), { include: [] })))}>Confirm and push</button><span class="field-help ds-toggle"${ds.classes({ open: signal("pushForm.submitting") })}>Starting push… Do not submit again.</span>`;
  return html`<section class="page"><header class="page-head"><div><h1>Review push</h1><p>Check the destination URL before confirming.</p></div><a class="button secondary"${hrefAttr(url("/push"))}>Cancel</a></header><section class="panel push-review flow-panel"><div class="push-review-heading"><span class="eyebrow">${plan.profile}</span><h2>${plan.name}</h2></div><div class="push-review-endpoint"><span class="eyebrow">Copy from</span><strong class="push-review-url">${plan.sourceUrl}</strong></div><div class="push-review-endpoint push-review-target"><span class="eyebrow">Destination — selected content will be overwritten</span><strong class="push-review-url">${plan.targetUrl}</strong></div><div class="push-review-scope"><h3>Content to copy</h3><p>${plan.scope}</p></div><p class="field-help">Novamira HQ uses the hosting provider's native push. It does not create a separate backup.</p><details class="push-review-details"><summary>Technical details</summary><dl class="details-list"><div><dt>Source environment</dt><dd>${plan.source}</dd></div><div><dt>Destination environment</dt><dd>${plan.target}</dd></div><div><dt>Confirmation expires (UTC)</dt><dd>${plan.expiresAt}</dd></div></dl><p>This confirmation can be used once. If the connection is interrupted, check History and the provider before trying again.</p></details><div class="push-review-actions">${submit}<a class="button secondary"${hrefAttr(url("/push"))}>Cancel</a></div></section></section>`;
}
