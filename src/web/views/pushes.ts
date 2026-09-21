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
  equal,
  jsBoolean,
  jsString,
  not,
  post,
  seq,
  set,
  signal,
  suggestPushName,
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
    return `Push is not currently available in Novamira HQ for these hosting accounts: ${profiles
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
  const profiles = new Set(view.profiles.map((profile) => profile.name));
  const visibleJobs = jobs.filter((job) =>
    profiles.has(job.confirmation.profile),
  );
  return html`<section class="page"><header class="page-head"><div><h1>Push</h1><p>Copy content between environments.</p></div></header>${view.pushes.length ? html`<div class="push-card-list">${view.pushes.map((push) => renderPushCard(push))}</div>` : false}${renderAvailableDirections(view, warm)}${renderPushJobs(visibleJobs)}</section>`;
}

function renderAvailableDirections(
  view: ConfigView,
  warm: WarmSitesView,
): Html {
  const capable = view.profiles.filter((profile) =>
    environmentPushSupported(profile.provider),
  );
  const incomplete =
    warm.cacheWarm &&
    capable.some((profile) => {
      const group = warm.groups.find((group) => group.profile === profile.name);
      return (
        !group ||
        Boolean(group.error) ||
        group.stale === true ||
        group.sites.some((site) => site.environments === undefined)
      );
    });
  const directions = warm.cacheWarm
    ? warm.groups.flatMap((group) =>
        capable.some((profile) => profile.name === group.profile) &&
        !group.error &&
        !group.stale
          ? group.sites.flatMap((site) =>
              (site.environments ?? []).flatMap((source) =>
                (site.environments ?? [])
                  .filter((target) => target.id !== source.id)
                  .map((target) => ({
                    profile: group.profile,
                    siteId: site.id,
                    siteLabel: displayLabel(
                      site.displayName,
                      site.name,
                      site.id,
                    ),
                    source,
                    target,
                  })),
              ),
            )
          : [],
      )
    : [];
  const available = directions.filter(
    (direction) =>
      !view.pushes.some(
        (push) =>
          push.hostingProfile === direction.profile &&
          push.siteId === direction.siteId &&
          push.sourceEnvId === direction.source.id &&
          push.targetEnvId === direction.target.id,
      ),
  );
  const loadNotice =
    !warm.cacheWarm || incomplete
      ? html`<a class="button secondary"${hrefAttr(url("/sites"))}>Open Sites</a>`
      : false;
  if (available.length) {
    return html`<section class="panel"><div class="panel-head"><div><h2>New push</h2><p>Choose the source and destination. You will confirm before anything is copied.</p></div></div>${incomplete ? html`<div class="empty">${loadNotice}</div>` : false}<div class="compact-list">${available.map((direction) => html`<article><div><strong>${direction.siteLabel} · ${displayLabel(direction.source.displayName, direction.source.name, direction.source.id)} → ${displayLabel(direction.target.displayName, direction.target.name, direction.target.id)}</strong><small>${direction.profile} · From: ${direction.source.primaryDomain ?? "URL unavailable"} → To: ${direction.target.primaryDomain ?? "URL unavailable"}</small></div><a class="button secondary"${hrefAttr(url("/push/new", { profile: direction.profile, site: direction.siteId, source: direction.source.id, target: direction.target.id }))}>Set up a push</a></article>`)}</div></section>`;
  }
  let title: string;
  let message: string;
  let action: Html | false = false;
  if (!view.profiles.length) {
    title = "Connect a hosting account";
    message = pushesStatusLine(view.profiles, warm);
    action = html`<a class="button primary"${hrefAttr(url("/hosting-accounts"))}>Connect a hosting provider</a>`;
  } else if (!capable.length) {
    title = "Push is not available";
    message = pushesStatusLine(view.profiles, warm);
    action = html`<a class="button secondary"${hrefAttr(url("/hosting-accounts"))}>Review hosting accounts</a>`;
  } else if (!warm.cacheWarm || incomplete) {
    title = warm.cacheWarm ? "Sites need refreshing" : "Load sites to continue";
    message =
      "Load your sites to choose where to copy content. Previous pushes remain below.";
    action = loadNotice;
  } else if (directions.length) {
    title = "All directions are already configured";
    message =
      "Every direction in the current hosting inventory, including reverse directions, has a saved setup. Use the saved pushes above to review and run them.";
  } else {
    title = "At least two environments are needed";
    message = pushesStatusLine(view.profiles, warm);
    action = html`<p>Add another environment with your hosting provider, then refresh Sites and return here.</p><a class="button secondary"${hrefAttr(url("/sites"))}>Open Sites</a>`;
  }
  return html`<section class="empty empty-block"><h2>${title}</h2><p>${message}</p>${action}</section>`;
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
  "Push is not available in Novamira HQ for this hosting account";

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

  const suggestName = suggestPushName(
    view.envs.map((env) => ({
      id: env.id,
      name: displayLabel(env.displayName, env.name, env.id),
    })),
  );
  const initialDirection =
    view.sourceEnvId === ""
      ? ds.init(suggestName)
      : ds.init(
          seq(
            set("pushForm.sourceEnvId", jsString(view.sourceEnvId)),
            set("pushForm.targetEnvId", jsString(view.targetEnvId)),
            suggestName,
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
  )} placeholder="staging-to-live" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" maxlength="64" autocomplete="off" required><small class="field-help">Suggested from the selected environments. Change it if you prefer a custom name.</small></label></div><div class="button-row"><button class="button primary" type="submit">Save push</button><a class="button secondary"${hrefAttr(
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
  const suggestion = suggestPushName(
    envs.map((env) => ({
      id: env.id,
      name: displayLabel(env.displayName, env.name, env.id),
    })),
  );
  return html`<label><span>${label}</span><select${ds.bind(
    path,
  )}${ds.on("change", path === "pushForm.sourceEnvId" ? seq(set("pushForm.targetEnvId", jsString("")), suggestion) : suggestion)} required><option value="" disabled>${placeholder}</option>${envs.map(
    (env) => {
      const name = displayLabel(env.displayName, env.name, env.id);
      const optionLabel =
        env.primaryDomain === undefined || env.primaryDomain === name
          ? name
          : `${name} — ${env.primaryDomain}`;
      return html`<option${attr("value", env.id)}${path === "pushForm.targetEnvId" ? ds.attrs({ disabled: equal(signal("pushForm.sourceEnvId"), jsString(env.id)) }) : false}>${optionLabel}</option>`;
    },
  )}</select></label>`;
}
