// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Sites page: the toolbar, the segmented filter, `#sites-status`,
 * `#sites-result`, and everything inside it down to one environment's state
 * cell.
 *
 * **What the Go did.** `renderSitesPage` (`views.go:571-620`) used gomponents;
 * `renderSitesResult`, `renderSiteGroup`, `renderSiteItem`, `renderEnvironment`
 * and `renderSetupButton` (`:903-1049`) wrote angle brackets into a
 * `strings.Builder` and pasted URLs together with `url.QueryEscape`. Every
 * fragment here is an `html` template and every link is a `url()`.
 *
 * **The markup is a contract with a frozen asset.** `src/web/static/
 * sites-filter.js` selects `#sites-result .provider-sites`, `.site-grid`,
 * `.site-row`, `.site-row[data-nm-state]`, `.seg-btn[data-sf-status]`,
 * `[data-sf-count="with"]`, `[data-sf-count="without"]` and
 * `input[data-bind="sites.search"]`, and it *observes* `#sites-result` for
 * mutations. That is why `#sites-result` is patched **outer** (replacing it
 * re-triggers filtering) and `#sites-status` **inner** (an outer patch of the
 * status would fire the observer every time a spinner appeared). The asset is
 * copied verbatim from the Go program and must not be edited: when the markup
 * and a selector disagree, the markup moves.
 *
 * `relative-time.js` overwrites the `textContent` of any `[data-checked-at]`
 * element, which is why the "Last updated: " label lives in the `<small>` and
 * the stamp in a `<span>` inside it. Go rendered an absolute `time.Kitchen`
 * stamp there (`views.go:890`); handing it to the shipped script instead costs
 * nothing and matches the provider table.
 *
 * **What is deleted, not ported.**
 *
 * - The "Add a site" button and `renderSiteForm` (`views.go:582-589`), with the
 *   whole site-profile surface. HQ holds no WordPress credential.
 * - `renderConnectedDirectly` and the `section.site-group.connected-directly`
 *   block (`views.go:675-717`), `siteProfileEditButton`,
 *   `siteProfileRemoveButton` (`:719-731`), and `setupAgainLink` with its "Fix
 *   set up" label (`:1051-1058`) — there is no saved site connection to replace.
 *   `sites-filter.js` still names `.site-group` in one selector; it now matches
 *   nothing, which is fine and is not a reason to touch the asset.
 * - `novamiraRowState`, `novamiraLinkedToEnv`, `novamiraLinkedSiteProfile`,
 *   `normalizeHost` and `hostingDomains` (`:652-673`, `:1087-1141`). Go decided
 *   "Novamira is installed here" by matching an environment hostname against a
 *   `site_profiles` entry — a boolean derived from data HQ deliberately no
 *   longer holds, and wrong in both directions. The replacement reads the site
 *   CLI's four-state answer: `installed` when a site has at least one
 *   environment and **every** one of them is `connected`, `install` otherwise
 *   (including a site with no environments at all). Two values, because
 *   `sites-filter.js:28-33` compares against exactly those two literals.
 * - The `siteprofile` and `replace` query parameters on the setup link
 *   (`:1068-1085`).
 *
 * **The Connect button is the whole site-connection story.** It posts a URL —
 * never a credential — to `/_dashboard/connect`, which spawns
 * `novamira auth login <url>` through `src/integration/`. Its `title` is the
 * literal command, which is the copyable fallback the plan's decision 3
 * requires; when the state is `unavailable` the button is `disabled` and the
 * title becomes the fixed hint, which is also what a missing site CLI produces,
 * because `connectionView` folds `cliAvailable: false` into that state. Nothing
 * here renders child output, an error message or a path: the only sentence a
 * cell can show is a {@link ConnectionView.hint}, and those are a closed set.
 *
 * **Layering note.** {@link SiteGroup} is imported type-only from
 * `services/sites.ts`, and `connectionKey`/`connectionFor`/`displayLabel` are
 * imported as values. The dependency runs views → services, never the reverse:
 * a service may not import a view, which is what keeps a page renderable in a
 * test with no server. The key builder is shared rather than re-spelled because
 * a second spelling would silently render every environment "Not connected".
 */

