// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ProView } from "../../pro/service.js";
import { html, url, type Html } from "../html.js";
import * as ds from "../datastar.js";
import { post, signal, confirmThen } from "../expr.js";
import { pageHeader, actionButton, panel, secretEditor } from "./components.js";

/** The same license editor is used in Settings and during site installation. */
export function renderPro(view: ProView): Html {
  const params = view.site ? { site: view.site } : {};
  return panel(
    secretEditor({
      label: "License key",
      placeholder: "Enter your license key",
      help: "Stored securely on this computer. Saving does not use a license slot.",
      ...(view.last4
        ? {
            last4: view.last4,
            remove: confirmThen(
              "Remove the saved license from this computer? Existing site activations will not change.",
              post(url("/_dashboard/pro/remove", params), { include: [] }),
            ),
          }
        : {}),
      value: "proForm.license",
      busy: "proForm.busy",
      save: post(url("/_dashboard/pro/save", params), {
        include: ["proForm.license"],
      }),
    }),
    {
      title: "Novamira Pro plugin license",
      description:
        "For the WordPress plugin only. Novamira HQ does not require a license.",
    },
  );
}

export function renderProPage(view: ProView): Html {
  const params = view.site ? { site: view.site } : {};
  return html`<section class="page flow-page">${pageHeader("Install Novamira Pro", { description: "The Pro plugin for your WordPress site. Novamira HQ does not require a license.", back: { label: "Back to Sites", href: url("/sites") } })}${!view.site ? html`<section class="panel"><div class="form-grid"><p>Select a connected site from Sites to install Novamira Pro.</p></div></section>` : html`<section class="panel"><div class="panel-head"><div><h2>${view.site}</h2><p>WordPress plugin installation</p></div></div><div class="form-grid">${view.message ? html`<h3>Installation complete</h3><p role="status">${view.message}</p>` : view.review ? html`<h3>Review installation</h3><p><strong>${view.review.siteUrl}</strong></p><p>This activates your license for ${view.review.domain} and may use a license slot.</p><p>${view.review.existing ? "The existing Novamira Pro installation will be kept and configured with your saved license." : "Novamira Free is already active. Novamira Pro will be downloaded, installed, activated and configured with your saved license."}</p><div>${actionButton({ label: "Activate license and install Pro", action: post(url("/_dashboard/pro/install", { confirmation: view.review.id, ...params }), { include: [] }), busy: "proForm.busy", pending: "Installing Novamira Pro…" })}</div>` : view.last4 ? html`<p>Use saved plugin license <strong>••••••••${view.last4}</strong>.</p><p>Check the site before reviewing the installation. No license slot is used by this check.</p><div>${actionButton({ label: "Review installation", action: post(url("/_dashboard/pro/plan", params), { include: [] }), busy: "proForm.busy", pending: "Checking site…" })}</div>` : html`<p>Save your Novamira Pro plugin license below to continue with this site.</p>`}<p class="ds-toggle"${ds.classes({ open: signal("proForm.busy") })} role="status">Please wait… Do not close Novamira HQ.</p></div></section>${!view.last4 && !view.message ? renderPro(view) : false}`}</section>`;
}
