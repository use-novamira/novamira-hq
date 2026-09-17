// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Diagnostics page and its `#diagnostics-output` fragment.
 *
 * **What the Go did.** `renderDiagnosticsPage` (`views.go:1309-1335`) rendered a
 * provider `<select>` and two buttons whose `data-on:click` values were
 * hand-written strings:
 * `"@get('/_dashboard/diagnostics/capabilities', {filterSignals: {include: /^diagnostics(\\.|$)/}})"`
 * and `"@get('/_dashboard/diagnostics/doctor')"`. Two problems, both fixed by
 * construction here. The regex literal was typed out at the call site, with its
 * backslash doubled for Go's string escaping, and nothing checked that
 * `diagnostics` named a signal that existed. And the doctor button emitted **no
 * `filterSignals` scope at all**, so Datastar serialized the *whole* signal
 * store into `?datastar=` — including `providerForm.credentialValue`, the one
 * signal that can hold a provider secret, straight into a URL.
 *
 * **What HQ does instead.** Both buttons go through `expr.ts`'s {@link get},
 * which always emits an include scope and refuses one naming the provider form
 * or the token. `{ include: ["diagnostics"] }` produces exactly Go's intended
 * regex; `{ include: [] }` produces `/(?!)/`, "match nothing", which is the
 * honest spelling of what the doctor button needs and what Go's omission was
 * silently not doing.
 *
 * **6b rendered these disabled on purpose, and 7-1 turned them on.** The element
 * and its catalog row landed in 6b so that the id, the fragment and the DOM
 * could not drift across a phase boundary; the buttons carried a fixed `title`
 * saying the actions arrive with the doctor service, because a button wired to a
 * `404` looks like a working feature that is broken. `src/doctor/` now exists and
 * both routes are in the table, so the `disabled` flag and the `title` are gone.
 *
 * **The output panel is the only thing on this page that is patched.** Neither
 * route touches `#main`: repainting would reset the `<select>` the operator just
 * chose from. See `handlers/diagnostics.ts`.
 */

import * as ds from "../datastar.js";
import { copyReport, get } from "../expr.js";
import { html, idAttr, url, type Html } from "../html.js";
import { renderNotice } from "./layout.js";
import { type DashboardNotice } from "./types.js";

export function renderDiagnosticsPage(): Html {
  const doctor = get(url("/_dashboard/diagnostics/doctor"), { include: [] });
  return html`<section class="page flow-page"><header class="page-head"><div><h1>Diagnostics</h1><p>Check the local Novamira HQ installation. Hosting activity and available actions are in Hosting accounts.</p></div></header><div class="toolbar"><button class="button primary" type="button"${ds.on(
    "click",
    doctor,
  )}>Health check</button></div>${renderDiagnosticsOutput(
    { level: "neutral", message: "" },
    "Run a health check to inspect this installation. No repairs are performed.",
  )}</section>`;
}

/**
 * `#diagnostics-output` (Go's `renderDiagnosticsOutput`, `views.go:1337-1346`).
 *
 * `body` is rendered inside a `<pre>` by the `html` template, so a provider
 * response that happens to contain markup is text. It must never be built from a
 * `CliError`'s `details`: that is the field a provider secret would reach, and
 * `redact()` runs only on the JSON path.
 */
export function renderDiagnosticsOutput(
  notice: DashboardNotice,
  body: string,
): Html {
  if (notice.message === "") {
    return html`<div${idAttr("diagnostics-output")} class="diagnostics-output"><p>${body}</p></div>`;
  }
  return html`<div${idAttr("diagnostics-output")} class="diagnostics-output">${
    notice.message === "" ? false : renderNotice(notice)
  }${body === "" ? false : html`<section class="report-panel"><div class="report-actions"><button type="button" class="button secondary"${ds.on("click", copyReport("diagnostics-report", "diagnostics-copy-status"))}>Copy report</button><span id="diagnostics-copy-status" role="status" aria-live="polite"></span></div><pre id="diagnostics-report" class="code-output">${body}</pre></section>`}</div>`;
}