import type { ConnectionSnapshot } from "../../connection-state.js";
import type {
  SiteProfileListing,
  SiteProfileSummary,
} from "../../site-profiles.js";
import {
  ENVIRONMENT_PUSH_PROVIDERS,
  NOVAMIRA_SETUP_PROVIDERS,
  providerLabel,
  type HostingEnvironment,
  type HostingSite,
} from "../../hosting/types.js";
import * as ds from "../datastar.js";
import { get, post, signal } from "../expr.js";
import {
  attr,
  classAttr,
  flagAttr,
  hrefAttr,
  html,
  idAttr,
  url,
  type Html,
} from "../html.js";
import {
  connectionFor,
  connectionKey,
  displayLabel,
  type SiteGroup,
} from "../services/sites.js";
import { renderNotice } from "./layout.js";
import {
  renderConnectForm,
  renderSiteProfileActions,
  renderSiteProfileRow,
} from "./site-profiles.js";
import {
  connectionView,
  providerLabelFor,
  siteProfileRowView,
  type ConfigView,
  type ConnectionView,
  type DashboardNotice,
} from "./types.js";

/** Go's disabled-button sentence, naming the three providers verbatim. */

/** Why Connect is disabled when the environment has no public address. */
const NO_DOMAIN_TITLE =
  "This environment has no public domain yet, so there is nothing to connect.";

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `/sites`.
 *
 * The page renders the latest process-local snapshot immediately, then refreshes
 * in the background on mount. Existing rows remain visible during refresh.
 *
 * The result is one unified inventory. Hosting environments come from provider
 * APIs; profiles from `novamira sites list` are attached to matching environment
 * rows, while unmatched profiles appear once in the CLI-only group.
 *
 * The `@get`'s include scope is `sites` and nothing else. It may never carry
 * `token` or `providerForm`: a `@get`'s filtered signals are serialized into
 * `?datastar=…`, and `expr.get` refuses both outright.
 */
export function renderSitesPage(
  view: ConfigView,
  cliFormOpen = false,
  snapshot?: import("../services/sites.js").SitesResult,
): Html {
  if (cliFormOpen) {
    return html`<section class="page"><header class="page-head"><div><h1>Connect site by URL</h1><p>Connect an existing Novamira site directly, without adding a hosting account.</p></div><a class="button secondary"${hrefAttr(
      url("/sites"),
    )}>Back to Sites</a></header>${renderConnectForm(
      true,
      true,
      true,
    )}</section>`;
  }
  const load = get(url("/_dashboard/sites", { include_envs: true }), {
    include: ["sites"],
  });
  const refresh = get(
    url("/_dashboard/sites", { include_envs: true, refresh: true }),
    { include: ["sites"] },
  );
  return html`<section class="page"><header class="page-head"><div><h1>Sites</h1><p>Hosting environments and their Novamira connections.</p></div></header>${renderConnectForm(
    true,
    true,
    false,
  )}<form class="toolbar"${ds.indicator(
    "sites.loading",
  )}${ds.init(load)}${ds.on("change", load)}${ds.onSubmit(
    refresh,
  )}><label class="search"><input type="search"${ds.bind(
    "sites.search",
  )} placeholder="Search by name or domain…"></label><label><span>Hosting account</span><select${ds.bind(
    "sites.profile",
  )}><option value="__all__">All accounts</option>${view.profiles.map(
    (profile) =>
      html`<option${attr("value", profile.name)}>${profile.name} (${providerLabelFor(
        profile.provider,
      )})</option>`,
  )}</select></label><div class="sites-refresh"><button class="button secondary" type="submit">Refresh</button><div${idAttr(
    "sites-status",
  )} class="sites-status">${renderSitesStatus(
    snapshot?.storedAt ?? null,
  )}</div></div></form><div class="sites-filter-bar"><div class="seg" role="group" aria-label="Novamira status"><button type="button" class="seg-btn on"${ds.sitesFilterStatus(
    "all",
  )}>All</button><button type="button" class="seg-btn"${ds.sitesFilterStatus(
    "with",
  )}>Connected <span class="seg-count"${ds.sitesFilterCount(
    "with",
  )}>0</span></button><button type="button" class="seg-btn"${ds.sitesFilterStatus(
    "without",
  )}>Needs attention <span class="seg-count"${ds.sitesFilterCount(
    "without",
  )}>0</span></button></div><label class="hosting-hidden-toggle" title="Visibility preferences are saved in this browser"><input type="checkbox" class="show-hidden-sites"> Show hidden sites</label></div>${snapshot ? renderSitesResult({ ...snapshot, notice: { level: "neutral", message: "" } }) : html`<div${idAttr("sites-result")} class="results empty">Loading sites…</div>`}</section>`;
}

