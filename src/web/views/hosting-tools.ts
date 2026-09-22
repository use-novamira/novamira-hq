// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ProviderKind } from "../../config/schema.js";
import { hostingInspectionOptions } from "../../hosting/inspection.js";
import type { HostingToolsTarget } from "../services/hosting-tools.js";
import { html, hrefAttr, url, type Html } from "../html.js";
import * as ds from "../datastar.js";
import { copyReport, get, post, signal } from "../expr.js";
import { renderNotice } from "./layout.js";
import { asRecord } from "../../json.js";

export interface HostingToolsView {
  readonly target: HostingToolsTarget;
  readonly provider?: ProviderKind;
  readonly result?: unknown;
  readonly selected?: string;
  readonly error?: string;
}

export function renderHostingTools(view: HostingToolsView): Html {
  const options = view.provider ? hostingInspectionOptions(view.provider) : [];
  const sections = [...new Set(options.map((option) => option.section))];
  const loading = signal("hostingTools.loading");
  const report =
    view.result === undefined ? "" : JSON.stringify(view.result, null, 2);
  return html`<section class="page flow-page hosting-tools"><header class="page-head"><div><h1>Hosting tools</h1><p>${view.target.profile} · ${view.target.site}</p><p class="field-help">Environment: ${view.target.env}</p></div><a class="button secondary"${hrefAttr(url("/sites"))}>Back to Sites</a></header>
    <p>Choose what to load. Reports are fetched on demand, not monitored continuously. Provider activity is separate from local HQ Activity.</p>
    ${view.error ? renderNotice({ level: "danger", message: view.error }) : false}
    ${options.length === 0 ? html`<p>No supported hosting tools are available for this account.</p>` : false}
    <div class="hosting-tools-sections">${sections.map(
      (section) =>
        html`<section class="card"><div class="card-header"><h2>${section}</h2><p>${section === "Cache" ? "Clears cached responses, not site content. Select the cache to purge; responses may temporarily be slower while it rebuilds." : section === "Backups" ? "Read-only catalog. Listing backups does not create or restore anything." : section === "Provider activity" ? "Actions recorded by the provider, including changes made outside HQ." : section === "Logs" ? "Recent provider logs. They may contain personal data; share with care." : "Provider statistics. Kinsta environment reports use the last 24 hours; site usage uses this month. Other providers use their default reporting period."}</p></div><div class="card-body hosting-tool-buttons">${options
          .filter((option) => option.section === section)
          .map((option) => {
            const target = url("/_dashboard/hosting-tools/run", {
              ...view.target,
              option: option.id,
            });
            const action =
              section === "Cache"
                ? post(target, { include: [] })
                : get(target, { include: [] });
            return html`<button type="button" class="button secondary"${ds.on("click", action)}${ds.indicator("hostingTools.loading")}${ds.attrs({ disabled: loading })}>${option.label}</button>`;
          })}</div></section>`,
    )}</div>
    <p class="loading-inline ds-toggle" role="status"${ds.classes({ open: loading })}>Contacting the hosting provider… Please wait.</p>
    ${report ? html`<section class="card report-panel"><div class="card-header"><h2>${options.find((option) => option.id === view.selected)?.label ?? "Result"}</h2><p>${view.selected?.startsWith("cache:") ? "Purge request sent. An accepted request may still be running; check the provider before retrying." : "Loaded from your hosting provider. Refresh by choosing the same report again."}</p></div><div class="card-body">${renderRows(asRecord(view.result)?.data)}<div class="report-actions"><button type="button" class="button secondary"${ds.on("click", copyReport("hosting-report", "hosting-report-copy"))}>Copy report</button><span id="hosting-report-copy" role="status"></span></div><details><summary>Technical details</summary><pre id="hosting-report" class="code-output">${report}</pre></details></div></section>` : false}
  </section>`;
}

/** Provider-shaped data stays text, never trusted HTML. Show a bounded readable table. */
function renderRows(value: unknown): Html | false {
  if (typeof value === "string")
    return html`<pre class="code-output">${value}</pre>`;
  let rows: unknown[] | undefined;
  function findRows(value: unknown, depth = 0): void {
    if (rows || depth > 5) return;
    if (Array.isArray(value)) {
      rows = value;
      return;
    }
    const record = asRecord(value);
    if (record)
      for (const child of Object.values(record)) findRows(child, depth + 1);
  }
  findRows(value);
  if (!rows)
    return value === undefined
      ? false
      : html`<pre class="code-output">${JSON.stringify(value, null, 2)}</pre>`;
  if (rows.length === 0)
    return html`<p>No entries returned by the provider.</p>`;
  const records = rows
    .slice(0, 100)
    .map(asRecord)
    .filter((row) => row !== undefined);
  const keys = [...new Set(records.flatMap((row) => Object.keys(row)))]
    .filter((key) =>
      records.some(
        (row) =>
          typeof row[key] === "string" ||
          typeof row[key] === "number" ||
          typeof row[key] === "boolean",
      ),
    )
    .slice(0, 8);
  if (!keys.length)
    return html`<pre class="code-output">${JSON.stringify(value, null, 2)}</pre>`;
  return html`<p class="field-help">Showing ${records.length} of ${rows.length} entries. Copy report includes the returned details.</p><div class="hosting-report-table"><table><thead><tr>${keys.map((key) => html`<th>${key.replaceAll("_", " ")}</th>`)}</tr></thead><tbody>${records.map((row) => html`<tr>${keys.map((key) => html`<td>${cell(row[key])}</td>`)}</tr>`)}</tbody></table></div>`;
}

function cell(value: unknown): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : "—";
}
