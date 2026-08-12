// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/site-profiles` — the Novamira CLI sites page, and its one fragment.
 *
 * **What the Go did, and why this is not it.** Go's Sites page had an "Add a
 * site" button, `renderSiteForm`, a `connected-directly` group,
 * `siteProfileEditButton` and `siteProfileRemoveButton` (`views.go:582-589`,
 * `:675-731`). Those managed **Go's own** `site_profiles` — a section of its
 * `config.json` holding a WordPress Application Password that Go had created
 * over the site's REST API and thereafter used on the operator's behalf. Every
 * one of those is deleted under the boundary rule and none of it is ported.
 *
 * This panel manages the **site CLI's** profiles. Nothing on it is HQ state:
 * the list is the stdout of `novamira sites list`, each row's pill is the stdout
 * of `novamira auth status --site <name>`, and each button spawns one more
 * `novamira` command. HQ holds no WordPress token, makes no request to a
 * configured site, and has no site profiles of its own — see
 * `src/integration/profiles.ts`, which is the only place these commands are
 * built. The page is therefore the one place in the dashboard whose whole
 * content belongs to another program.
 *
 * **Why it is a page and not a panel on `/sites`.** It began as one, and the
 * two listings turned out to have nothing in common but the word "site".
 * `/sites` answers "which environments do my hosts run, and which of them can
 * Novamira talk to?" — one provider API round trip per hosting profile, cached
 * for five minutes, filtered and searched. This page answers "what is
 * `novamira` actually configured for?" — local, uncached, and true of the
 * machine rather than of any host. A site connected by URL, which no hosting API
 * lists, appears only here, which is why the page carries its own "connect
 * another site" box. Nesting the second listing inside the first put a panel
 * with its own head, its own stamp and its own refresh underneath a page that
 * already had all three, and read as a box dropped into a page.
 *
 * **The two listings never share a request**, and that was true when this was a
 * panel too: `#sites-result` is expensive and deliberately stale, `#cli-sites`
 * is cheap and always fresh, and loading them together would tie one to the
 * other. So it has its own route, and an action on it repaints **this element
 * and the toast, and nothing else** — in particular it never triggers a
 * provider call and never invalidates the sites cache.
 *
 * **The root carries the `data-init`, so the fragment is patched outer.** That
 * is the `updates-card` arrangement and the same reasoning: an inner patch would
 * leave the pre-load root — and its `data-init` — in place, re-firing the
 * listing on every repaint.
 *
 * **Nothing here renders child output.** A row can show a
 * {@link SiteProfileRowView.hint} and the panel a {@link siteProfilesHint}, and
 * both are fixed sentences from the closed `UnavailableReason` set. The one
 * variable text on the panel is a profile name and a site URL, both of which
 * came back from `sites list` and both of which go through the `html` template.
 */

import * as ds from "../datastar.js";
import { confirmThen, post, signal } from "../expr.js";
import {
  attr,
  classAttr,
  flagAttr,
  hrefAttr,
  html,
  url,
  type Html,
} from "../html.js";
import type { HostingEnvLink } from "../services/sites.js";
import { type SiteProfileRowView, type SiteProfileState } from "./types.js";

/** The panel's own routes. Spelled once; the handlers pin the same strings. */
const CONNECT_PATH = "/_dashboard/site-profiles/connect";
const LOGOUT_PATH = "/_dashboard/site-profiles/logout";
const REMOVE_PATH = "/_dashboard/site-profiles/remove";

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
  connected: { text: "Connected", modifier: "ok" },
  reconnect_required: { text: "Reconnect required", modifier: "warn" },
  unreachable: { text: "Unreachable", modifier: "warn" },
  unknown: { text: "Unknown", modifier: false },
};

/** `title="…"` when there is a sentence, and no attribute when there is not. */
function titleAttr(text: string | undefined) {
  return text === undefined || text === "" ? false : attr("title", text);
}

/**
 * One profile.
 *
 * Reconnect is absent from a `connected` row for the same reason the Setup CTA
 * is absent from a connected environment above: a profile that already answers
 * is not one you re-authorize, and offering it would invite an operator to burn
 * a working credential to fix nothing. Sign out and Remove are offered in every
 * state, including `unknown` — "I cannot reach this site any more, get it out of
 * my list" is the case that most needs them.
 *
 * `links` is the hosting environments this profile was matched to, and is empty
 * whenever nobody has listed hosting sites in this process yet. See
 * {@link renderHostingLinks} for why an absent link is left absent.
 */
