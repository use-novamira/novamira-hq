// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  McpConfiguration,
  McpClient,
  McpConnectOutcome,
} from "../../mcp-connection.js";
import * as ds from "../datastar.js";
import { copyText, post } from "../expr.js";
import { html, hrefAttr, cursorInstallHref, url, type Html } from "../html.js";
import type { ConfigView } from "./types.js";
import { renderAiLogo } from "./ai-logos.js";

export const MCP_PAGE_CLIENTS = [
  "claude",
  "claude-code",
  "chatgpt",
  "codex",
  "cursor",
  "vscode",
  "opencode",
] as const;
export type McpPageClient = (typeof MCP_PAGE_CLIENTS)[number];
export type McpSetupState =
  | { readonly status: "checking" | "configuring" }
  | { readonly status: McpConnectOutcome }
  | { readonly status: "failed"; readonly message: string };

function setupResult(
  client: McpPageClient,
  state: Exclude<McpSetupState, { status: "failed" }>,
): Html {
  const name = CLIENTS[client].name;
  const busy = state.status === "checking" || state.status === "configuring";
  const title =
    state.status === "checking"
      ? "Checking Novamira HQ…"
      : state.status === "configuring"
        ? `Configuring ${name}…`
        : state.status === "existing"
          ? "Configuration already exists"
          : state.status === "sent"
            ? "Continue in VS Code"
            : `${name} is configured`;
  const explanation =
    state.status === "checking"
      ? "Checking that Novamira HQ responds before changing your client settings."
      : state.status === "configuring"
        ? "Novamira HQ is ready. Adding it to your AI client."
        : state.status === "existing"
          ? `A Novamira HQ configuration already exists in ${name}. It has not been changed or verified.`
          : state.status === "sent"
            ? "The configuration was sent to VS Code. Review the server and approve it there."
            : `Open a new session in ${name} to use Novamira HQ.`;
  return html`<section class="page mcp-page"><header class="page-head"><div><h1>${title}</h1></div></header><section class="mcp-setup-card" role="status" aria-live="polite"><span class="mcp-choice-mark large">${clientMark(client)}</span><h2>${name}</h2><p>${explanation}</p>${busy ? html`<p>Please wait. No site operations are being performed.</p>` : html`<div class="mcp-after"><strong>Try it in your AI client</strong><p>Ask: “Show me my sites in Novamira HQ.”</p><p>Novamira HQ responded locally. The connection from your AI client has not yet been verified.</p></div><a class="button primary"${hrefAttr(url("/configure-ai"))}>Back to AI clients</a>`}</section></section>`;
}
const CLIENTS = {
  claude: { name: "Claude Desktop", method: "Install the desktop extension" },
  "claude-code": {
    name: "Claude Code CLI",
    method: "Configure with one click",
  },
  chatgpt: {
    name: "ChatGPT Desktop",
    method: "Configure through the Codex CLI",
  },
  codex: { name: "Codex CLI", method: "Configure with one click" },
  cursor: { name: "Cursor", method: "Open the installation link" },
  vscode: {
    name: "VS Code · GitHub Copilot",
    method: "Configure with one click",
  },
  opencode: { name: "OpenCode", method: "Use the guided setup" },
} as const;

export function isMcpPageClient(value: string | null): value is McpPageClient {
  return MCP_PAGE_CLIENTS.some((client) => client === value);
}

function clientMark(client: McpPageClient): Html {
  if (client === "claude" || client === "claude-code")
    return renderAiLogo("claude");
  if (client === "chatgpt" || client === "codex") return renderAiLogo("openai");
  return renderAiLogo(client);
}

function manualConfiguration(content: string, instructions: string): Html {
  return html`<details class="mcp-manual"><summary><strong>Manual configuration</strong><span>Alternative setup</span></summary><div class="mcp-client-body"><p>${instructions}</p><pre class="mcp-config"><code>${content}</code></pre><button class="button secondary" type="button"${ds.on("click", copyText(content))}>Copy configuration</button></div></details>`;
}

function clientChoice(): Html {
  return html`<section class="mcp-choose"><div><span class="eyebrow">Step 1</span><h2>Which AI client do you use?</h2><p>Choose how you use your AI assistant.</p></div><div class="mcp-client-grid">${MCP_PAGE_CLIENTS.map((client) => html`<a class="mcp-choice"${hrefAttr(url("/configure-ai", { client }))}><span class="mcp-choice-mark">${clientMark(client)}</span><span><strong>${CLIENTS[client].name}</strong><small>${CLIENTS[client].method}</small></span><span class="mcp-choice-arrow">→</span></a>`)}</div></section>`;
}

function connector(client: McpClient, label: string, hint: string): Html {
  return html`<div class="mcp-primary-action"><button class="button primary" type="button"${ds.on("click", post(url("/_dashboard/mcp/connect", { client }), { include: [] }))}>${label}</button><p>${hint}</p></div>`;
}