/* -------------------------------------------------------------------------- */
/* #sites-status                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The **contents** of `#sites-status` — no wrapper, because the fragment is
 * patched inner.
 *
 * `checkedAtMillis` is when the provider listing was stored, not when the
 * connection states were read: it answers "how old are these sites?", which is
 * what the Refresh button beside it acts on.
 */
export function renderSitesStatus(checkedAtMillis: number | null): Html {
  return html`<small class="last-updated">Last updated: ${
    checkedAtMillis === null
      ? "never"
      : html`<span${ds.checkedAt(checkedAtMillis)}>just now</span>`
  }</small><span class="loading-inline ds-toggle"${ds.classes({
    open: signal("sites.loading"),
  })}><span class="spinner" aria-hidden="true"></span><span>Fetching sites</span></span>`;
}

/* -------------------------------------------------------------------------- */
/* #sites-result                                                              */
/* -------------------------------------------------------------------------- */

export interface SitesResultView {
  /**
   * The cache key the groups came from. It rides along on every Connect link so
   * that `/_dashboard/connect` repaints the listing the operator is actually
   * looking at rather than guessing at `__all__`.
   */
  readonly profile: string;
  readonly includeEnvs: boolean;
  readonly groups: readonly SiteGroup[];
  readonly connections: ConnectionSnapshot | null;
  readonly siteProfiles?: SiteProfileListing | null;
  /** Non-empty replaces the whole result with the notice, as Go's did. */
  readonly notice: DashboardNotice;
}

export function renderSitesResult(view: SitesResultView): Html {
  if (view.notice.message !== "") {
    return html`<div${idAttr("sites-result")} class="results">${renderNotice(
      view.notice,
    )}</div>`;
  }
  const cliOnly = cliOnlyProfiles(view);
  return html`<div${idAttr("sites-result")} class="results">${
    view.groups.length === 0 && cliOnly.length === 0
      ? html`<div class="empty">No sites found.</div>`
      : view.groups.map((group) => renderSiteGroup(group, view))
  }${renderCliOnly(cliOnly, view)}</div>`;
}

function cliOnlyProfiles(view: SitesResultView): readonly SiteProfileSummary[] {
  if (view.siteProfiles == null || view.siteProfiles.reason !== undefined) {
    return [];
  }
  const matched = new Set<string>();
  for (const result of view.connections?.byKey.values() ?? []) {
    for (const name of result.profiles) matched.add(name);
  }
  return view.siteProfiles.profiles.filter(({ name }) => !matched.has(name));
}

function renderCliOnly(
  profiles: readonly SiteProfileSummary[],
  view: SitesResultView,
): Html | false {
  if (profiles.length === 0) return false;
  return html`<section class="provider-sites cli-sites"><div class="group-head"><div><h2>Sites added by URL</h2><p>Not matched to an environment above. The same site may appear here when its connected URL uses a different domain.</p></div><span class="pill">${String(
    profiles.length,
  )} sites</span></div><div class="site-grid cli-site-grid">${profiles.map(
    (profile) =>
      renderSiteProfileRow(siteProfileRowView(profile), {
        profile: view.profile,
        includeEnvs: view.includeEnvs,
      }),
  )}</div></section>`;
}

