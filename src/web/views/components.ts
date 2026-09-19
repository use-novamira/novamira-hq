// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Shared UI structure. Views supply content and typed actions, not spacing. */
import { html, hrefAttr, classAttr, type Html, type Url } from "../html.js";
import * as ds from "../datastar.js";
import { signal, seq, set, jsBoolean, type Expr } from "../expr.js";
import type { SignalPath } from "../signals.js";

export function pageHeader(
  title: string,
  options: { description?: string; back?: { label: string; href: Url } } = {},
): Html {
  return html`<header class="page-head"><div><h1>${title}</h1>${options.description ? html`<p>${options.description}</p>` : false}</div>${options.back ? html`<a class="button secondary"${hrefAttr(options.back.href)}>${options.back.label}</a>` : false}</header>`;
}

export function panel(
  body: Html,
  options: { title?: string; description?: string } = {},
): Html {
  return html`<section class="panel ui-panel">${options.title ? html`<div class="panel-head"><div><h2>${options.title}</h2>${options.description ? html`<p>${options.description}</p>` : false}</div></div>` : false}<div class="ui-panel-body">${body}</div></section>`;
}

export function actionButton(options: {
  label: string;
  action: Expr;
  busy: SignalPath;
  pending?: string;
  tone?: "primary" | "secondary";
}): Html {
  return html`<div class="ui-action"><button${classAttr("button", options.tone ?? "primary")} type="button"${ds.attrs({ disabled: signal(options.busy) })}${ds.indicator(options.busy)}${ds.on("click", seq(set(options.busy, jsBoolean(true)), options.action))}>${options.label}</button><span class="ds-toggle"${ds.classes({ open: signal(options.busy) })} role="status">${options.pending ?? "Please wait…"}</span></div>`;
}

export function actionBar(content: Html): Html {
  return html`<div class="ui-actions">${content}</div>`;
}

export function operationStatus(message: string, running = false): Html {
  return html`<p class="ui-status" role="status">${running ? html`<span class="spinner" aria-hidden="true"></span>` : false}${message}</p>`;
}

export function technicalDetails(content: Html): Html {
  return html`<details class="ui-details"><summary>Technical details</summary><div>${content}</div></details>`;
}

export function endpoint(
  label: string,
  value: string,
  destination = false,
): Html {
  return html`<div${classAttr("ui-endpoint", destination && "ui-endpoint-target")}><span class="eyebrow">${label}</span><strong>${value.replace(/^https?:\/\//i, "")}</strong></div>`;
}

export function field(label: string, control: Html, help?: string): Html {
  return html`<label class="ui-field">${label}${control}${help ? html`<span class="field-help">${help}</span>` : false}</label>`;
}