function setup(configuration: McpConfiguration, client: McpPageClient): Html {
  const server = (
    JSON.parse(configuration.claude) as {
      mcpServers: {
        "novamira-hq": {
          command: string;
          args: string[];
          env?: Record<string, string>;
        };
      };
    }
  ).mcpServers["novamira-hq"];
  let action: Html;
  let manual: Html;
  let description: string;
  switch (client) {
    case "claude":
      description =
        "Download the extension, open it with Claude Desktop and confirm Install.";
      action = html`<div class="mcp-primary-action"><a class="button primary"${hrefAttr(url("/mcp/novamira-hq.mcpb"))}>Download for Claude Desktop</a></div><details class="mcp-manual"><summary>Having trouble opening the file?</summary><div class="mcp-client-body"><p>In Claude Desktop, open Settings → Extensions → Advanced settings → Install Extension and select the downloaded file.</p></div></details>`;
      manual = manualConfiguration(
        configuration.claude,
        "In Settings → Developer → Edit Config, merge this server into claude_desktop_config.json. Keep your other servers.",
      );
      break;
    case "chatgpt":
    case "codex":
      description =
        client === "chatgpt"
          ? "Set up the local MCP connection through Codex. ChatGPT Desktop and Codex share these settings."
          : "Add Novamira HQ to your Codex MCP configuration.";
      action = connector(
        client,
        "Configure with one click",
        "Requires the codex command installed on this device. This also updates the shared configuration used by the IDE extension.",
      );
      manual = manualConfiguration(
        configuration.chatgpt,
        "Merge this block into ~/.codex/config.toml without replacing your existing settings.",
      );
      break;
    case "claude-code":
      description =
        "Add Novamira HQ to Claude Code CLI for your user account, across projects.";
      action = connector(
        client,
        "Configure Claude Code CLI",
        "Requires the claude command installed on this device. Start a new session after setup.",
      );
      manual = manualConfiguration(
        configuration.claude,
        "For project-only setup, merge this server into .mcp.json at the root of your project. Review and approve it in Claude Code.",
      );
      break;
    case "cursor":
      description =
        "Open Cursor and review the Novamira HQ server before installing it.";
      action = html`<div class="mcp-primary-action"><a class="button primary"${cursorInstallHref(JSON.stringify(server))}>Add to Cursor</a><p>Your browser will ask to open Cursor. Confirm installation in the app.</p></div>`;
      manual = manualConfiguration(
        configuration.claude,
        "Merge this server into ~/.cursor/mcp.json, keeping your existing servers.",
      );
      break;
    case "vscode":
      description =
        "Add Novamira HQ to your VS Code user profile for GitHub Copilot.";
      action = connector(
        client,
        "Configure VS Code",
        "Requires the code command installed on this device. Review the server and its permissions in VS Code.",
      );
      manual = manualConfiguration(
        JSON.stringify(
          { servers: { "novamira-hq": { type: "stdio", ...server } } },
          null,
          2,
        ),
        "Run MCP: Open User Configuration in the Command Palette and merge this server into the existing configuration.",
      );
      break;
    case "opencode":
      description = "Run OpenCode’s guided setup in your terminal.";
      action = html`<div class="mcp-primary-action"><button class="button primary" type="button"${ds.on("click", copyText("opencode mcp add"))}>Copy setup command</button><p>Run <code>opencode mcp add</code>. Choose a local server named <code>novamira-hq</code>.</p></div><div class="mcp-after"><strong>Server command</strong><code>${[server.command, ...server.args].map((part) => (/[^a-zA-Z0-9_./:\\=-]/u.test(part) ? "'" + part.replaceAll("'", "'\\''") + "'" : part)).join(" ")}</code></div>`;
      manual = manualConfiguration(
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            mcp: {
              "novamira-hq": {
                type: "local",
                command: [server.command, ...server.args],
                enabled: true,
                ...(server.env ? { environment: server.env } : {}),
              },
            },
          },
          null,
          2,
        ),
        "Merge this server into your OpenCode configuration (opencode.json), keeping your existing settings.",
      );
      break;
  }
  return html`<section class="mcp-setup-card"><div class="mcp-setup-head"><div><span class="eyebrow">Step 2 · ${CLIENTS[client].name}</span><h2>Configure Novamira HQ</h2><p>${description}</p></div><span class="mcp-choice-mark large">${clientMark(client)}</span></div>${action}<div class="mcp-after"><strong>After setup, open a new conversation in ${CLIENTS[client].name}.</strong><span>Try asking: “Show me my sites in Novamira HQ.” Approve tool permissions when your client asks.</span></div>${manual}</section>`;
}

export function renderMcpPage(
  _view: ConfigView,
  configuration?: McpConfiguration,
  client?: McpPageClient,
  state?: McpSetupState,
): Html {
  if (client && state && state.status !== "failed")
    return setupResult(client, state);
  const content =
    client === undefined
      ? clientChoice()
      : html`<div class="mcp-back"><a class="text-link"${hrefAttr(url("/configure-ai"))}>← Choose another AI client</a></div>${configuration ? setup(configuration, client) : html`<p class="notice warn">Launch configuration is unavailable in this Novamira HQ instance.</p>`}`;
  return html`<section class="page mcp-page"><header class="page-head"><div><h1>Configure your AI</h1><p>Manage your sites with Novamira HQ.</p></div></header>${state?.status === "failed" ? html`<section class="notice danger" role="alert"><h2>Configuration could not be completed</h2><p>${state.message}</p></section>` : ""}${content}</section>`;
}
