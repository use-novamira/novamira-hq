// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The app shell: the document, the sidebar, the nav, the `#main` wrapper and the
 * `#toast`. Everything inside `#main` is 6b's.
 *
 * **What the Go did.** `renderDashboardDocument` (views.go:63-102) built the
 * document with gomponents and then welded four already-rendered strings into it
 * with `Raw(...)`: the sidebar, the main element, the toast. The structure is
 * ported here exactly, because it is load-bearing in three places that are easy
 * to break by tidying:
 *
 * - `data-signals` sits on `.shell` — not on `<body>`, not on `#main`. Both
 *   `#main` and `#nav` are outer-patched over SSE, and an outer patch replaces
 *   the element; a signal store on either would be destroyed by the first patch.
 * - `#toast` is a **sibling of `.shell`**, outside it, because every SSE handler
 *   patches it and it must therefore exist on every page regardless of what
 *   `#main` currently holds.
 * - `#nav` lives inside `<aside class="sidebar">`, and the aside itself carries
 *   no id and is never patched.
 *
 * **What HQ deletes.** Go's sidebar "New" menu had two entries, and the first —
 * `/sites?new=site`, "Single site / URL + application password" — opened the
 * site-profile form. Under the boundary rule that form does not exist, so the
 * menu has one entry and collapses to a plain link; the `newMenuOpen` nested
 * signal, its `data-on:click__outside` handler and the `.new-pop` popover go
 * with it. (If 6b gains a second entry it must rebuild the menu with
 * `ds.signals`/`ds.classes`, never with raw markup.) The `if
 * len(res.SiteProfiles) > 0` "Site profiles" count block is deleted for the same
 * reason.
 *
 * `?new=host` opens the provider form. `?new=site` — Go's other value — is
 * ignored silently: there is no site form to open, and refusing the query string
 * would only turn a stale bookmark into an error page.
 *
 * The one entry stays an `<a href>` rather than becoming Go's `<button>`: a
 * navigation is a link, and a link works without JavaScript. That change is not
 * free, though — Go's `<button>` was inline-block, so `.button`'s `min-height`
 * and `.new-button`'s `width: 100%` applied to it, and an anchor is inline. The
 * matching `display` was added to `.new-button` in `app.css`, and the element
 * type is pinned by the shell test so a later edit cannot quietly undo the pair.
 *
 * **The three script tags are external, always.** The CSP is
 * `script-src 'self' 'unsafe-eval'` with no `'unsafe-inline'`, so an inline
 * `<script>` would not run and a `style=` attribute with an interpolation would
 * not apply. `unsafe-eval` is there because Datastar evaluates its expressions,
 * and is the only reason.
 */

import * as ds from "../datastar.js";
import { classAttr, hrefAttr, html, idAttr, url, type Html } from "../html.js";
import { toSignalRecord, type DashboardSignals } from "../signals.js";
import {
  statusClass,
  type ConfigView,
  type DashboardNotice,
  type DashboardPage,
} from "./types.js";

export interface DocumentInput {
  readonly page: DashboardPage;
  readonly view: ConfigView;
  readonly signals: DashboardSignals;
  readonly notice: DashboardNotice;
  /** The page body, from `views/pages.ts`'s `renderPageBody`. */
  readonly body: Html;
}

/**
 * `<!doctype html>` through `</html>`.
 *
 * The `<head>` is Go's, link for link and script for script: the stylesheet,
 * Datastar as a module, and the two small scripts of ours that read
 * `data-checked-at` and filter the site list. Both are `defer`, and both
 * tolerate their target elements being absent, which is exactly the state 6a
 * leaves the document in.
 */
