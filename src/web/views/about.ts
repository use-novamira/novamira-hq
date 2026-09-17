// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { aboutHref, html, hrefAttr, url, type Html } from "../html.js";
import type { ConfigView } from "./types.js";

export function renderAboutPage(view: ConfigView): Html {
  return html`<section class="page flow-page about-page"><header class="page-head"><div><h1>About Novamira HQ</h1><p>Your local dashboard for Novamira sites and hosting accounts.</p></div></header><section class="panel about-panel"><div class="panel-head"><div><h2>Novamira HQ</h2><p>Connect your sites, manage hosting environments and configure your AI client.</p></div></div><dl class="details-list about-details"><div><dt>Version</dt><dd>${view.version}</dd></div><div><dt>Developed by</dt><dd>Ovation S.r.l.</dd></div><div><dt>Copyright</dt><dd>© 2026 Ovation S.r.l.</dd></div><div><dt>License</dt><dd><a class="text-link"${aboutHref("license")}>AGPL-3.0-or-later</a></dd></div></dl><footer class="button-row about-actions"><a class="button secondary"${aboutHref("website")}>Novamira website ↗</a><a class="button secondary"${aboutHref("source")}>Source code ↗</a><a class="button secondary"${hrefAttr(url("/settings", { tab: "updates" }))}>Updates</a><a class="button secondary"${hrefAttr(url("/settings", { tab: "uninstall" }))}>Uninstall guide</a></footer></section><section class="panel about-panel"><div class="panel-head"><div><h2>Legal notices</h2><p>Third-party components, versions, license texts and source references.</p><a class="text-link about-legal-link"${hrefAttr(url("/assets/third-party-notices.txt"))}>Read third-party notices</a></div></div></section></section>`;
}
