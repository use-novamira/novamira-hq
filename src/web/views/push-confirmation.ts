// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PushConfirmation } from "../services/push-execution.js";
import * as ds from "../datastar.js";
import { post } from "../expr.js";
import { html, url, type Html } from "../html.js";

export function renderPushConfirmation(plan: PushConfirmation): Html {
  return html`<section class="panel"><h2>Confirm push: ${plan.name}</h2><dl><dt>Hosting profile</dt><dd>${plan.profile}</dd><dt>Source</dt><dd>${plan.source}</dd><dt>Target to overwrite</dt><dd>${plan.target}</dd><dt>Scope</dt><dd>${plan.scope}</dd><dt>Expires (UTC)</dt><dd>${plan.expiresAt}</dd></dl><p>A safety backup of the target will be created and verified automatically before the push. This confirmation can be used once. If the connection is interrupted, check History and the provider before trying again.</p><button class="button primary" type="button"${ds.on("click", post(url("/_dashboard/pushes/apply", { confirmation: plan.id }), { include: [] }))}>Push now</button></section>`;
}
