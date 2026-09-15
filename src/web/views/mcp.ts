// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { McpConfiguration } from "../../mcp-connection.js";
import * as ds from "../datastar.js";
import { copyText, post } from "../expr.js";
import { html, hrefAttr, documentationHref, url, type Html } from "../html.js";
import type { ConfigView } from "./types.js";

function configPanel(
  name: string,
  content: string,
  instructions: string,
  docs: "claude" | "chatgpt",
): Html {
  return html`<details class="how-to-card mcp-client"><summary><strong>${name}</strong><span>Show setup instructions</span></summary><div class="mcp-client-body"><p>${instructions}</p><pre class="mcp-config"><code>${content}</code></pre><div class="button-row"><button class="button primary" type="button"${ds.on("click", copyText(content))}>Copy configuration</button><a class="button secondary"${documentationHref(docs)}>Client documentation</a></div></div></details>`;
}

export function renderMcpPage(
  view: ConfigView,
  configuration?: McpConfiguration,
): Html {
  return html`<section class="page mcp-page"><header class="page-head"><div><span class="eyebrow">AI connection</span><h1>Connect your AI</h1><p>Add Novamira HQ as a local MCP server in the AI client you use. The client starts Novamira HQ when needed, so this dashboard does not need to remain open.</p></div></header><section class="mcp-steps"><section class="how-to-card"><span class="eyebrow">Step 1</span><h2>Choose your AI client</h2><p>Open one guide and add the generated configuration without replacing your other MCP servers.</p>${
    configuration
      ? [
          configPanel(
            "Claude Desktop",
            configuration.claude,
            "Open Settings → Developer → Edit Config. Merge this server into claude_desktop_config.json without replacing other servers, save, then restart Claude Desktop.",
            "claude",
          ),
          configPanel(
            "ChatGPT Desktop",
            configuration.chatgpt,
            "Open Settings → MCP servers → Add server and choose STDIO using the command and arguments below. Alternatively merge this TOML into your host's ~/.codex/config.toml. Save and restart the server. Use /mcp in the client to check its connection.",
            "chatgpt",
          ),
        ]
      : html`<p class="notice warn">Launch configuration is unavailable in this Novamira HQ instance.</p>`
  }</section><section class="how-to-card"><span class="eyebrow">Step 2</span><h2>Test Novamira HQ</h2><p>Check that the local MCP process starts correctly and publishes its tools before switching to your AI client.</p>${configuration ? html`<button class="button secondary" type="button"${ds.on("click", post(url("/_dashboard/mcp/verify"), { include: [] }))}>Test Novamira HQ locally</button>` : false}<p class="field-help">This test does not contact hosting providers and cannot confirm that an external AI client loaded the configuration.</p></section><section class="how-to-card"><span class="eyebrow">Step 3</span><h2>Finish in your AI client</h2><p>Save the configuration, restart or reload the MCP server in your client, then use the client's own MCP status screen to confirm that <strong>novamira-hq</strong> is connected.</p><p>Once connected, ask your AI to list your sites. Novamira HQ supplies the tools; your AI client remains the place where you work.</p></section></section><details class="how-to-card mcp-advanced"><summary><strong>Advanced information</strong><span>Hosting profiles, credentials and skills</span></summary><div class="mcp-client-body"><section><h2>Hosting profiles available to MCP</h2><p>This list follows Novamira HQ configuration automatically. A configured credential is not proof of a working provider connection; each operation checks provider support.</p>${view.profiles.length ? html`<ul>${view.profiles.map((profile) => html`<li><strong>${profile.name}</strong> — ${profile.provider}; ${profile.credentialAvailable ? "credential configured, not validated here" : "credential unavailable in this process"}</li>`)}</ul>` : html`<p>No hosting profiles configured yet.</p>`}<a class="button secondary"${hrefAttr(url("/diagnostics"))}>Inspect provider capabilities</a><p class="field-help">Provider secrets are never included in copied configuration. Desktop clients may not inherit terminal environment variables; configure required variables in the client or use Novamira HQ's stored credentials.</p></section><section><h2>MCP and skills are different</h2><p>MCP exposes tools. Skills provide instructions to your agent; registering a skill does not connect an MCP server.</p><a class="button secondary"${hrefAttr(url("/how-to-use"))}>Skill installation instructions</a></section></div></details></section>`;
}
