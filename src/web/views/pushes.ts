// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two push pages: the list at `/push` and the form at `/push/new`.
 *
 * **What the Go did.** `pushesStatusLine` (`views.go:737-773`) worked out
 * *why* an operator cannot create a push yet and said so in one sentence;
 * `renderPushesPage` (`:775-823`) and `renderPushNewPage`
 * (`:825-862`) built the markup with a `strings.Builder` and gomponents
 * respectively.
 *
 * **The status line is ported word for word**, because it is the most useful
 * thing on an empty page: it distinguishes "you have no hosting provider" from
 * "none of your providers can push" from "your providers can push but no site
 * has two environments" from "we have not looked yet". Only its capability
 * source changed: Go's `deploySupported` `switch` becomes
 * `ENVIRONMENT_PUSH_PROVIDERS`, which lives beside the provider clients and is
 * asserted against them by a contract test, so a new provider cannot drift it.
 *
 * **Neither page may trigger a provider call.** Both read the **warm** sites
 * cache and nothing else — Go did the same (`server.go:782`, `:931`) — because a
 * page render that fanned out across every hosting API would make navigating to
 * `/push` cost an operator their rate limit. A cold cache is not an
 * error: the status line has a sentence for exactly that state, and the new-path
 * form falls back to the "open this from the Sites page" guidance.
 *
 * **Two Go behaviours are deliberately not ported.**
 *
 * 1. `views.go:821` closed one `</section>` too many, so the populated list page
 *    emitted unbalanced markup. The structure here is balanced.
 * 2. Go rendered `renderProviderFlash(notice, "")` at the top of the list page,
 *    which put a second element carrying `id="provider-flash"` — the *providers*
 *    page's patch target — into a document that is not the providers page. An id
 *    is a selector, and a catalogued selector that can name two different things
 *    is exactly the drift `patches.ts` exists to prevent. Page notices are
 *    rendered once, by the shared toast.
 *
 * **The Push button is disabled on purpose, with two different reasons.**
 * Execution is a later phase, so a supported row says so; an unsupported row
 * says the provider cannot push at all. Go had both sentences and they are kept
 * verbatim — a single "coming soon" title would have hidden a permanent
 * limitation behind a temporary one.
 */

