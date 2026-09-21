// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Shared UI structure. Views supply content and typed actions, not spacing. */
import {
  html,
  attr,
  hrefAttr,
  classAttr,
  type Html,
  type Url,
} from "../html.js";
import * as ds from "../datastar.js";
import { signal, seq, set, jsBoolean, type Expr } from "../expr.js";
import type { SignalPath } from "../signals.js";

export function connectionStatus(
  state:
    | "connected"
    | "configured"
    | "not_configured"
    | "reconnect_required"
    | "unavailable",
  hint?: string,
): Html {
  const labels = {
    connected: "Connected",
    configured: "Connection saved",
    not_configured: "Not connected",
    reconnect_required: "Access renewal required",
    unavailable: "Connection not verified",
  };
  return html`<span class="connection-status"${hint ? attr("title", hint) : false}>${labels[state]}</span>`;
}

export function confirmationCheckbox(label: string, value: SignalPath): Html {
  return html`<label class="confirmation-choice"><input type="checkbox"${ds.bind(value)}><span>${label}</span></label>`;
}

/** A quantity is secondary text, not a status badge or an action. */
export function itemCount(
  count: number,
  singular: string,
  plural: string,
): Html {
  return html`<span class="ui-item-count">${String(count)} ${count === 1 ? singular : plural}</span>`;
}

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

export function tabs(
  label: string,
  items: readonly { label: string; href: Url; selected: boolean }[],
): Html {
  return html`<nav class="ui-tabs"${attr("aria-label", label)}>${items.map((item) => html`<a${hrefAttr(item.href)}${item.selected ? attr("aria-current", "page") : false}>${item.label}</a>`)}</nav>`;
}

export function filePath(value: string): Html {
  return html`<code class="ui-file-path">${value}</code>`;
}

/** Only a masked suffix is displayed; it is never submitted as a replacement. */
export function secretEditor(options: {
  label: string;
  placeholder: string;
  help: string;
  last4?: string;
  value: SignalPath;
  busy: SignalPath;
  save: Expr;
  remove?: Expr;
}): Html {
  return html`<form class="ui-secret-editor"${ds.onSubmit(options.save)}${ds.indicator(options.busy)}>${field(options.label, html`<input type="password" autocomplete="off"${attr("placeholder", options.last4 ? `••••••••${options.last4}` : options.placeholder)}${ds.bind(options.value)} required>`, options.last4 ? "Enter a new key to replace it." : undefined)}<p class="field-help">${options.help}</p>${actionBar(html`<button class="button secondary" type="submit"${ds.attrs({ disabled: signal(options.busy) })}>Save</button>${options.remove ? html`<button class="button quiet" type="button"${ds.attrs({ disabled: signal(options.busy) })}${ds.on("click", options.remove)}>Remove</button>` : false}<span class="ds-toggle"${ds.classes({ open: signal(options.busy) })} role="status">Updating…</span>`)}</form>`;
}
