// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Settings page: the update card and the configuration-file panel.
 *
 * **What the Go did.** `renderSettingsPage` (`views.go:1348-1368`) rendered
 * `renderUpdateCard(updateView{})` above a read-only panel naming the config
 * path. `renderUpdateCard` (`views.go:1370-1452`) then built its three
 * Datastar expressions by string concatenation —
 * `"@get('/_dashboard/updates/check')"`,
 * `"@post('/_dashboard/updates/install', {headers: {'X-Novamira-Dashboard-Token':
 * $token}, filterSignals: {include: /^token$/}})"`, and a `confirm(...) && `
 * prefix glued in front of the second — and rendered a GitHub release model:
 * "Update asset", "Published", and a `Release notes` row containing an
 * `A(Href(view.Info.ReleaseURL))` to an external origin.
 *
 * **What HQ changes, and why each change.**
 *
 * - *The copy is true.* Go said "Check GitHub Releases for a newer Novamira CLI
 *   and install it in place." HQ reads an **npm dist-tag** and installs with a
 *   **package manager**; nothing is replaced in place. See `src/update/install.ts`.
 * - *Three rows are deleted with the model that fed them.* An npm dist-tag read
 *   answers with one string. There is no asset name, no publish timestamp and no
 *   release URL to render, and inventing a link would be worse than omitting
 *   one. **The card renders no external link at all** — it could not: the
 *   dashboard's CSP is `default-src 'self'` and `hrefAttr` only accepts a
 *   site-relative `Url`, so an external `href` is unrepresentable here.
 * - *Two rows are added*, because the npm model has facts Go's did not: the
 *   `Registry` the answer came from, and the `Command` that actually ran. The
 *   second is the whole of Go's "print the command you should run instead"
 *   honesty (update.go:201-212), made unconditional.
 * - *Every expression is constructed.* `get`/`post` always emit an include
 *   scope and the token header; `confirmThen` composes the confirm; `or` builds
 *   the disabled predicate. Go's `filterSignals: /^token$/` on the install
 *   `@post` is what `post(url, { include: [] })` produces by itself — `post`
 *   prepends `token` to every scope — so the literal is gone rather than
 *   retyped.
 * - *The install button is rendered only when an update is available*, exactly
 *   as Go did: a control that would answer "already up to date" is not a
 *   control, it is a second way to say what the pill already says.
 *
 * **The self-check on first render.** With `checked: false` the card carries
 * `ds.init(get("/_dashboard/updates/check?silent=true"))` — Go's `initAction`
 * (views.go:1372, 1437-1439). `silent=true` suppresses the "up to date" and
 * "check failed" toasts but **not** the "update available" one: opening Settings
 * should not toast at you, but it should still tell you there is an update. The
 * attribute is on the **root** of the fragment, which is why `updates-card` is
 * patched `outer` and never `inner`: an inner patch would leave the pre-check
 * root — and its `data-init` — in place, re-firing the check on every repaint.
 *
 * **The panel's copy loses one word.** Go said "Where Novamira stores your
 * hosting **and site** profiles"; HQ has no site profiles, so it says hosting
 * profiles and pushes, which is what the file actually holds. The path is
 * rendered inside a `<code>`; it is a *location*, never a content, and nothing
 * on this page reads the file.
 */

import * as ds from "../datastar.js";
import { confirmThen, get, or, post, signal } from "../expr.js";
import {
  attr,
  hrefAttr,
  classAttr,
  html,
  idAttr,
  url,
  type Html,
} from "../html.js";
import type { ConfigView } from "./types.js";

/**
 * What the update card knows.
 *
 * Every field but `checked`, `current` and `updateAvailable` is optional, and
 * every optional one renders a row only when it is present: the card before the
 * first check says "Checking…" and shows one row, rather than showing empty
 * rows with invented values.
 */
