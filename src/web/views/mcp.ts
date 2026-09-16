// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { McpConfiguration } from "../../mcp-connection.js";
import * as ds from "../datastar.js";
import { copyText, post } from "../expr.js";
import {
  html,
  hrefAttr,
  documentationHref,
  classAttr,
  url,
  type Html,
} from "../html.js";
import type { ConfigView } from "./types.js";

export type McpPageClient = "chatgpt" | "claude";

function manualConfiguration(
  heading: string,
  content: string,
  instructions: string,
): Html {
  return html`<details class="mcp-manual"><summary><strong>Manual configuration</strong><span>Use this only if automatic setup is unavailable</span></summary><div class="mcp-client-body"><h3>${heading}</h3><p>${instructions}</p><pre class="mcp-config"><code>${content}</code></pre><button class="button secondary" type="button"${ds.on("click", copyText(content))}>Copy configuration</button></div></details>`;
}

function clientChoice(): Html {
  return html`<section class="mcp-choose"><div><span class="eyebrow">Step 1</span><h2>Which AI client do you use?</h2><p>Choose your client. Novamira HQ will show only the setup that applies to it.</p></div><div class="mcp-client-grid"><a class="mcp-choice"${hrefAttr(url("/mcp", { client: "chatgpt" }))}><span class="mcp-choice-mark">O</span><span><strong>ChatGPT &amp; Codex</strong><small>ChatGPT Desktop, Codex CLI and the IDE extension</small></span><span class="mcp-choice-arrow">→</span></a><a class="mcp-choice"${hrefAttr(url("/mcp", { client: "claude" }))}><span class="mcp-choice-mark">A</span><span><strong>Claude</strong><small>Claude Code or Claude Desktop</small></span><span class="mcp-choice-arrow">→</span></a></div></section>`;
}

function chatGptSetup(configuration: McpConfiguration): Html {
  return html`<section class="mcp-setup-card"><div class="mcp-setup-head"><div><span class="eyebrow">ChatGPT &amp; Codex</span><h2>Connect Novamira HQ</h2><p>One click adds Novamira HQ to the shared MCP configuration used by ChatGPT Desktop, Codex CLI and the IDE extension.</p></div><span class="mcp-choice-mark large">O</span></div><div class="mcp-primary-action"><button class="button primary" type="button"${ds.on(
    "click",
    post(url("/_dashboard/mcp/connect", { client: "chatgpt" }), {
      include: [],
    }),
  )}>Connect with one click</button><p>Requires the <code>codex</code> command on this device.</p></div><div class="mcp-after"><strong>Then open or restart your client.</strong><span>Try asking: “Show me my sites in Novamira.”</span></div>${manualConfiguration(
    "Codex configuration",
    configuration.chatgpt,
    "If the connector is unavailable, merge this block into ~/.codex/config.toml without replacing your existing settings.",
  )}<a class="text-link"${documentationHref("chatgpt")}>Open client documentation ↗</a></section>`;
}

function claudeSetup(configuration: McpConfiguration): Html {
  return html`<section class="mcp-setup-card"><div class="mcp-setup-head"><div><span class="eyebrow">Claude Desktop</span><h2>Connect Novamira HQ</h2><p>Download the extension, open it with Claude Desktop and confirm Install.</p></div><span class="mcp-choice-mark large">A</span></div><div class="mcp-primary-action"><a class="button primary"${hrefAttr(url("/mcp/novamira-hq.mcpb"))}>Download for Claude Desktop</a><p>If the file does not open automatically, select it in Claude Desktop → Settings → Extensions → Advanced settings → Install Extension.</p></div><div class="mcp-after"><strong>Then start a conversation in Claude.</strong><span>Try asking: “Show me my sites in Novamira.”</span></div><details class="mcp-manual"><summary><strong>Using Claude Code?</strong><span>Connect the command-line client</span></summary><div class="mcp-client-body"><button class="button secondary" type="button"${ds.on(
    "click",
    post(url("/_dashboard/mcp/connect", { client: "claude-code" }), {
      include: [],
    }),
  )}>Connect Claude Code</button><p>Requires the <code>claude</code> command on this device. Start a new session after connecting.</p></div></details>${manualConfiguration(
    "Claude Desktop configuration",
    configuration.claude,
    "Open Settings → Developer → Edit Config. Merge the novamira-hq server into claude_desktop_config.json without replacing other servers, save, then restart Claude Desktop.",
  )}<a class="text-link"${documentationHref("claude")}>Open client documentation ↗</a></section>`;
}

export function renderMcpPage(
  _view: ConfigView,
  configuration?: McpConfiguration,
  client?: McpPageClient,
): Html {
  const content =
    client === undefined
      ? clientChoice()
      : html`<div class="mcp-back"><a class="text-link"${hrefAttr(
          url("/mcp"),
        )}>← Choose another AI client</a></div>${
          configuration
            ? client === "chatgpt"
              ? chatGptSetup(configuration)
              : claudeSetup(configuration)
            : html`<p class="notice warn">Launch configuration is unavailable in this Novamira HQ instance.</p>`
        }`;

  return html`<section${classAttr("page", client !== undefined && "flow-page", "mcp-page")}><header class="page-head"><div><h1>Connect your AI</h1><p>Manage your sites with Novamira.</p></div></header>${content}</section>`;
}