/** Go's `renderSiteGroup` (`views.go:927-953`). */
function renderSiteGroup(group: SiteGroup, view: SitesResultView): Html {
  const head = html`<div class="group-head"><div><h2>${group.profile}</h2><p>${providerLabel(
    group.provider,
  )}</p></div>`;
  if (group.stale) {
    return html`<section class="provider-sites">${head}<span class="pill warn">API unavailable</span></div>${renderNotice(
      {
        level: "warn",
        message:
          `Could not refresh this hosting provider. Showing its last known sites; this does not mean the sites are offline. ${group.error ?? ""}`.trim(),
      },
    )}${
      group.sites.length === 0
        ? html`<div class="empty">No sites were present in the last successful response.</div>`
        : html`<div class="site-grid">${group.sites.map((site) =>
            renderSiteItem(group, site, view),
          )}</div>`
    }</section>`;
  }
  if (group.error !== undefined && group.error !== "") {
    return html`<section class="provider-sites">${head}<span class="pill danger">error</span></div><div class="empty error">${group.error}</div></section>`;
  }
  return html`<section class="provider-sites">${head}<span class="pill">${String(
    group.sites.length,
  )} sites</span></div>${
    group.sites.length === 0
      ? html`<div class="empty">No sites returned by this provider.</div>`
      : html`<div class="site-grid">${group.sites.map((site) =>
          renderSiteItem(group, site, view),
        )}</div>`
  }</section>`;
}

/** Go's `renderSiteItem` (`views.go:955-1004`). */
function renderSiteItem(
  group: SiteGroup,
  site: HostingSite,
  view: SitesResultView,
): Html {
  const title = displayLabel(site.displayName, site.name, site.id);
  const domain = site.primaryDomain ?? "";
  const envs = site.environments ?? [];
  const state = novamiraRowState(group, site, view);
  const visibility = html`<button class="button tiny quiet hosting-visibility" type="button"${attr("aria-label", `Hide ${title} from this list`)}>Hide from list</button>`;

  if (envs.length > 1) {
    return html`<details${classAttr(
      "site-row",
      "site-row-multi",
    )}${ds.hostingSiteKey(group.profile, site.id)}${ds.novamiraState(
      state,
    )}><summary class="site-main"><span class="site-chevron"></span><span class="site-name">${title}</span><span class="site-domain">${domain}</span><span class="site-state"><span class="pill">${String(
      envs.length,
    )} environments</span></span></summary><div class="env-subrows">${envs.map(
      (env) => renderEnvironment(group, site, env, title, view),
    )}</div></details>`;
  }

  const only = envs[0];
  return html`<div class="site-row"${ds.hostingSiteKey(group.profile, site.id)}${ds.novamiraState(
    state,
  )}><span class="site-name">${title}</span><span class="site-domain">${domain}</span><span class="site-state">${
    only === undefined ? false : renderStateCell(group, site, only, title, view)
  }</span><details class="profile-menu"><summary class="button tiny quiet"${attr("aria-label", `More actions for ${title}`)}>⋯</summary><div class="profile-menu-popover">${visibility}</div></details></div>`;
}

/** Go's `renderEnvironment` (`views.go:1006-1029`). */
function renderEnvironment(
  group: SiteGroup,
  site: HostingSite,
  env: HostingEnvironment,
  siteLabel: string,
  view: SitesResultView,
): Html {
  const name = displayLabel(env.displayName, env.name, env.id);
  const pushFromHere =
    ENVIRONMENT_PUSH_PROVIDERS.has(group.provider) &&
    (site.environments?.length ?? 0) > 1
      ? html`<a class="profile-menu-action"${hrefAttr(
          url("/push/new", {
            profile: group.profile,
            site: site.id,
            source: env.id,
          }),
        )}>Configure push…</a>`
      : false;
  return html`<div class="env-subrow"><span class="env-name">${name}${
    env.isPremium ? html` <span class="env-tag">Premium</span>` : false
  }</span><span class="site-domain">${
    env.primaryDomain ?? ""
  }</span><span class="site-state">${
    env.isBlocked ? html`<span class="pill warn">blocked</span>` : false
  }${renderStateCell(
    group,
    site,
    env,
    siteLabel,
    view,
  )}<details class="profile-menu"><summary class="button tiny quiet"${attr("aria-label", `More actions for ${siteLabel}: ${name}`)}>⋯</summary><div class="profile-menu-popover">${pushFromHere}<button class="button tiny quiet profile-menu-action hosting-visibility" type="button" title="Hide this site and all its environments from this browser's list">Hide from list</button></div></details></span></div>`;
}

