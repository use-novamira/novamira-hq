// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { McpConfiguration } from "../../mcp-connection.js";
import * as ds from "../datastar.js";
import { copyText, post } from "../expr.js";
import { html, hrefAttr, documentationHref, url, type Html } from "../html.js";
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
  )}>Connect with one click</button><p>Requires the <code>codex</code> command on this device. No hosting credential is copied into the client configuration.</p></div><div class="mcp-after"><strong>Then open or restart your client.</strong><span>Ask it to list your hosting sites to start using Novamira HQ.</span></div>${manualConfiguration(
    "Codex configuration",
    configuration.chatgpt,
    "If the connector is unavailable, merge this block into ~/.codex/config.toml without replacing your existing settings.",
  )}<a class="text-link"${documentationHref("chatgpt")}>Open client documentation ↗</a></section>`;
}

function claudeSetup(configuration: McpConfiguration): Html {
  return html`<section class="mcp-setup-card"><div class="mcp-setup-head"><div><span class="eyebrow">Claude</span><h2>Connect Novamira HQ</h2><p>Claude Code can be configured automatically. Claude Desktop currently uses its own configuration file.</p></div><span class="mcp-choice-mark large">A</span></div><div class="mcp-primary-action"><button class="button primary" type="button"${ds.on(
    "click",
    post(url("/_dashboard/mcp/connect", { client: "claude-code" }), {
      include: [],
    }),
  )}>Connect Claude Code</button><p>Requires the <code>claude</code> command on this device. The connection is saved for your user, not just this project.</p></div><div class="mcp-after"><strong>Using Claude Desktop?</strong><span>Open the manual option below and copy the generated configuration.</span></div>${manualConfiguration(
    "Claude Desktop configuration",
    configuration.claude,
    "Open Settings → Developer → Edit Config. Merge the novamira-hq server into claude_desktop_config.json without replacing other servers, save, then restart Claude Desktop.",
  )}<a class="text-link"${documentationHref("claude")}>Open client documentation ↗</a></section>`;
}

export function renderMcpPage(
  view: ConfigView,
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

  return html`<section class="page mcp-page"><header class="page-head"><div><span class="eyebrow">AI connection</span><h1>Connect your AI</h1><p>Give your AI client access to Novamira HQ's hosting tools on this device.</p></div></header>${content}<details class="how-to-card mcp-advanced"><summary><strong>About this connection</strong><span>Profiles, credentials and skills</span></summary><div class="mcp-client-body"><section><h2>Hosting profiles available to your AI</h2><p>The connection follows Novamira HQ configuration automatically. Provider credentials remain in Novamira HQ and are never copied into the AI client.</p>${
    view.profiles.length
      ? html`<ul>${view.profiles.map(
          (profile) =>
            html`<li><strong>${profile.name}</strong> — ${profile.provider}; ${profile.credentialAvailable ? "credential configured, not validated here" : "credential unavailable in this process"}</li>`,
        )}</ul>`
      : html`<p>No hosting profiles configured yet.</p>`
  }<a class="button secondary"${hrefAttr(url("/diagnostics"))}>Inspect provider capabilities</a></section><section><h2>MCP and skills are different</h2><p>This connection exposes tools. Skills give instructions to your agent; installing a skill does not create this connection.</p><a class="button secondary"${hrefAttr(url("/how-to-use"))}>Skill installation instructions</a></section></div></details></section>`;
}
