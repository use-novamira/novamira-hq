// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DeployConfirmation } from "../services/deploy-execution.js";
import * as ds from "../datastar.js";
import { post } from "../expr.js";
import { html, url, type Html } from "../html.js";

export function renderDeployConfirmation(plan: DeployConfirmation): Html {
  return html`<section class="panel"><h2>Confirm deploy: ${plan.name}</h2><dl><dt>Hosting profile</dt><dd>${plan.profile}</dd><dt>Source</dt><dd>${plan.source}</dd><dt>Target to overwrite</dt><dd>${plan.target}</dd><dt>Scope</dt><dd>${plan.scope}</dd><dt>Expires (UTC)</dt><dd>${plan.expiresAt}</dd></dl><p>HQ will create and verify a safety backup of the target before pushing. This confirmation can be used once. If the connection is interrupted, check History and the provider before trying again.</p><button class="button primary" type="button"${ds.on("click", post(url("/_dashboard/deploy-paths/apply", { confirmation: plan.id }), { include: [] }))}>Create safety backup and deploy</button></section>`;
}