/* -------------------------------------------------------------------------- */
/* One environment's connection state                                         */
/* -------------------------------------------------------------------------- */

/**
 * The replacement for Go's `renderSetupButton` (`views.go:1031-1049`).
 *
 * Go asked "is there a `site_profiles` entry whose URL matches this hostname?"
 * and rendered a green pill or a setup link. HQ asks the site CLI, gets one of
 * four states back, and renders the pill plus the actions that state admits:
 *
 * - `connected` — `pill ok` "Connected", and nothing to do.
 * - `reconnect_required` — one yellow Reconnect action on the matched profile;
 *   a warning pill labelled "Reconnect" only when the integration returned no
 *   profile to act on.
 * - `not_configured` — `pill` "Not connected", Connect, then the Setup CTA.
 * - `unavailable` — `pill` "Unknown" titled with the hint, Connect **disabled**
 *   with the same title, and the Setup CTA, which does not depend on knowing
 *   the connection state.
 *
 * The Setup CTA is deliberately absent from the two connected states: an
 * environment that already answers is not one you install a plugin onto, and
 * Go's "Fix set up" affordance existed only to replace a saved site profile.
 */
function renderStateCell(
  group: SiteGroup,
  site: HostingSite,
  env: HostingEnvironment,
  siteLabel: string,
  view: SitesResultView,
): Html {
  const result = connectionFor(
    view.connections,
    connectionKey(group.profile, site.id, env.id),
  );
  // `connections` is null only when the whole listing had no environment, so
  // this branch is unreachable while a cell is being rendered. The conservative
  // value keeps a future caller from claiming "Not connected" without asking.
  const connection = connectionView(
    result,
    view.connections?.cliAvailable ?? false,
  );
  const address = siteAddress(env, site);

  switch (connection.state) {
    case "connected":
      return html`<span class="pill ok">Novamira authorized</span>${renderProfileLink(
        connection,
        view,
      )}`;
    case "reconnect_required": {
      const profiles = renderProfileLink(connection, view);
      return profiles === false
        ? html`<span class="pill warn">Reconnect</span>`
        : profiles;
    }
    case "not_configured":
      return html`${renderConnectButton(
        connection,
        address,
        view,
        group,
        env,
        siteLabel,
      )}`;
    case "unavailable":
      return html`<span class="pill"${titleAttr(
        connection.hint,
      )}>${connection.reason === "site_incompatible" ? "Novamira not ready" : "Unknown"}</span>${renderProfileLink(connection, view)}${
        connection.profiles.length === 0
          ? renderConnectButton(
              connection,
              address,
              view,
              group,
              env,
              siteLabel,
            )
          : false
      }`;
  }
}

/** `title="…"` when there is a sentence, and no attribute when there is not. */
function titleAttr(text: string | undefined) {
  return text === undefined || text === "" ? false : attr("title", text);
}

/**
 * The site-CLI profile behind this environment's state, linked to the page that
 * manages it.
 *
 * `ConnectionResult.profiles` has carried these names since 6a and no view has
 * ever rendered one: the cell said "Connected" without saying *what* was
 * connected, which left an operator with two site listings and no visible
 * relation between them. The names come from the integration's origin match —
 * the environment's `primaryDomain` normalized against the site CLI's own
 * `origin` — so this is the answer the pill was already computed from, not a
 * second guess at it.
 *
 * It renders whenever the list is non-empty, which in practice is `connected`
 * and `reconnect_required`; `not_configured` has none by definition, and an
 * `unavailable` result usually has none either. More than one profile can match
 * one environment — two `novamira auth login`s against the same URL under
 * different names — and all of them are named, because hiding the second would
 * make "Connected" look like it came from the first.
 */
