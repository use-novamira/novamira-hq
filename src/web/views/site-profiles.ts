// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Site-CLI profile rows and controls for the unified `/sites` inventory.
 *
 * **What the Go did, and why this is not it.** Go's Sites page had an "Add a
 * site" button, `renderSiteForm`, a `connected-directly` group,
 * `siteProfileEditButton` and `siteProfileRemoveButton` (`views.go:582-589`,
 * `:675-731`). Those managed **Go's own** `site_profiles` — a section of its
 * `config.json` holding a WordPress Application Password that Go had created
 * over the site's REST API and thereafter used on the operator's behalf. Every
 * one of those is deleted under the boundary rule and none of it is ported.
 *
 * These controls manage the **site CLI's** profiles. Nothing here is HQ state:
 * the list is the stdout of `novamira sites list`, each row's pill is the stdout
 * of `novamira auth status --site <name>`, and each button spawns one more
 * `novamira` command. HQ holds no WordPress token, makes no request to a
 * configured site, and has no site profiles of its own — see
 * `src/integration/profiles.ts`, which is the only place these commands are
 * built. These controls therefore represent state owned by another program.
 *
 * `/sites` combines both sources without conflating them: provider inventory is
 * cached for five minutes, while site-CLI state is refreshed independently
 * against the warm provider groups. Matching profiles are rendered on their
 * hosting environments and unmatched profiles in the CLI-only group. Profile
 * actions repaint `#sites-result` from warm hosting data and never trigger a
 * provider call.
 *
 * **Nothing here renders child output.** A row can show a
 * {@link SiteProfileRowView.hint} and the inventory a {@link siteProfilesHint}, and
 * both are fixed sentences from the closed `UnavailableReason` set. The one
 * variable text on the panel is a profile name and a site URL, both of which
 * came back from `sites list` and both of which go through the `html` template.
 */

import * as ds from "../datastar.js";
import { confirmThen, get, post, signal, type Expr } from "../expr.js";
import {
  attr,
  classAttr,
  flagAttr,
  hrefAttr,
  html,
  url,
  type Html,
} from "../html.js";
import { dynamicSignalPath, siteProfileRenameSignal } from "../signals.js";
import { type SiteProfileRowView, type SiteProfileState } from "./types.js";

/** The panel's own routes. Spelled once; the handlers pin the same strings. */
const CONNECT_PATH = "/_dashboard/site-profiles/connect";
const LOGOUT_PATH = "/_dashboard/site-profiles/logout";
const RENAME_PATH = "/_dashboard/site-profiles/rename";
const REMOVE_PATH = "/_dashboard/site-profiles/remove";

export interface SiteConnectSuccessView {
  readonly siteUrl: string;
  readonly profileName?: string;
}

/** Full-page completion for a newly connected direct site, never for Reconnect. */
export function renderSiteConnectSuccess(view: SiteConnectSuccessView): Html {
  return html`<section class="page connect-success-page"><header class="page-head"><div><h1 id="site-connected-title">Site connected</h1><p>Connection complete.</p></div></header><section class="how-to-card connect-success" aria-labelledby="site-connected-title"><span class="connect-success-mark" aria-hidden="true">✓</span><div><p><strong>${view.profileName ?? view.siteUrl}</strong> is now available through the Novamira site CLI.</p>${view.profileName === undefined ? false : html`<p class="field-help">${view.siteUrl}</p>`}</div><div class="button-row"><a class="button primary"${hrefAttr(
    url("/sites"),
  )}>Open Sites</a><a class="button secondary"${hrefAttr(
    url("/sites", { new: "cli" }),
  )}>Connect another site</a></div><p class="field-help">Open your AI client to work with this site. Novamira HQ does not need to remain open.</p></section></section>`;
}

function renderProfileMenu(
  name: string,
  routeContext: Readonly<Record<string, string | boolean>>,
  logout: Expr,
  remove: Expr | null,
  inline = false,
): Html {
  const renameSignal = siteProfileRenameSignal(name);
  const rename = post(url(RENAME_PATH, { name, ...routeContext }), {
    include: [renameSignal],
  });
  const items = html`<details class="profile-rename"><summary class="button tiny quiet profile-menu-action">Rename</summary><form class="rename-profile"${ds.signals(
    {
      [renameSignal]: name,
    },
  )}${ds.onSubmit(rename)}><input type="text"${attr(
    "aria-label",
    `New name for ${name}`,
  )}${ds.bind(renameSignal)} pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" maxlength="64" required><button class="button tiny" type="submit"${attr(
    "title",
    `novamira sites rename ${name} <new-name>`,
  )}>Save name</button></form></details><button class="button tiny quiet profile-menu-action" type="button"${attr(
    "title",
    `novamira --site ${name} auth logout`,
  )}${ds.on("click", logout)}>Disconnect</button>${
    remove === null
      ? false
      : html`<button class="button tiny danger quiet profile-menu-action" type="button"${attr(
          "title",
          `novamira sites remove ${name}`,
        )}${ds.on("click", remove)}>Remove from list</button>`
  }`;
  return inline
    ? items
    : html`<details class="profile-menu"><summary class="button tiny quiet"${attr("aria-label", `More actions for ${name}`)}>⋯</summary><div class="profile-menu-popover">${items}</div></details>`;
}

