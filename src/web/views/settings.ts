// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { hrefAttr, html, url, type Html } from "../html.js";
import type { ConfigView } from "./types.js";

export type SettingsTab = "general" | "uninstall";

export function renderSettingsPage(
  view: ConfigView,
  tab: SettingsTab = "general",
): Html {
  if (tab === "uninstall")
    return html`<section class="page flow-page"><header class="page-head"><div><h1>Uninstall Novamira HQ</h1><a class="text-link"${hrefAttr(url("/about"))}>← About Novamira HQ</a></div></header>${renderUninstallHelp()}</section>`;
  return html`<section class="page flow-page"><header class="page-head"><div><h1>Settings</h1></div></header><section class="panel"><div class="panel-head"><div><h2>Configuration file</h2><p>Where Novamira HQ stores your hosting profiles and pushes. Read-only for now — not editable from the dashboard yet.</p></div></div><dl class="details-list"><div><dt>Path</dt><dd><code>${view.configFile}</code></dd></div></dl></section></section>`;
}

/** Instructions only: no uninstall command or credential action is executed. */
export function renderUninstallHelp(): Html {
  return html`<section class="how-to-card" aria-labelledby="uninstall-title"><h2 id="uninstall-title">Remove the app</h2><p>Quit Novamira HQ, then remove the app:</p><ul><li><strong>macOS:</strong> move Novamira HQ from Applications to the Trash.</li><li><strong>Windows or Linux:</strong> delete the downloaded app and its shortcut or launcher.</li></ul><section><h3>What stays</h3><p>Your websites and WordPress plugins are not deleted or changed. Saved settings and credentials stay on this computer. Novamira CLI, if installed, remains available to your other AI clients.</p></section><details class="uninstall-extra"><summary>Optional cleanup</summary><div><p>Do these steps before uninstalling the app, only if you also want to remove its saved connections:</p><ol><li>In <a${hrefAttr(url("/hosting-accounts"))}>Hosting accounts</a>, remove accounts you no longer need. This removes local registrations, not the hosted websites. Check any warning about credentials that could not be removed.</li><li>Remove the Novamira HQ connector from each AI client you configured.</li><li>To revoke a site connection too, use Disconnect in Sites before removing the app. This also affects other agents using that same saved connection.</li></ol><p>This is not a complete cleanup of all local files or authorizations on other devices.</p></div></details><details class="uninstall-extra"><summary>Uninstalling from the terminal (advanced)</summary><div><p>Only use these instructions for packages installed globally with npm. For other installation methods, follow their removal instructions.</p><h3>Remove the Novamira HQ package</h3><pre class="code-output"><code>npm uninstall -g @novamira/hq</code></pre><p>Remove its launcher separately. Saved settings and credentials remain.</p><h3>Also remove Novamira CLI (optional)</h3><p>Keep it if you use Novamira with other agents. If you want to disconnect its sites, do that <strong>before uninstalling</strong> the CLI. List the profiles:</p><pre class="code-output"><code>novamira sites list --json</code></pre><p>For each connection you want to remove, replace PROFILE_NAME with its exact name:</p><pre class="code-output"><code>novamira --site PROFILE_NAME auth logout
novamira sites remove PROFILE_NAME</code></pre><p>Check the logout result: remote revocation can fail. Removing a profile does not delete the website. Then remove the CLI package:</p><pre class="code-output"><code>npm uninstall -g @novamira/cli</code></pre><p>This removes the executable, not the WordPress plugin, and does not guarantee removal of all saved data.</p></div></details><p class="field-help">This is a guide only. Novamira HQ does not run removal commands or delete credentials from this page.</p></section>`;
}