export function renderSiteProfileRow(
  row: SiteProfileRowView,
  links: readonly HostingEnvLink[],
  listContext?: { readonly profile: string; readonly includeEnvs: boolean },
): Html {
  const pill = PILLS[row.state];
  const routeContext =
    listContext === undefined
      ? {}
      : {
          profile: listContext.profile,
          include_envs: listContext.includeEnvs,
          unified: true,
        };
  const connect = post(
    url(CONNECT_PATH, { url: row.siteUrl, ...routeContext }),
    {
      include: [],
    },
  );
  const logout = confirmThen(
    `Sign out of ${row.name}? The Novamira site CLI will delete its credential and revoke it with the site.`,
    post(url(LOGOUT_PATH, { name: row.name, ...routeContext }), {
      include: [],
    }),
  );
  const remove = confirmThen(
    `Remove the site profile ${row.name}? The Novamira site CLI will forget the site entirely.`,
    post(url(REMOVE_PATH, { name: row.name, ...routeContext }), {
      include: [],
    }),
  );

  return html`<article${
    listContext === undefined ? false : classAttr("site-row", "cli-site-row")
  }${listContext === undefined ? false : ds.novamiraState("installed")}><div><strong>${row.name}</strong><small>${row.siteUrl}${
    row.expiresAt === undefined
      ? false
      : html` · credential expires ${row.expiresAt}`
  }</small>${renderHostingLinks(links)}</div><div class="env-actions"><span${classAttr(
    "pill",
    pill.modifier,
  )}${titleAttr(row.hint)}>${pill.text}</span>${
    row.state === "connected"
      ? false
      : html`<button class="button tiny" type="button"${attr(
          "title",
          `novamira auth login ${row.siteUrl}`,
        )}${ds.on("click", connect)}>Reconnect</button>`
  }<button class="button tiny" type="button"${attr(
    "title",
    `novamira --site ${row.name} auth logout`,
  )}${ds.on("click", logout)}>Sign out</button><button class="button tiny danger" type="button"${attr(
    "title",
    `novamira sites remove ${row.name}`,
  )}${ds.on("click", remove)}>Remove</button></div></article>`;
}

/** Actions for a CLI profile already represented by a hosting environment row. */
export function renderSiteProfileActions(
  row: SiteProfileRowView,
  listContext: { readonly profile: string; readonly includeEnvs: boolean },
): Html {
  const routeContext = {
    profile: listContext.profile,
    include_envs: listContext.includeEnvs,
    unified: true,
  };
  const reconnect = post(
    url(CONNECT_PATH, { url: row.siteUrl, ...routeContext }),
    { include: [] },
  );
  const logout = confirmThen(
    `Sign out of ${row.name}? The Novamira site CLI will delete its credential and revoke it with the site.`,
    post(url(LOGOUT_PATH, { name: row.name, ...routeContext }), {
      include: [],
    }),
  );
  const remove = confirmThen(
    `Remove the site profile ${row.name}? The Novamira site CLI will forget the site entirely.`,
    post(url(REMOVE_PATH, { name: row.name, ...routeContext }), {
      include: [],
    }),
  );
  return html`<span class="cli-profile-actions"><strong>${row.name}</strong>${
    row.state === "connected"
      ? false
      : html`<button class="button tiny" type="button"${ds.on(
          "click",
          reconnect,
        )}>Reconnect</button>`
  }<button class="button tiny" type="button"${ds.on(
    "click",
    logout,
  )}>Sign out</button><button class="button tiny danger" type="button"${ds.on(
    "click",
    remove,
  )}>Remove</button></span>`;
}

/**
 * "This profile is the hosting environment `<site> / <env>` on `<profile>`."
 *
 * The other half of the relation the Hosting Sites page draws from
 * `ConnectionResult.profiles`, and the same match read backwards — see
 * `services/sites.ts`'s `siteProfileLinks`. Both directions come from one
 * origin comparison made by `src/integration/`; nothing here compares a domain.
 *
 * **An unknown link is left absent rather than guessed at.** The map is warm
 * only: before anyone has opened Hosting Sites in this process it is empty, and
 * these rows carry no link. That is not a missing feature — it is the page
 * refusing to open with a round trip to every hosting API in order to draw a
 * cross-reference. Opening Hosting Sites once fills it in.
 */
function renderHostingLinks(links: readonly HostingEnvLink[]): Html | false {
  if (links.length === 0) return false;
  return html`<small>${links.map(
    (link, index) =>
      html`${index === 0 ? "" : ", "}<a${hrefAttr(
        url("/sites", { profile: link.profile }),
      )}${attr(
        "title",
        `Hosting environment ${link.envLabel} of ${link.siteLabel}, on the hosting profile ${link.profile}.`,
      )}>${link.siteLabel} / ${link.envLabel}</a>`,
  )}</small>`;
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
  )}><div class="panel-head"><div><h2>Connect a CLI site</h2><p>The Novamira site CLI opens your browser to authorize; HQ stores no site credential.</p></div></div><div class="form-grid"><label><span>Site URL</span><input type="url"${ds.bind(
    "cliSites.url",
  )} placeholder="https://example.com" required${disabled}></label><label><span>Custom name <small>(optional)</small></span><input type="text"${ds.bind(
    "cliSites.name",
  )} placeholder="Defaults to the domain" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" maxlength="64"${disabled}><small class="field-help">Letters, digits, dots, underscores, and hyphens.</small></label></div><div class="button-row"><button class="button primary" type="submit"${disabled}>Connect</button></div></form>`;
}