/**
 * The pill's text and `pill` modifier, exhaustive over the four states, so a
 * fifth state cannot ship without one.
 */
const PILLS: Readonly<
  Record<
    SiteProfileState,
    { readonly text: string; readonly modifier: string | false }
  >
> = {
  connected: { text: "Access authorized", modifier: "ok" },
  reconnect_required: { text: "Authorization required", modifier: "warn" },
  unreachable: { text: "Access not verified", modifier: false },
  unknown: { text: "Access not verified", modifier: false },
};

/** `title="…"` when there is a sentence, and no attribute when there is not. */
function titleAttr(text: string | undefined) {
  return text === undefined || text === "" ? false : attr("title", text);
}

/** Reconnect-required is rendered as one action, not as a pill plus an action. */
function reconnectButton(row: SiteProfileRowView, action: Expr): Html {
  const busy = dynamicSignalPath("reconnecting", row.name);
  return html`<button class="button tiny" type="button"${ds.indicator(busy)}${ds.attrs({ disabled: signal(busy) })}${ds.on("click", action)}><span${ds.classes({ hidden: signal(busy) })}>Authorize again</span><span class="loading-inline ds-toggle"${ds.classes({ open: signal(busy) })}>Authorizing…</span></button>`;
}

export function renderCheckAccess(): Html {
  const action = get(
    url("/_dashboard/sites", { connections_only: true, include_envs: true }),
    { include: ["sites"] },
  );
  return html`<button class="button tiny" type="button"${ds.indicator("sites.loading")}${ds.attrs({ disabled: signal("sites.loading") })}${ds.on("click", action)}>Check access</button>`;
}

function renderConnectionControl(row: SiteProfileRowView, connect: Expr): Html {
  const pill =
    row.reason === "site_incompatible"
      ? { text: "Novamira not ready", modifier: "warn" }
      : PILLS[row.state];
  if (row.state === "reconnect_required") {
    return reconnectButton(row, connect);
  }
  const status = html`<span${classAttr("pill", pill.modifier)}${titleAttr(
    row.hint,
  )}>${pill.text}</span>`;
  if (row.state === "connected") return status;
  return html`${status}${renderCheckAccess()}`;
}

/**
 * One profile.
 *
 * Reconnect is absent from a `connected` row for the same reason the Setup CTA
 * is absent from a connected environment above: a profile that already answers
 * is not one you re-authorize, and offering it would invite an operator to burn
 * a working credential to fix nothing. Disconnect and Remove from list are
 * offered in every state, including `unknown` — "I cannot reach this site any
 * more, get it out of my list" is the case that most needs them.
 *
 * `listContext` keeps every action on the hosting inventory currently rendered.
 */
export function renderSiteProfileRow(
  row: SiteProfileRowView,
  listContext?: { readonly profile: string; readonly includeEnvs: boolean },
): Html {
  const routeContext =
    listContext === undefined
      ? {}
      : {
          profile: listContext.profile,
          include_envs: listContext.includeEnvs,
          unified: true,
        };
  const connect = post(
    url(CONNECT_PATH, { url: row.siteUrl, name: row.name, ...routeContext }),
    {
      include: [],
    },
  );
  const logout = confirmThen(
    `Disconnect ${row.name} from Novamira? Its authorization will be revoked, but the site will stay in this list so you can reconnect it later.`,
    post(url(LOGOUT_PATH, { name: row.name, ...routeContext }), {
      include: [],
    }),
  );
  const remove = confirmThen(
    `Remove ${row.name} from this list? Its saved site profile will be deleted from this computer. The website will not be deleted. To add it again, use Connect with ${row.siteUrl}.`,
    post(url(REMOVE_PATH, { name: row.name, ...routeContext }), {
      include: [],
    }),
  );

  if (listContext !== undefined) {
    return html`<article class="site-row cli-site-row"${ds.novamiraState(
      row.state === "connected" ? "installed" : "install",
    )}><strong class="cli-site-name">${row.name}</strong><small class="cli-site-url">${row.siteUrl}</small><div class="site-state">${renderConnectionControl(
      row,
      connect,
    )}${renderProfileMenu(
      row.name,
      routeContext,
      logout,
      remove,
    )}</div></article>`;
  }

  return html`<article><div><strong>${row.name}</strong><small>${row.siteUrl}${
    row.expiresAt === undefined
      ? false
      : html` · credential expires ${row.expiresAt}`
  }</small></div><div class="env-actions">${renderConnectionControl(
    row,
    connect,
  )}${renderProfileMenu(
    row.name,
    routeContext,
    logout,
    remove,
  )}</div></article>`;
}

