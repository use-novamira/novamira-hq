// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Dedicated Updates page. The injected backend determines availability:
 * npm retains its installer; desktop checks published releases and offers
 * matching platform downloads through the system browser.
 */
import * as ds from "../datastar.js";
import { confirmThen, get, or, post, signal } from "../expr.js";
import {
  classAttr,
  desktopReleaseHref,
  html,
  idAttr,
  url,
  type Html,
} from "../html.js";

export interface UpdateCardView {
  readonly desktop?: boolean;
  readonly releaseUrl?: string;
  readonly downloadUrl?: string;
  /** No check or install controls when this distribution has no backend. */
  readonly unavailable?: boolean;
  /** False only before the first check has answered. */
  readonly checked: boolean;
  readonly current: string;
  readonly latest?: string;
  readonly updateAvailable: boolean;
  /** ISO-8601, from the update record. */
  readonly checkedAt?: string;
  /** Origin and path only; `distTagsUrl` refuses a registry URL with credentials. */
  readonly registry?: string;
  /** True once an install has succeeded in this process. */
  readonly installed?: boolean;
  /** The exact package-manager command that ran. */
  readonly command?: string;
  /** A `CliError` message, bounded and redacted. Never installer output. */
  readonly error?: string;
}

/** The starting view: nothing checked, nothing claimed. */
export function initialUpdateCardView(current: string): UpdateCardView {
  return { checked: false, current, updateAvailable: false };
}

interface Pill {
  /** The `pill` modifier, or `undefined` before the first check. */
  readonly modifier: "danger" | "warn" | "ok" | undefined;
  readonly text: string;
}

/** Go's `statusClassName`/`statusText` ladder (views.go:1381-1390), in order. */
function pillFor(view: UpdateCardView): Pill {
  if (view.installed) return { modifier: "ok", text: "restart required" };
  if (view.error !== undefined && view.error !== "") {
    return { modifier: "danger", text: "check failed" };
  }
  if (view.checked && view.updateAvailable) {
    return { modifier: "warn", text: "update available" };
  }
  if (view.checked) return { modifier: "ok", text: "up to date" };
  return { modifier: undefined, text: "Checking…" };
}

/** One `<dt>/<dd>` row, or nothing when the value is absent or empty. */
function detailRow(label: string, value: string | undefined): Html | false {
  if (value === undefined || value === "") return false;
  return html`<div><dt>${label}</dt><dd><code>${value}</code></dd></div>`;
}

export function renderUpdateCard(view: UpdateCardView): Html {
  if (view.unavailable) return renderUnavailableCard(view.current);
  const pill = pillFor(view);
  // Both buttons are disabled while either operation is in flight: a check that
  // lands mid-install would patch the card out from under the installer's
  // spinner.
  const busy = or(signal("updates.loading"), signal("updates.installing"));
  const check = get(url("/_dashboard/updates/check"), { include: [] });
  // `post` prepends `token` to the include scope and emits the
  // `X-Novamira-Dashboard-Token` header itself; Go wrote both out by hand.
  const install = confirmThen(
    view.latest === undefined
      ? "Install the latest Novamira HQ release? Restart the dashboard after updating to use the new version."
      : `Install Novamira HQ ${view.latest}? Restart the dashboard after updating to use the new version.`,
    post(url("/_dashboard/updates/install"), { include: [] }),
  );
  const selfCheck = get(url("/_dashboard/updates/check", { silent: true }), {
    include: [],
  });

  return html`<section${idAttr("updates-card")} class="panel updates-panel"${
    view.checked ? false : ds.init(selfCheck)
  }><div class="panel-head"><div class="updates-heading"><h2>Software updates</h2><span${classAttr(
    "pill",
    pill.modifier,
  )}>${pill.text}</span></div><p>${view.desktop ? "Check for a newer desktop release. To update, download it, quit Novamira HQ, and replace the application. Your settings and credentials are stored separately." : "Updates are never installed automatically. This installation uses npm or Bun. Check for a newer version and choose when to install it."}</p></div><dl class="details-list">${detailRow(
    "Current version",
    view.current,
  )}${detailRow("Latest version", view.latest)}${detailRow(
    "Checked",
    view.checkedAt,
  )}${detailRow("Registry", view.registry)}${detailRow(
    "Command",
    view.command,
  )}${
    view.error === undefined || view.error === ""
      ? false
      : html`<div><dt>Error</dt><dd>${view.error}</dd></div>`
  }</dl><div class="button-row"><button class="button secondary" type="button"${ds.indicator(
    "updates.loading",
  )}${ds.attrs({ disabled: busy })}${ds.on(
    "click",
    check,
  )}><span${ds.classes({ hidden: signal("updates.loading") })}>Check now</span><span class="loading-inline ds-toggle"${ds.classes(
    { open: signal("updates.loading") },
  )}><span class="spinner"></span>Checking</span></button>${
    view.updateAvailable && view.desktop
      ? html`${view.downloadUrl ? html`<a class="button primary" target="_blank" rel="noopener noreferrer"${desktopReleaseHref(view.downloadUrl)}>Download update</a>` : false}${view.releaseUrl ? html`<a class="button secondary" target="_blank" rel="noopener noreferrer"${desktopReleaseHref(view.releaseUrl)}>Release notes</a>` : false}`
      : view.updateAvailable
        ? html`<button class="button primary" type="button"${ds.indicator(
            "updates.installing",
          )}${ds.attrs({ disabled: busy })}${ds.on(
            "click",
            install,
          )}><span${ds.classes({ hidden: signal("updates.installing") })}>Install update</span><span class="loading-inline ds-toggle"${ds.classes(
            { open: signal("updates.installing") },
          )}><span class="spinner"></span>Installing</span></button>`
        : false
  }</div></section>`;
}

function renderUnavailableCard(current: string): Html {
  return html`<section${idAttr("updates-card")} class="panel updates-panel"><div class="panel-head"><div><h2>Novamira HQ</h2><p>Desktop application</p></div><span class="pill">Manual updates</span></div><dl class="details-list">${detailRow("Current version", current)}</dl><div class="updates-help"><p>Update checks are not available in this build yet. This does not mean your app is up to date.</p><p>To update now, quit Novamira HQ and replace it with a newer desktop release for your operating system and architecture. Your saved settings and credentials are stored separately.</p><p>Automatic checking and installation are not enabled. No update server has been contacted.</p></div></section>`;
}

export function renderUpdatesPage(
  current: string,
  available = true,
  desktop = false,
): Html {
  const card = {
    ...initialUpdateCardView(current),
    unavailable: !available,
    desktop,
  };
  return html`<section class="page flow-page updates-page"><header class="page-head"><div><h1>Novamira HQ updates</h1><p>Update this application, not your sites’ WordPress plugins or themes.</p></div></header>${renderUpdateCard(card)}</section>`;
}
