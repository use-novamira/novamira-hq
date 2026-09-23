// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { html, hrefAttr, url, type Html } from "../html.js";
import { providerLabelFor, type DashboardNotice } from "./types.js";
import { renderNotice } from "./layout.js";

export interface ProviderReadyView {
  readonly profile: string;
  readonly provider: string;
}

/** Shown only after the account passed a live provider validation. */
export function renderProviderReadyPage(
  view: ProviderReadyView,
  notice: DashboardNotice,
): Html {
  return html`<section class="page flow-page"><header class="page-head"><div><h1>Hosting account ready</h1><p>${view.profile} · ${providerLabelFor(view.provider)}</p></div><a class="button secondary"${hrefAttr(url("/hosting-accounts"))}>Back to Hosting accounts</a></header>${notice.level === "ok" ? false : renderNotice(notice)}<p>Novamira HQ verified access to this hosting account.</p><div class="button-row"><a class="button primary"${hrefAttr(url("/sites"))}>View sites</a></div></section>`;
}