/** Actions for a CLI profile already represented by a hosting environment row. */
export function renderSiteProfileActions(
  row: SiteProfileRowView,
  listContext: {
    readonly profile: string;
    readonly includeEnvs: boolean;
    readonly hideName?: boolean;
    readonly reconnectAction?: Expr | undefined;
    readonly menuMode?: "hidden" | "inline";
    readonly suppressReconnect?: boolean;
    readonly showProfileHeading?: boolean;
  },
): Html {
  const routeContext = {
    profile: listContext.profile,
    include_envs: listContext.includeEnvs,
    unified: true,
  };
  const reconnect =
    listContext.reconnectAction ??
    post(
      url(CONNECT_PATH, { url: row.siteUrl, name: row.name, ...routeContext }),
      { include: [] },
    );
  const logout = confirmThen(
    `Disconnect ${row.name} from Novamira? Its authorization will be revoked, but the site will stay in this list so you can reconnect it later.`,
    post(url(LOGOUT_PATH, { name: row.name, ...routeContext }), {
      include: [],
    }),
  );
  if (listContext.menuMode === "inline")
    return html`<div class="profile-menu-group">${listContext.showProfileHeading ? html`<p class="field-help">${row.name}</p>` : false}${renderProfileMenu(row.name, routeContext, logout, null, true)}</div>`;
  return html`<span class="cli-profile-actions">${listContext.hideName ? false : html`<strong>${row.name}</strong>`}${
    row.state === "connected" || listContext.suppressReconnect
      ? false
      : row.state === "reconnect_required"
        ? reconnectButton(row, reconnect)
        : renderCheckAccess()
  }${listContext.menuMode === "hidden" ? false : renderProfileMenu(row.name, routeContext, logout, null)}</span>`;
}

/**
 * "Connect another site."
 *
 * The URL travels in the **body** rather than in the query string, which is why
 * this is a `@post` over the `cliSites` include scope: a `@get`'s signals are
 * serialized into `?datastar=…`, and a value the operator pastes belongs in
 * neither a URL nor a server log. The handler normalizes it with
 * `normalizeSiteUrl` before it can reach an argv array, and there is no name
 * field — profile naming belongs to the site CLI, and `auth login` is spawned
 * with the URL as its only argument.
 *
 * **`.form-grid` + `.button-row`, never `.check-row`.** `app.css` is frozen and
 * is the Go program's, so its classes mean what they meant there —
 * `.check-row` is the *checkbox* row the setup page's AI-Abilities toggle uses,
 * and it carries `input { width: 16px; min-height: 16px }`. A text input placed
 * in one renders as a 16-pixel square wedged between its label and the button.
 * The pair below is `renderProviderForm`'s structure, which is the shape this
 * stylesheet has for "a labelled field and the button that submits it".
 */
export function renderConnectForm(
  usable: boolean,
  unified = false,
  open = false,
): Html {
  const submit = post(url(CONNECT_PATH, unified ? { unified: true } : {}), {
    include: unified ? ["cliSites", "sites"] : ["cliSites"],
  });
  const disabled = usable ? false : flagAttr("disabled");
  return html`<form${classAttr(
    "panel",
    "form-panel",
    "ds-toggle",
    unified && "cli-site-form",
    open && "open",
  )}${ds.classes({ open: signal("cliSites.open") })}${ds.onSubmit(
    submit,
  )}><div class="panel-head"><div><h2>Add site manually</h2><p>Your browser will open so you can authorize the connection. The connection will be saved on your computer.</p></div></div><div class="form-grid"><label><span>Site URL</span><input type="url"${ds.bind(
    "cliSites.url",
  )} placeholder="https://example.com" required${disabled}></label><label><span>Custom name <small>(optional)</small></span><input type="text"${ds.bind(
    "cliSites.name",
  )} placeholder="Defaults to the domain" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" maxlength="64"${disabled}><small class="field-help">Letters, digits, dots, underscores, and hyphens.</small></label></div><div class="button-row"><button class="button primary" type="submit"${disabled}>Connect</button></div></form>`;
}