import type { HostingEnvironment } from "../../hosting/types.js";
import * as ds from "../datastar.js";
import {
  confirmThen,
  jsBoolean,
  jsString,
  not,
  post,
  seq,
  set,
  signal,
} from "../expr.js";
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
import { displayLabel, type SiteGroup } from "../services/sites.js";
import {
  environmentPushSupported,
  providerLabelFor,
  type ConfigView,
  type DashboardNotice,
  type PushView,
  type HostingProfileView,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* The warm-cache slice both pages read                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the warm `__all__` inventory contributes to these pages.
 *
 * `cacheWarm: false` means "nobody has opened the Sites page in this process
 * yet", which is a *different* statement from "there are no groups" and is the
 * distinction Go's `pushesStatusLine` third argument carried.
 */
export interface WarmSitesView {
  readonly groups: readonly SiteGroup[];
  readonly cacheWarm: boolean;
}

const COLD: WarmSitesView = Object.freeze({
  groups: Object.freeze([]),
  cacheWarm: false,
});

/* -------------------------------------------------------------------------- */
/* The status line                                                            */
/* -------------------------------------------------------------------------- */

function named(profile: HostingProfileView): string {
  return `${profile.name} (${providerLabelFor(profile.provider)})`;
}

/**
 * Go's `pushesStatusLine` (`views.go:737-773`), sentence for sentence.
 *
 * It returns plain text; the caller interpolates it into an `html` template,
 * which escapes it. Nothing in it is derived from an error or a provider
 * response — only from profile names, provider labels and a count.
 */
export function pushesStatusLine(
  profiles: readonly HostingProfileView[],
  warm: WarmSitesView,
): string {
  if (profiles.length === 0) {
    return "You haven't connected a hosting account yet — add one on the Hosting accounts page.";
  }
  const capable = profiles
    .filter((profile) => environmentPushSupported(profile.provider))
    .map(named);
  if (capable.length === 0) {
    return `None of your connected hosts support environment push: ${profiles
      .map(named)
      .join(", ")}.`;
  }
  if (warm.cacheWarm) {
    let eligible = 0;
    for (const group of warm.groups) {
      if (!environmentPushSupported(group.provider)) continue;
      for (const site of group.sites) {
        if ((site.environments ?? []).length > 1) eligible += 1;
      }
    }
    if (eligible > 0) {
      return `Choose one of the ${String(eligible)} available site(s) below to configure a push.`;
    }
    return `Your push-capable host(s) ${capable.join(", ")} have no site with more than one environment yet, so there's nothing to push between.`;
  }
  return `You have a push-capable host: ${capable.join(", ")}. Open Sites to find a site with more than one environment.`;
}

/* -------------------------------------------------------------------------- */
/* /push                                                                */
/* -------------------------------------------------------------------------- */

import { renderPushJobs } from "./push-job.js";
import type { PushJob } from "../services/push-execution.js";

export function renderPushesPage(
  view: ConfigView,
  _notice: DashboardNotice,
  warm: WarmSitesView = COLD,
  jobs: readonly PushJob[] = [],
): Html {
  if (view.pushes.length === 0) {
    const eligibleSites = warm.groups.flatMap((group) =>
      environmentPushSupported(group.provider)
        ? group.sites.flatMap((site) => {
            const environments = site.environments ?? [];
            return environments.length > 1
              ? [
                  {
                    profile: group.profile,
                    provider: providerLabelFor(group.provider),
                    siteId: site.id,
                    label: displayLabel(site.displayName, site.name, site.id),
                    domain: site.primaryDomain ?? "",
                    environmentCount: environments.length,
                  },
                ]
              : [];
          })
        : [],
    );
    if (eligibleSites.length > 0) {
      return html`<section class="page"><header class="page-head"><div><h1>Push</h1><p>Reusable push configurations between environments.</p></div></header>${renderPushJobs(jobs)}<section class="panel"><div class="panel-head"><div><h2>Choose a site</h2><p>Select the site whose environments you want to push between.</p></div></div><div class="compact-list">${eligibleSites.map(
        (site) =>
          html`<article><div><strong>${site.label}</strong><small>${
            site.domain === "" ? false : `${site.domain} · `
          }${site.profile} (${site.provider}) · ${String(
            site.environmentCount,
          )} environments</small></div><a class="button primary"${hrefAttr(
            url("/push/new", {
              profile: site.profile,
              site: site.siteId,
            }),
          )}>Set up a push</a></article>`,
      )}</div></section></section>`;
    }
    const hasHostingProvider = view.profiles.length > 0;
    const needsSiteLoad =
      !warm.cacheWarm &&
      view.profiles.some((profile) =>
        environmentPushSupported(profile.provider),
      );
    return html`<section class="page"><header class="page-head"><div><h1>Push</h1><p>Reusable push configurations between environments.</p></div></header>${renderPushJobs(jobs)}<div class="empty empty-block"><h2>${
      needsSiteLoad ? "Load sites to continue" : "No sites available for push"
    }</h2><p>${pushesStatusLine(
      view.profiles,
      warm,
    )}</p><a class="button primary"${hrefAttr(
      url(hasHostingProvider ? "/sites" : "/providers"),
    )}>${
      hasHostingProvider
        ? needsSiteLoad
          ? "Load hosting sites"
          : "Review hosting sites"
        : "Connect a hosting provider"
    }</a></div></section>`;
  }
  return html`<section class="page"><header class="page-head"><div><h1>Push</h1><p>Reusable push configurations between environments. Nothing runs until you review and confirm it.</p></div><a class="button secondary"${hrefAttr(
    url("/sites"),
  )}>Set up a push</a></header>${renderPushJobs(jobs)}<div class="push-card-list">${view.pushes.map(
    (push) => renderPushCard(push),
  )}</div></section>`;
}

/** Go's `pushScopeSummary` (`views.go:864-879`). */
export function pushScopeSummary(push: PushView): string {
  const parts: string[] = [];
  if (push.pushDb) parts.push("DB");
  if (push.pushFiles) parts.push("files");
  if (push.searchReplace) parts.push("search-replace");
  return parts.length === 0 ? "—" : parts.join(", ");
}

const PUSH_UNSUPPORTED_TITLE =
  "This provider does not support environment push";

function endpoint(
  name: string,
  id: string,
  domain: string,
  label: "From" | "To",
): Html {
  const displayName =
    name === id
      ? label === "From"
        ? "Source environment"
        : "Target environment"
      : name;
  const displayUrl =
    domain === ""
      ? "URL unavailable — review hosting sites"
      : /^https?:\/\//i.test(domain)
        ? domain
        : `https://${domain}`;
  return html`<div class="push-endpoint"><span>${label}</span><strong>${displayUrl}</strong><small>${displayName}</small></div>`;
}

function renderPushCard(push: PushView): Html {
  const scopes = [
    push.pushDb ? "Database" : false,
    push.pushFiles ? "Files" : false,
    push.searchReplace ? "Search-replace" : false,
  ].filter((scope): scope is string => scope !== false);
  return html`<article class="push-card"><header><div><span class="eyebrow">${push.siteLabel}</span><h2>${push.name}</h2></div><div class="push-scopes">${
    scopes.length
      ? scopes.map((scope) => html`<span class="pill">${scope}</span>`)
      : html`<span class="pill warn">No content selected</span>`
  }</div></header><div class="push-route">${endpoint(
    push.sourceEnvName,
    push.sourceEnvId,
    push.sourceEnvDomain,
    "From",
  )}<span class="push-route-arrow">→</span>${endpoint(
    push.targetEnvName,
    push.targetEnvId,
    push.targetEnvDomain,
    "To",
  )}</div><footer><button class="button primary" type="button"${push.supported ? false : flagAttr("disabled")}${ds.on("click", post(url("/_dashboard/pushes/plan", { push: push.name }), { include: [] }))}${attr(
    "title",
    push.supported
      ? "Review the target and scope before pushing"
      : PUSH_UNSUPPORTED_TITLE,
  )}>Review and run</button><button class="button link" type="button"${ds.on(
    "click",
    confirmThen(
      `Remove push ${push.name}?`,
      post(url("/_dashboard/pushes/remove", { push: push.name }), {
        include: [],
      }),
    ),
  )}>Remove setup</button></footer></article>`;
}

/* -------------------------------------------------------------------------- */
/* /push/new                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Go's `pushNewView` (`server.go:920-957`).
 *
 * `siteLabel` falls back to the raw site id, exactly as Go's did, so the page
 * still names the target when the cache is cold. `envs` empty is the honest
 * "we could not resolve this site from the warm inventory", and the page then
 * renders the guidance instead of a form that could not be filled in.
 */
export interface PushNewView {
  readonly profile: string;
  readonly siteId: string;
  readonly siteLabel: string;
  readonly envs: readonly HostingEnvironment[];
  readonly sourceEnvId: string;
  readonly targetEnvId: string;
}

const EMPTY_PUSH_NEW: PushNewView = Object.freeze({
  profile: "",
  siteId: "",
  siteLabel: "",
  envs: Object.freeze([]),
  sourceEnvId: "",
  targetEnvId: "",
});

export function renderPushNewPage(view: PushNewView = EMPTY_PUSH_NEW): Html {
  const head = html`<header class="page-head"><div><h1>Set up a push</h1>${
    view.siteLabel === ""
      ? false
      : html`<p class="lede">Choose what moves between two environments of ${view.siteLabel}.</p>`
  }</div><a class="button secondary"${hrefAttr(
    url("/push"),
  )}>Back to Push</a></header>`;

  if (view.envs.length < 2) {
    return html`<section class="page">${head}<div class="empty empty-block"><p>Open this from Sites, expand a site with more than one environment, then choose “Configure push…” beside the source environment.</p><a class="button primary"${hrefAttr(
      url("/sites"),
    )}>Open Sites</a></div></section>`;
  }

  // Go's `pushFormInit` (`views.go:1143-1147`) followed by the `@post`. The
  // three assignments run on submit rather than on load so a re-patched page
  // cannot leave the form pointing at the previous site.
  const submit = seq(
    set("pushForm.hostingProfile", jsString(view.profile)),
    set("pushForm.siteId", jsString(view.siteId)),
    set("pushForm.siteLabel", jsString(view.siteLabel)),
    post(url("/_dashboard/pushes/save"), { include: ["pushForm"] }),
  );

  const initialDirection =
    view.sourceEnvId === ""
      ? false
      : ds.init(
          seq(
            set("pushForm.sourceEnvId", jsString(view.sourceEnvId)),
            set("pushForm.targetEnvId", jsString(view.targetEnvId)),
          ),
        );

  return html`<section class="page">${head}<form${classAttr(
    "panel",
    "form-panel",
    "push-form",
  )}${initialDirection}${ds.onSubmit(
    submit,
  )}><div class="panel-head"><div><h2>Direction</h2><p>Select exactly where the content comes from and where it goes.</p></div></div><div class="form-grid push-direction">${renderEnvSelect(
    "From",
    "pushForm.sourceEnvId",
    view.envs,
  )}${renderEnvSelect(
    "To",
    "pushForm.targetEnvId",
    view.envs,
  )}</div><fieldset class="push-scope"><legend>Content to push</legend><p class="field-help">Choose at least one. The selected content can overwrite the target environment when this push is run.</p><div class="push-scope-options"><label><input type="checkbox"${ds.bind(
    "pushForm.pushDb",
  )}${ds.on(
    "change",
    set("pushForm.searchReplace", jsBoolean(false)),
  )}><span><strong>Database</strong><small>Push the source database to the target.</small></span></label><label><input type="checkbox"${ds.bind(
    "pushForm.pushFiles",
  )}><span><strong>All files</strong><small>Push all source files to the target.</small></span></label><label><input type="checkbox"${ds.bind(
    "pushForm.searchReplace",
  )}${ds.attrs({
    disabled: not(signal("pushForm.pushDb")),
  })}><span><strong>Search and replace URLs</strong><small>Available when Database is selected.</small></span></label></div></fieldset><div class="form-grid push-name"><label><span>Saved push name</span><input${idAttr(
    "push-name",
  )} type="text"${ds.bind(
    "pushForm.name",
  )} placeholder="staging-to-live" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" maxlength="64" autocomplete="off" required><small class="field-help">Use this name to find and run the push later. Letters, numbers, dots, dashes, and underscores only.</small></label></div><div class="button-row"><button class="button primary" type="submit">Save push</button><a class="button secondary"${hrefAttr(
    url("/push"),
  )}>Cancel</a></div></form></section>`;
}

/** Go's `envSelect` (`views.go:1149-1166`). */
function renderEnvSelect(
  label: string,
  path: "pushForm.sourceEnvId" | "pushForm.targetEnvId",
  envs: readonly HostingEnvironment[],
): Html {
  const placeholder =
    path === "pushForm.sourceEnvId"
      ? "Choose source environment"
      : "Choose target environment";
  return html`<label><span>${label}</span><select${ds.bind(
    path,
  )} required><option value="" disabled>${placeholder}</option>${envs.map(
    (env) => {
      const name = displayLabel(env.displayName, env.name, env.id);
      const optionLabel =
        env.primaryDomain === undefined || env.primaryDomain === name
          ? name
          : `${name} — ${env.primaryDomain}`;
      return html`<option${attr("value", env.id)}>${optionLabel}</option>`;
    },
  )}</select></label>`;
}