export interface UpdateCardView {
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
  )}>${pill.text}</span></div><p>Updates are never installed automatically. For a package installation, this page checks for a new version when opened. Desktop updates currently require installing a newer desktop release; automatic checks are not yet available.</p></div><dl class="details-list">${detailRow(
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
    view.updateAvailable
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

/**
 * The card defaults to the un-checked view built from `ConfigView.version`,
 * because a page load never checks: the card's own `data-init` does, silently,
 * once it is in the DOM. `renderPageBody` therefore passes one argument, and the
 * second exists so a test — and any future handler that wants to repaint the
 * whole page with a known result — can supply a filled card.
 */
export type SettingsTab = "general" | "updates" | "uninstall";

export function renderSettingsPage(
  view: ConfigView,
  card: UpdateCardView = initialUpdateCardView(view.version),
  tab: SettingsTab = "general",
): Html {
  if (tab === "uninstall")
    return html`<section class="page flow-page"><header class="page-head"><div><h1>Uninstall Novamira HQ</h1><a class="text-link"${hrefAttr(url("/about"))}>← About Novamira HQ</a></div></header>${renderUninstallHelp()}</section>`;
  return html`<section class="page flow-page"><header class="page-head"><div><h1>Settings</h1></div></header><nav class="settings-tabs" aria-label="Settings sections">${(["general", "updates"] as const).map((key) => html`<a class="settings-tab"${hrefAttr(url("/settings", { tab: key }))}${key === tab ? attr("aria-current", "page") : false}>${{ general: "General", updates: "Updates", uninstall: "Uninstalling" }[key]}</a>`)}</nav>${tab === "updates" ? renderUpdateCard(card) : html`<section class="panel"><div class="panel-head"><div><h2>Configuration file</h2><p>Where Novamira HQ stores your hosting profiles and pushes. Read-only for now — not editable from the dashboard yet.</p></div></div><dl class="details-list"><div><dt>Path</dt><dd><code>${view.configFile}</code></dd></div></dl></section>`}</section>`;
}

/** Instructions only: no uninstall command or credential action is executed. */
export function renderUninstallHelp(): Html {
  return html`<section class="how-to-card" aria-labelledby="uninstall-title"><h2 id="uninstall-title">Remove the app</h2><p>Quit Novamira HQ, then remove the app:</p><ul><li><strong>macOS:</strong> move Novamira HQ from Applications to the Trash.</li><li><strong>Windows or Linux:</strong> delete the downloaded app and its shortcut or launcher.</li></ul><section><h3>What stays</h3><p>Your websites and WordPress plugins are not deleted or changed. Saved settings and credentials stay on this computer. Novamira CLI, if installed, remains available to your other AI clients.</p></section><details class="uninstall-extra"><summary>Optional cleanup</summary><div><p>Do these steps before uninstalling the app, only if you also want to remove its saved connections:</p><ol><li>In <a${hrefAttr(url("/hosting-accounts"))}>Hosting accounts</a>, remove accounts you no longer need. This removes local registrations, not the hosted websites. Check any warning about credentials that could not be removed.</li><li>Remove the Novamira HQ connector from each AI client you configured.</li><li>To revoke a site connection too, use Disconnect in Sites before removing the app. This also affects other agents using that same saved connection.</li></ol><p>This is not a complete cleanup of all local files or authorizations on other devices.</p></div></details><details class="uninstall-extra"><summary>Uninstalling from the terminal (advanced)</summary><div><p>Only use these instructions for packages installed globally with npm. For other installation methods, follow their removal instructions.</p><h3>Remove the Novamira HQ package</h3><pre class="code-output"><code>npm uninstall -g @novamira/hq</code></pre><p>Remove its launcher separately. Saved settings and credentials remain.</p><h3>Also remove Novamira CLI (optional)</h3><p>Keep it if you use Novamira with other agents. If you want to disconnect its sites, do that <strong>before uninstalling</strong> the CLI. List the profiles:</p><pre class="code-output"><code>novamira sites list --json</code></pre><p>For each connection you want to remove, replace PROFILE_NAME with its exact name:</p><pre class="code-output"><code>novamira --site PROFILE_NAME auth logout
novamira sites remove PROFILE_NAME</code></pre><p>Check the logout result: remote revocation can fail. Removing a profile does not delete the website. Then remove the CLI package:</p><pre class="code-output"><code>npm uninstall -g @novamira/cli</code></pre><p>This removes the executable, not the WordPress plugin, and does not guarantee removal of all saved data.</p></div></details><p class="field-help">This is a guide only. Novamira HQ does not run removal commands or delete credentials from this page.</p></section>`;
}
