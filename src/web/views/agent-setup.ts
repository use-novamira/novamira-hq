// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentSetupView } from "../../agent-connection.js";
import { html, url, hrefAttr, attr, type Html } from "../html.js";
import * as ds from "../datastar.js";
import { get, post } from "../expr.js";
import { panel, filePath } from "./components.js";

export function renderAgentSetup(view?: AgentSetupView, error?: string): Html {
  if (!view)
    return panel(
      html`<p>${error ?? "Agent setup requires the installed desktop application."}</p><a${hrefAttr(url("/mcp"))}>Connect an MCP client instead</a>`,
      { title: "Connect your agents" },
    );
  const button = (
    label: string,
    action: string,
    params: Record<string, string> = {},
    disabled = false,
  ) =>
    html`<button class="button" type="button"${disabled ? attr("disabled", "") : false}${ds.on("click", post(url(`/_dashboard/agents/${action}`, params), { include: [] }))}>${label}</button>`;
  return html`<section class="flow-page"><h2>Connect your agents</h2><p>Enable terminal access, then choose each agent that should receive hosting and WordPress site entry points. Nothing is selected automatically.</p>${panel(html`<p><strong>Command access: ${view.command.state}</strong>${view.command.onPath === false ? " — PATH refresh needed" : ""}${view.command.shadowed ? " — another command takes precedence" : ""}</p>${filePath(view.command.launcher)}<p>${view.command.message ?? ""}</p><p>${view.command.pathInstruction ?? ""}</p><div class="actions">${button("Enable command", "command", { operation: "enable" })}${button("Repair command", "command", { operation: "repair" })}${button("Remove command", "command", { operation: "remove" })}</div><p>After enabling or repairing, restart terminals and agents to refresh PATH. If PATH is not configured, use the absolute launcher path above. Reopen HQ and regenerate existing MCP configuration from the MCP guide after command registration changes.</p>`, { title: "1. Terminal command" })}${view.agents.map((agent) => panel(html`<ul>${agent.skills.map((skill) => html`<li><strong>${skill.name}</strong>: ${skill.state}${filePath(skill.path)}</li>`)}</ul><p>Install adds missing entry points. Repair updates only unedited HQ-owned instructions. Conflicting or manually installed files are preserved.</p><div class="actions">${button("Install for " + agent.name, "install", { agent: agent.id }, view.running)}${button("Repair / retry", "repair", { agent: agent.id }, view.running)}${button("Remove owned skills", "remove", { agent: agent.id }, view.running)}</div>`, { title: agent.name }))}${view.running ? html`<p role="status">Setting up entry points… Completed installations are retained if you cancel.</p>${button("Cancel setup", "cancel")}` : false}<ul aria-live="polite">${view.results.map((result) => html`<li>${result.agent} / ${result.skill}: ${result.ok ? "Success" : "Needs attention"} — ${result.message}</li>`)}</ul><p>The two small skills load version-matched guidance on demand. Restart your agent after installation or repair so it discovers the files.</p><div class="actions"><button class="button" type="button"${ds.on("click", get(url("/_dashboard/agents/status"), { include: [] }))}>Refresh status</button>${button(view.firstRun ? "Continue to HQ" : "Done", "dismiss")}</div><p><a${hrefAttr(url("/mcp"))}>Use the MCP setup guide</a> for clients without skills.</p></section>`;
}
