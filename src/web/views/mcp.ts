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
  return html`<section class="how-to-card"><h2>${name}</h2><p>${instructions}</p><pre style="margin: 0; padding: 18px; border-radius: 8px; background: var(--code-bg); color: #fff; overflow-x: auto; font-size: 12px; line-height: 1.6"><code>${content}</code></pre><div style="display: flex; flex-wrap: wrap; gap: 10px"><button class="button secondary" type="button"${ds.on("click", copyText(content))}>Copy configuration</button><a class="button secondary"${documentationHref(docs)}>Client documentation</a></div></section>`;
}

export function renderMcpPage(
  view: ConfigView,
  configuration?: McpConfiguration,
): Html {
  return html`<section class="page" style="max-width: 1040px"><header class="page-head"><div><h1 style="font-size: clamp(28px, 4vw, 36px); line-height: 1.15; margin-bottom: 12px">Connect your AI</h1><p>Your AI client starts HQ's local MCP process. This dashboard does not need to stay open.</p></div></header><section class="how-to-card"><h2>Connect Novamira HQ</h2><p>All HQ MCP tools are available, including guarded deploy and backup restore. Hosting credentials and provider support are still required. Hosting deletion operations remain excluded.</p>${configuration ? html`<button class="button secondary" style="justify-self: start" type="button"${ds.on("click", post(url("/_dashboard/mcp/verify"), { include: [] }))}>Verify local MCP startup</button>` : html`<p>Launch configuration is unavailable in this dashboard instance.</p>`}<p class="field-help">Verification checks startup, initialization and the tool list only. It does not contact hosting providers and does not prove that an external AI client is connected.</p></section>${
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
      : html``
  }<section class="how-to-card"><h2>Hosting profiles available to MCP</h2><p>This list follows HQ configuration automatically, including future provider additions. A configured credential is not proof of a working connection. Each operation checks provider support.</p>${view.profiles.length ? html`<ul>${view.profiles.map((profile) => html`<li><strong>${profile.name}</strong> — ${profile.provider}; ${profile.credentialAvailable ? "credential configured, not validated here" : "credential unavailable in this process"}</li>`)}</ul>` : html`<p>No hosting profiles configured yet.</p>`}<a class="button secondary" style="justify-self: start"${hrefAttr(url("/diagnostics"))}>Inspect provider capabilities</a><p>Provider secrets are never included in the copied configuration. Desktop clients may not inherit terminal environment variables: configure required variables in the client or use HQ's stored credentials. The local check uses this dashboard's environment.</p></section><section class="how-to-card"><h2>MCP and skills are different</h2><p>MCP exposes tools. Skills provide instructions to your agent; registering a skill does not connect an MCP server.</p><a class="button secondary" style="justify-self: start"${hrefAttr(url("/how-to-use"))}>Skill installation instructions</a></section></section>`;
}