function renderProfileLink(
  connection: ConnectionView,
  view: SitesResultView,
): Html | false {
  if (connection.profiles.length === 0) return false;
  return html`${connection.profiles.map((name) => {
    const profile = view.siteProfiles?.profiles.find(
      (candidate) => candidate.name === name,
    );
    return profile === undefined
      ? html`<span class="push-hint">${name}</span>`
      : renderSiteProfileActions(siteProfileRowView(profile), {
          profile: view.profile,
          includeEnvs: view.includeEnvs,
        });
  })}`;
}

/**
 * The Connect button.
 *
 * The `title` is the literal `novamira auth login <url>` command — the copyable
 * fallback for when the button cannot help. It is disabled in two cases and only
 * two: the environment has no public address to log in against, or the state is
 * `unavailable`, which is also what a missing site CLI produces.
 */
function renderConnectButton(
  connection: ConnectionView,
  address: string,
  view: SitesResultView,
  group: SiteGroup,
  env: HostingEnvironment,
  siteLabel: string,
): Html {
  if (address === "") {
    return html`<button class="button tiny" type="button"${flagAttr(
      "disabled",
    )}${attr("title", NO_DOMAIN_TITLE)}>Connect to Novamira</button>`;
  }
  if (
    connection.state === "unavailable" &&
    !NOVAMIRA_SETUP_PROVIDERS.has(group.provider)
  ) {
    return html`<button class="button tiny" type="button"${flagAttr(
      "disabled",
    )}${titleAttr(connection.hint)}>Connect to Novamira</button>`;
  }
  const action = post(
    url("/_dashboard/connect", {
      url: address,
      profile: view.profile,
      include_envs: view.includeEnvs,
      hosting_profile: NOVAMIRA_SETUP_PROVIDERS.has(group.provider)
        ? group.profile
        : undefined,
      env: NOVAMIRA_SETUP_PROVIDERS.has(group.provider) ? env.id : undefined,
      site: siteLabel,
      envname: env.displayName || env.name,
    }),
    { include: [] },
  );
  return html`<button class="button tiny" type="button"${attr(
    "title",
    `Check Novamira, then authorize access in your browser. novamira auth login ${address}`,
  )}${ds.indicator("cliSites.loading")}${ds.attrs({ disabled: signal("cliSites.loading") })}${ds.on("click", action)}>Connect to Novamira</button>`;
}

/**
 * The environment's public address, most specific first.
 *
 * A provider may report a bare hostname or a full URL; `https://` is prepended
 * to the former, which is the one convenience `normalizeSiteUrl` also allows.
 * The handler normalizes the value properly before it reaches an argv array —
 * this is only what the button shows and what it sends.
 */
function siteAddress(env: HostingEnvironment, site: HostingSite): string {
  const raw = (env.primaryDomain ?? site.primaryDomain ?? "").trim();
  if (raw === "") return "";
  return raw.includes("://") ? raw : `https://${raw}`;
}

/**
 * `data-nm-state`, the value `sites-filter.js` buckets rows by.
 *
 * `installed` requires at least one environment and *every* environment
 * `connected`; anything else — including a site with no environments — is
 * `install`. That is Go's rule (`novamiraRowState`, `views.go:1090-1100`) with
 * its `site_profiles` lookup replaced by the site CLI's answer.
 */
function novamiraRowState(
  group: SiteGroup,
  site: HostingSite,
  view: SitesResultView,
): "installed" | "install" {
  const envs = site.environments ?? [];
  if (envs.length === 0) return "install";
  for (const env of envs) {
    const connection = connectionView(
      connectionFor(
        view.connections,
        connectionKey(group.profile, site.id, env.id),
      ),
      view.connections?.cliAvailable ?? false,
    );
    if (connection.state !== "connected") return "install";
  }
  return "installed";
}
