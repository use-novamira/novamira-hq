// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as ds from "../datastar.js";
import { post, signal, not } from "../expr.js";
import { html, hrefAttr, url, type Html } from "../html.js";
import { dynamicSignalPath } from "../signals.js";

export function renderAcknowledgement(review = false): Html {
  const busy = dynamicSignalPath("appSetup", "busy");
  const action = review
    ? html`<a class="button secondary"${hrefAttr(url("/"))}>Back to Novamira HQ</a>`
    : html`<div${ds.signals({ [busy]: false })}><p>The site connection CLI is included with Novamira HQ. Continue to configure your hosting accounts or connect a site.</p><div class="button-row"><button type="button" class="button primary"${ds.indicator(busy)}${ds.attrs({ disabled: signal(busy) })}${ds.on("click", post(url("/_dashboard/app/acknowledge"), { include: [] }))}><span${ds.attrs({ hidden: signal(busy) })}>Continue</span><span hidden${ds.attrs({ hidden: not(signal(busy)) })}>Saving…</span></button></div></div>`;
  return html`<section class="page acknowledgement-page"><section class="acknowledgement-content" aria-labelledby="acknowledgement-title"><header><img class="acknowledgement-logo" src="/assets/novamira-hq-logo-white.svg" alt="Novamira HQ" width="238" height="35"><h1 id="acknowledgement-title">Before you start</h1><p>Novamira HQ lets you manage your sites and hosting environments, directly or through an AI client.</p></header><section><h2>AI access to your sites</h2><p>Setting up Novamira through a hosting account enables AI Abilities on that site, including existing installations. These allow AI clients to run PHP and access or modify WordPress files and data. You will be asked to approve this during setup. Connecting a site by URL does not enable AI Abilities.</p></section><section><h2>Changes can overwrite data</h2><p>Push and restore operations can overwrite content on the destination site. Always check the destination URL and review the selected content before confirming.</p><p>Always keep an up-to-date backup in a safe location, separate from the site you are modifying. Make sure you know how to restore it.</p></section><section><h2>Your approval</h2><p>This acknowledgement does not authorize operations on your sites. Your AI client’s tool permissions and operation-specific confirmations remain separate.</p></section><footer>${action}</footer></section></section>`;
}
