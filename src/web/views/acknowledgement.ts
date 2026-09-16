// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as ds from "../datastar.js";
import { post } from "../expr.js";
import { html, hrefAttr, url, type Html } from "../html.js";

export function renderAcknowledgement(review = false): Html {
  const action = review
    ? html`<a class="button secondary"${hrefAttr(url("/"))}>Back to Novamira HQ</a>`
    : html`<button type="button" class="button primary"${ds.on("click", post(url("/_dashboard/app/acknowledge"), { include: [] }))}>I understand and continue</button>`;
  return html`<section class="page" style="max-width: 760px; padding: 24px 0"><section class="how-to-card" style="padding: clamp(20px, 4vw, 40px); gap: 24px" aria-labelledby="acknowledgement-title"><header><span class="eyebrow">Welcome to Novamira HQ</span><h1 id="acknowledgement-title" style="font-size: clamp(28px, 4vw, 36px); line-height: 1.15; margin-top: 10px">Before you start</h1><p>Novamira HQ lets you manage your sites and hosting environments, directly or through an AI client.</p></header><section><h2>AI access to your sites</h2><p>Setting up Novamira through a hosting account enables AI Abilities on that site, including existing installations. These allow AI clients to run PHP and access or modify WordPress files and data. You will be asked to approve this during setup. Connecting a site by URL does not enable AI Abilities.</p></section><section><h2>Changes can overwrite data</h2><p>Push and restore operations can overwrite content on the destination site. Always check the destination URL and review the selected content before confirming.</p><p>Always keep an up-to-date backup in a safe location, separate from the site you are modifying. Make sure you know how to restore it.</p></section><section><h2>Your approval</h2><p>This acknowledgement does not authorize operations on your sites. Your AI client’s tool permissions and operation-specific confirmations remain separate.</p></section><footer>${action}</footer></section></section>`;
}
