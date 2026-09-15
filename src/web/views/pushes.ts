// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two push pages: the list at `/pushes` and the form at
 * `/pushes/new`.
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
 * `/pushes` cost an operator their rate limit. A cold cache is not an
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
 *    is exactly the drift `patches.ts` exists to prevent. The inline notice here
 *    is a plain `renderNotice`, which is what `layout.ts:169` reserves it for.
 *
 * **The Push button is disabled on purpose, with two different reasons.**
 * Execution is a later phase, so a supported row says so; an unsupported row
 * says the provider cannot push at all. Go had both sentences and they are kept
 * verbatim — a single "coming soon" title would have hidden a permanent
 * limitation behind a temporary one.
 */

import type { HostingEnvironment } from "../../hosting/types.js";
import * as ds from "../datastar.js";
import { confirmThen, jsString, post, seq, set } from "../expr.js";
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
import { renderNotice } from "./layout.js";
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
    return "You haven't connected a hosting provider yet — add one on the Hosting Providers page.";
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
      return `You're ready — open the Hosting Sites page and expand one of your ${String(eligible)} site(s) with more than one environment, then use Add push.`;
    }
    return `Your push-capable host(s) ${capable.join(", ")} have no site with more than one environment yet, so there's nothing to push between.`;
  }
  return `You have a push-capable host: ${capable.join(", ")}. Open the Hosting Sites page to find a site with more than one environment.`;
}

/* -------------------------------------------------------------------------- */
/* /pushes                                                              */
/* -------------------------------------------------------------------------- */

export function renderPushesPage(
  view: ConfigView,
  notice: DashboardNotice,
  warm: WarmSitesView = COLD,
): Html {
  const flash = notice.message === "" ? false : renderNotice(notice);
  if (view.pushes.length === 0) {
    const hasHostingProvider = view.profiles.length > 0;
    return html`<section class="page"><header class="page-head"><div><h1>Push</h1></div></header>${flash}<div class="empty empty-block"><p>Push changes between two environments of the same site — for example staging → live. This requires a host that supports environment push and a site with more than one environment.</p><p>${pushesStatusLine(
      view.profiles,
      warm,
    )}</p><a class="button primary"${hrefAttr(
      url(hasHostingProvider ? "/sites" : "/providers"),
    )}>Open the ${
      hasHostingProvider ? "Hosting Sites" : "Hosting Providers"
    } page</a></div></section>`;
  }
  return html`<section class="page"><header class="page-head"><div><h1>Push</h1></div></header>${flash}<section class="panel"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Site</th><th>Direction</th><th>Pushes</th><th></th></tr></thead><tbody>${view.pushes.map(
    (push) => renderPushRow(push),
  )}</tbody></table></div></section></section>`;
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

function renderPushRow(push: PushView): Html {
  const domains =
    push.sourceEnvDomain === "" && push.targetEnvDomain === ""
      ? false
      : html`<span class="push-dir-domains">${push.sourceEnvDomain} → ${push.targetEnvDomain}</span>`;
  return html`<tr><td><strong>${push.name}</strong></td><td>${
    push.siteLabel
  }</td><td><div class="push-dir"><span class="push-dir-names">${
    push.sourceEnvName
  } → ${push.targetEnvName}</span>${domains}</div></td><td>${pushScopeSummary(
    push,
  )}</td><td class="actions"><button class="button link" type="button"${push.supported ? false : flagAttr("disabled")}${ds.on("click", post(url("/_dashboard/pushes/plan", { push: push.name }), { include: [] }))}${attr(
    "title",
    push.supported
      ? "Review the target and scope before pushing"
      : PUSH_UNSUPPORTED_TITLE,
  )}>Push</button><button class="button link" type="button"${ds.on(
    "click",
    confirmThen(
      `Remove push ${push.name}?`,
      post(url("/_dashboard/pushes/remove", { push: push.name }), {
        include: [],
      }),
    ),
  )}>Remove</button></td></tr>`;
}

/* -------------------------------------------------------------------------- */
/* /pushes/new                                                          */
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
}

const EMPTY_PUSH_NEW: PushNewView = Object.freeze({
  profile: "",
  siteId: "",
  siteLabel: "",
  envs: Object.freeze([]),
});

export function renderPushNewPage(view: PushNewView = EMPTY_PUSH_NEW): Html {
  const head = html`<header class="page-head"><div><h1>New push</h1>${
    view.siteLabel === ""
      ? false
      : html`<p class="lede">Push changes between two environments of ${view.siteLabel}.</p>`
  }</div><a class="button secondary"${hrefAttr(
    url("/sites"),
  )}>Back to Sites</a></header>`;

  if (view.envs.length < 2) {
    return html`<section class="page">${head}<div class="empty empty-block"><p>Open this from the Hosting Sites page: expand a site with more than one environment and use “+ Push”.</p><a class="button primary"${hrefAttr(
      url("/sites"),
    )}>Open the Hosting Sites page</a></div></section>`;
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

  return html`<section class="page">${head}<form${classAttr(
    "panel",
    "form-panel",
  )}${ds.onSubmit(
    submit,
  )}><div class="form-grid"><label><span>Push name</span><input${idAttr(
    "push-name",
  )} type="text"${ds.bind(
    "pushForm.name",
  )} placeholder="staging-to-live" required></label>${renderEnvSelect(
    "Source environment",
    "pushForm.sourceEnvId",
    view.envs,
  )}${renderEnvSelect(
    "Target environment",
    "pushForm.targetEnvId",
    view.envs,
  )}</div><div class="check-row"><label><input type="checkbox"${ds.bind(
    "pushForm.pushDb",
  )}> Database</label><label><input type="checkbox"${ds.bind(
    "pushForm.pushFiles",
  )}> Files</label><label><input type="checkbox"${ds.bind(
    "pushForm.searchReplace",
  )}> Search-replace</label></div><div class="button-row"><button class="button primary" type="submit">Save push</button><a class="button secondary"${hrefAttr(
    url("/sites"),
  )}>Cancel</a></div></form></section>`;
}

/** Go's `envSelect` (`views.go:1149-1166`). */
function renderEnvSelect(
  label: string,
  path: "pushForm.sourceEnvId" | "pushForm.targetEnvId",
  envs: readonly HostingEnvironment[],
): Html {
  return html`<label><span>${label}</span><select${ds.bind(path)}>${envs.map(
    (env) =>
      html`<option${attr("value", env.id)}>${displayLabel(
        env.displayName,
        env.name,
        env.id,
      )}</option>`,
  )}</select></label>`;
}
