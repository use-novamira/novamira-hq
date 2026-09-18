// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { html, hrefAttr, url, type Html } from "../html.js";
import * as ds from "../datastar.js";
import { post } from "../expr.js";

export interface ProviderRemovalView {
  readonly profile: string;
  readonly confirmation: string;
  readonly sites: readonly { name: string; siteUrl: string }[];
  readonly verified: boolean;
}

export function renderProviderRemoval(view: ProviderRemovalView): Html {
  const action = (removeSites: boolean) =>
    post(
      url("/_dashboard/providers/remove", {
        profile: view.profile,
        confirmation: view.confirmation,
        remove_sites: removeSites ? "true" : "false",
      }),
      { include: [] },
    );
  return html`<section class="page flow-page"><header class="page-head"><h1>Remove hosting account</h1></header><section class="panel action-panel"><h2>${view.profile}</h2><p>Your websites and installed plugins will not be deleted.</p>${view.verified ? html`<p>These saved site connections match this hosting account, including sites originally added manually:</p><ul>${view.sites.map((site) => html`<li><strong>${site.name}</strong> — ${site.siteUrl}</li>`)}</ul>${view.sites.length === 0 ? html`<p>No linked saved site connections were found.</p>` : html`<p>Removing these connections also removes their saved access from this computer. Other hosting accounts may use the same connections.</p>`}` : html`<p class="notice warn">Linked sites could not be verified. You can remove the hosting account only; saved site connections will be kept.</p>`}<div class="button-row"><button class="button secondary" type="button"${ds.on("click", action(false))}>Remove hosting account only</button>${view.verified && view.sites.length > 0 ? html`<button class="button danger" type="button"${ds.on("click", action(true))}>Remove hosting account and linked sites</button>` : false}<a class="button secondary"${hrefAttr(url("/hosting-accounts"))}>Cancel</a></div></section></section>`;
}