export function renderDocument(input: DocumentInput): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Novamira HQ</title>
<link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/datastar.js"></script>
<script src="/assets/relative-time.js" defer></script>
<script src="/assets/sites-filter.js" defer></script>
</head>
<body>
<div class="shell"${ds.signals(toSignalRecord(input.signals))}>${renderSidebar(input.view, input.page)}${renderMain(input.page, input.body)}</div>
${renderToast(input.notice)}
</body>
</html>
`;
}

/**
 * The sidebar: brand, the one "New" action, the nav, and the version pill.
 *
 * `view` is taken whole rather than as a version string so that 6b can put the
 * profile and deploy-path counts back without changing the signature.
 */
export function renderSidebar(view: ConfigView, page: DashboardPage): Html {
  return html`<aside class="sidebar"><a class="brand"${hrefAttr(url("/providers"))} aria-label="Novamira HQ dashboard home"><img class="brand-logo" src="/assets/novamira-hq-logo-white.svg" alt="Novamira HQ" width="170" height="25"></a><div class="new-menu"><a class="button primary new-button"${hrefAttr(url("/providers", { new: "host" }))}>+ New hosting</a></div>${renderNav(page)}<div class="sidebar-foot"><span class="version-pill">v${view.version}</span></div></aside>`;
}

/**
 * `#nav`, one of the three catalogued patch targets.
 *
 * `navLink` marks a link active for its own page **plus two aliases**, exactly
 * as Go's did: `novamira-setup` highlights Hosting Sites, and `deploy-path-new`
 * highlights Deploy paths. Five of the six links and their order are Go's; the
 * sixth, "Novamira CLI sites", sits directly under it because the two are the
 * same question asked of the hosting providers and of the site CLI, and because
 * it started life as a panel on that page.
 *
 * Go's first link was labelled "Sites", and it is "Hosting Sites" here: with a
 * second site listing beside it the bare word stopped saying which of the two it
 * meant. The **path** is still `/sites` — the label is what an operator reads,
 * and renaming the route would break every bookmark for a wording change.
 */
export function renderNav(page: DashboardPage): Html {
  return html`<nav${idAttr("nav")} class="nav" aria-label="Dashboard sections">${[
    navLink(page, "sites", "/sites", "Hosting Sites"),
    navLink(page, "site-profiles", "/site-profiles", "Novamira CLI sites"),
    navLink(page, "deploy-paths", "/deploy-paths", "Deploy paths"),
    navLink(page, "providers", "/providers", "Hosting Providers"),
    navLink(page, "diagnostics", "/diagnostics", "Diagnostics"),
    navLink(page, "settings", "/settings", "Settings"),
  ]}</nav>`;
}

function navLink(
  current: DashboardPage,
  page: DashboardPage,
  href: string,
  label: string,
): Html {
  const active =
    current === page ||
    (current === "novamira-setup" && page === "sites") ||
    (current === "deploy-path-new" && page === "deploy-paths");
  return html`<a${classAttr("nav-link", active && "active")}${hrefAttr(
    url(href),
  )}>${label}</a>`;
}

/**
 * `#main`, the second catalogued patch target and the element every page-level
 * SSE response replaces outer-mode.
 */
export function renderMain(page: DashboardPage, body: Html): Html {
  // The per-page class 6a promised. No stylesheet rule uses it — `app.css` is
  // frozen — and that is fine: it is a hook, and it makes an outer `#main` patch
  // self-describing, so a test can tell "the providers page was patched here"
  // from "some page was patched here" without parsing the body.
  return html`<main${idAttr("main")}${classAttr("main", `main-${page}`)}>${body}</main>`;
}

/**
 * `#toast`, the third catalogued patch target.
 *
 * An empty message renders the element with no `show` class, which is what
 * keeps it out of the way; the element itself is always present because every
 * SSE handler patches it unconditionally.
 */
export function renderToast(notice: DashboardNotice): Html {
  const shown = notice.message !== "";
  return html`<div${idAttr("toast")}${classAttr(
    "toast",
    shown && "show",
    shown && statusClass(notice.level),
  )} role="status" aria-live="polite">${notice.message}</div>`;
}

/**
 * An inline notice inside a page body: the provider flash, a form error, a
 * per-group failure on the sites page.
 *
 * It renders `CliError.message` and never `CliError.details`. `failureEnvelope`'s
 * `redact()` runs on the JSON path only, so a notice string built from `details`
 * would walk straight past it — which is why every handler builds its notice
 * from `asCliError(error).message` and routes the `code` to `onDiagnostic`.
 */
export function renderNotice(notice: DashboardNotice): Html {
  return html`<div${classAttr("notice", statusClass(notice.level))}>${notice.message}</div>`;
}
