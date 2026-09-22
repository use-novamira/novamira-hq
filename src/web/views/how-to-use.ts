// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The persistent product handoff: prepare in HQ, then work in the agent. */

import { hrefAttr, html, url, type Html } from "../html.js";

export function renderHowToUsePage(): Html {
  return html`<section class="page"><header class="page-head"><div><h1>How to use it</h1><p>Prepare your sites in Novamira HQ, then work with them from your AI agent.</p></div></header><section class="how-to-card" aria-label="Novamira workflow"><ol class="how-to-steps"><li><span class="how-to-number">1</span><div><strong>Prepare a site</strong><p>Connect an existing Novamira site directly by URL, or connect a hosting account to discover its sites. Run Setup Novamira where needed.</p><div class="how-to-actions"><a class="button secondary"${hrefAttr(
    url("/hosting-accounts", { new: "host" }),
  )}>Connect hosting</a><a class="button secondary"${hrefAttr(
    url("/sites", { new: "cli" }),
  )}>Add site by URL</a></div></div></li><li><span class="how-to-number">2</span><div><strong>Connect it</strong><p>Open Sites and authorize the site on this computer. It is ready when its status says Connected.</p><div class="how-to-actions"><a class="button secondary"${hrefAttr(
    url("/sites"),
  )}>Open Sites</a></div></div></li><li><span class="how-to-number">3</span><div><strong>Ask your AI</strong><p>Open the AI client you connected through Configure AI, then mention the site by name. Novamira HQ prepares the connection; it does not contain an AI chat.</p></div></li></ol></section><section class="agent-install-card"><div><span class="eyebrow">Agent access</span><h2>Configure a different AI agent</h2><p>Connect your AI client through MCP to use Novamira HQ's hosting and WordPress tools. No skill installation is required.</p></div><a class="button secondary"${hrefAttr(url("/configure-ai"))}>Configure AI</a><a class="text-link"${hrefAttr(url("/mcp"))}>Configure MCP</a><p class="field-help">Sites already connected on this computer do not need to be connected again.</p></section></section>`;
}
