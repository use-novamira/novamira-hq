// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Hosting Providers page: the onboarding state, the provider form, the
 * provider table and its rows, the connection cell, and `#provider-flash`.
 *
 * **What the Go did.** Thirteen functions across `views.go:199-569`, in three
 * different rendering styles welded together with `Raw(...)`:
 * `renderProvidersPage` and `renderOnboarding` used gomponents,
 * `renderProviderTable` and `renderProviderRow` wrote angle brackets into a
 * `strings.Builder` and had to call `renderAttrNode(data.Class(...))` to splice
 * a Datastar helper's output back into the raw text (views.go:392, 437, 441,
 * 447), and `editProviderExpression` concatenated eight `jsStringLiteral` calls
 * into one assignment sequence. Every escaping decision was a call-site
 * decision.
 *
 * **What HQ does instead.** One `html` template per fragment, `ds.*` for every
 * `data-` attribute, `url()` for every link, and the expression constructors for
 * every `data-on:*`. There is no `Raw`, no `strings.Builder` and no
 * `unsafeRawHtml` — conventions rule 6 asserts the last one by reading the
 * source tree.
 *
 * **What is deleted, not ported.**
 *
 * - The onboarding page's **first card**, "Connect a single site — URL +
 *   application password" (`views.go:242-250`), and `renderSiteForm`
 *   (`views.go:622-650`) with it. Under the boundary rule HQ never holds a
 *   WordPress credential, so that credential form is gone. The current URL
 *   path delegates authorization and storage to the site CLI instead.
 * - Every `SiteProfiles` reference (`views.go:177-183, 200, 242-250, 261`).
 * - The `#provider-form` **API base URL** field and the "Overwrite if it exists"
 *   checkbox — Go had neither, and `force` is set by Edit alone. Adding either
 *   would let an operator overwrite a profile by accident from a blank form.
 *
 * **Two deliberate fixes to Go's behaviour, both in expressions.**
 *
 * 1. `editProviderExpression` (views.go:540) ended with
 *    `document.querySelector('#provider-form input').focus()` — undeferred and
 *    unguarded, so clicking Edit while the form was not in the DOM threw and
 *    silently abandoned the rest of the assignment sequence. Here it is
 *    `focusElementById("profile")`, which is always deferred and always
 *    optional-chained.
 * 2. The per-row signals are `checking_<hex>` and `details_<hex>` rather than
 *    Go's `checking` + the profile name's alphanumerics, which mapped `a-b` and
 *    `ab` onto the same signal. See `signals.ts`'s `dynamicSignalPath`.
 *
 * **The secret never appears here.** The credential field is an `<input
 * type="password">` bound to `providerForm.credentialValue`, rendered empty on
 * every paint (Edit explicitly clears it, and the save handler's signal patch
 * resets it), and the details row renders `credentialSource(ref)` — `env:NAME`,
 * `file:PATH`, `stored:ID` — never a value. Nothing in this module can put one
 * in a URL: every link goes through `url()`, whose query is built with
 * `URLSearchParams`, and the only signal a `@post` here carries beyond `token`
 * is the form subtree, in the request body.
 */

import { randomInt } from "node:crypto";

import { PROVIDER_KINDS, type ProviderKind } from "../../config/schema.js";
import { providerLabel } from "../../hosting/types.js";
import * as ds from "../datastar.js";
import {
  confirmThen,
  focusElementById,
  jsBoolean,
  jsString,
  lookupOr,
  not,
  post,
  seq,
  set,
  signal,
  toggle,
  type Expr,
  type JsonValue,
} from "../expr.js";
import {
  attr,
  classAttr,
  hrefAttr,
  html,
  idAttr,
  url,
  type Html,
} from "../html.js";
import { connCellId } from "../patches.js";
import {
  connCheckingSignal,
  providerDetailsSignal,
  dynamicSignalPath,
} from "../signals.js";
import { renderNotice } from "./layout.js";
import {
  renderProviderActionsPage,
  type ProviderActionsView,
} from "./provider-actions.js";
import {
  providerLabelFor,
  type ConfigView,
  type DashboardNotice,
  type HostingProfileView,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* The provider metadata table                                                */
/* -------------------------------------------------------------------------- */

/**
 * Go's `providerMetaExpression` table (`views.go:326-381`), verbatim — eight
 * providers by four fields.
 *
 * It is serialized into four `data-text`/`data-attr` expressions and evaluated
 * in the browser, so the form's help text follows the provider `<select>` with
 * no round trip. The strings are Go's, character for character: they name real
 * console locations an operator has to navigate to, and rewording them would
 * make the instructions wrong.
 */
const PROVIDER_FORM_META: JsonValue = {
  kinsta: {
    companyLabel: "Kinsta company ID",
    companyPlaceholder: "Detected from API key",
    companyHelp:
      "Optional. Leave blank and Novamira can detect the company ID during validation.",
    credentialHelp:
      "Paste a Kinsta API key. Find it in MyKinsta → Company settings → API Keys.",
  },
  instawp: {
    companyLabel: "InstaWP team ID",
    companyPlaceholder: "First team returned by API",
    companyHelp:
      "Optional. Leave blank to use the first team returned by InstaWP.",
    credentialHelp:
      "Paste an InstaWP API key. Create one in app.instawp.io → Settings → API Tokens.",
  },
  pantheon: {
    companyLabel: "Pantheon user ID",
    companyPlaceholder: "Detected from machine token",
    companyHelp:
      "Optional. Leave blank and Novamira can detect the user ID from the machine token.",
    credentialHelp: "Paste a Pantheon machine token.",
  },
  pressable: {
    companyLabel: "Pressable client ID",
    companyPlaceholder: "OAuth client ID",
    companyHelp: "Use the OAuth client ID for this Pressable account.",
    credentialHelp: "Paste the Pressable client secret.",
  },
  wpengine: {
    companyLabel: "WP Engine API user ID",
    companyPlaceholder: "API user ID",
    companyHelp: "Use the API user ID for this WP Engine account.",
    credentialHelp: "Paste the WP Engine API password.",
  },
  rocketnet: {
    companyLabel: "Rocket.net username",
    companyPlaceholder: "user@example.com",
    companyHelp: "Use the Rocket.net username, usually the account email.",
    credentialHelp: "Paste the Rocket.net password.",
  },
  hostinger: {
    companyLabel: "Hostinger account username",
    companyPlaceholder: "Hosting account username",
    companyHelp:
      "Optional for site listing. Some account-scoped Hostinger operations need it.",
    credentialHelp: "Paste a Hostinger API token.",
  },
  cloudways: {
    companyLabel: "Cloudways account email",
    companyPlaceholder: "user@example.com",
    companyHelp: "Use the email address for this Cloudways account.",
    credentialHelp: "Paste a Cloudways API key.",
  },
};

/** What the four fields say for a provider the table does not describe. */
const PROVIDER_FORM_META_FALLBACK: Readonly<Record<string, string>> = {
  companyLabel: "Company or account ID",
  companyPlaceholder: "Optional",
  companyHelp: "Optional provider account identifier.",
  credentialHelp: "Paste the provider credential.",
};

const PROVIDER_LABEL_META: JsonValue = Object.fromEntries(
  PROVIDER_KINDS.map((kind) => [
    kind,
    { label: providerLabel(kind), profilePlaceholder: `e.g. my-${kind}` },
  ]),
);

/** `(<table>[$providerForm.provider]?.<field> || "<fallback>")`. */
function meta(field: keyof typeof PROVIDER_FORM_META_FALLBACK): Expr {
  return lookupOr(
    PROVIDER_FORM_META,
    "providerForm.provider",
    field,
    PROVIDER_FORM_META_FALLBACK[field] ?? "",
  );
}

function selectedProviderLabel(): Expr {
  return lookupOr(
    PROVIDER_LABEL_META,
    "providerForm.provider",
    "label",
    "Hosting provider",
  );
}

function selectedProviderProfilePlaceholder(): Expr {
  return lookupOr(
    PROVIDER_LABEL_META,
    "providerForm.provider",
    "profilePlaceholder",
    "e.g. my-hosting-account",
  );
}

/* -------------------------------------------------------------------------- */
/* Expressions                                                                */
/* -------------------------------------------------------------------------- */

const FIRST_PROVIDER_KIND: string = PROVIDER_KINDS[0];

export function shuffledProviderKinds(
  draw: (maxExclusive: number) => number = randomInt,
): readonly ProviderKind[] {
  const kinds = [...PROVIDER_KINDS];
  for (let index = kinds.length - 1; index > 0; index -= 1) {
    const swapIndex = draw(index + 1);
    const current = kinds[index];
    const swap = kinds[swapIndex];
    if (current === undefined || swap === undefined) continue;
    kinds[index] = swap;
    kinds[swapIndex] = current;
  }
  return kinds;
}

/**
 * Go's `resetProviderFormExpression` (`views.go:545-558`).
 *
 * `open` is a parameter because the same reset serves two buttons with opposite
 * intent: **Connect hosting account** resets *and opens*, **Cancel** resets and
 * closes.
 */
function resetProviderForm(open: boolean): Expr {
  return seq(
    set("providerForm.open", jsBoolean(open)),
    set("providerForm.detailsOpen", jsBoolean(false)),
    set("providerForm.profile", jsString("")),
    set("providerForm.provider", jsString(FIRST_PROVIDER_KIND)),
    set("providerForm.credentialEnv", jsString("")),
    set("providerForm.credentialValue", jsString("")),
    set("providerForm.companyId", jsString("")),
    set("providerForm.apiBaseUrl", jsString("")),
    set("providerForm.force", jsBoolean(false)),
  );
}

function chooseProvider(kind: string): Expr {
  return seq(
    set("providerForm.provider", jsString(kind)),
    set("providerForm.credentialEnv", jsString("")),
    set("providerForm.credentialValue", jsString("")),
    set("providerForm.companyId", jsString("")),
    set("providerForm.apiBaseUrl", jsString("")),
    set("providerForm.detailsOpen", jsBoolean(true)),
    focusElementById("profile"),
  );
}

function returnToProviderChoice(): Expr {
  return seq(
    set("providerForm.detailsOpen", jsBoolean(false)),
    focusElementById("provider-choice-heading"),
  );
}

/**
 * Go's `editProviderExpression` (`views.go:522-543`).
 *
 * `credentialValue` is set to the empty string deliberately and must stay that
 * way: the stored secret is not in the view model and could not be filled in
 * even if a designer asked for it. `force` is set to `true`, which is the only
 * thing that lets the save handler overwrite an existing profile.
 */
function editProviderForm(profile: HostingProfileView): Expr {
  const credentialEnv = profile.credential.startsWith("env:")
    ? profile.credential.slice("env:".length)
    : "";
  return seq(
    set("providerForm.profile", jsString(profile.name)),
    set("providerForm.provider", jsString(profile.provider)),
    set("providerForm.credentialEnv", jsString(credentialEnv)),
    set("providerForm.credentialValue", jsString("")),
    set("providerForm.companyId", jsString(profile.companyId ?? "")),
    set("providerForm.apiBaseUrl", jsString(profile.apiBaseUrl ?? "")),
    set("providerForm.force", jsBoolean(true)),
    set("providerForm.open", jsBoolean(true)),
    set("providerForm.detailsOpen", jsBoolean(true)),
    focusElementById("profile"),
  );
}

/**
 * A `@post` to one of the two per-profile provider routes.
 *
 * The include scope is `token` alone — `post` prepends it and nothing else is
 * passed — because these actions identify their target by query parameter and
 * have no form state to carry. In particular they must never carry
 * `providerForm`, whose `credentialValue` is a secret that belongs only to the
 * save request.
 */
function providerAction(path: string, profile: string): Expr {
  return post(url(path, { profile }), { include: [] });
}

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

export interface ProvidersPageModel {
  readonly actions?: ProviderActionsView;
  readonly view: ConfigView;
  readonly notice: DashboardNotice;
  /** True only for `/` when neither hosting nor the site CLI has any sites. */
  readonly onboarding: boolean;
  /** The rendered `open` class, so an opened form does not flash shut on paint. */
  readonly formOpen: boolean;
}

export function renderProvidersPage(model: ProvidersPageModel): Html {
  if (model.actions) return renderProviderActionsPage(model.actions);
  if (model.onboarding) {
    return renderOnboarding(model);
  }
  const addProfile = seq(
    resetProviderForm(true),
    focusElementById("provider-choice-heading"),
  );
  return html`<section class="page"><header class="page-head"><div><h1>Hosting accounts</h1></div><div${classAttr("toolbar", "inline-toolbar", model.formOpen && "hidden")}${ds.classes({ hidden: signal("providerForm.open") })}><button class="button primary" type="button"${ds.on(
    "click",
    addProfile,
  )}>Connect hosting account</button><a class="button secondary"${hrefAttr(
    url("/providers"),
  )}>Refresh</a><a class="button secondary"${hrefAttr(url("/history"))}>Hosting history</a></div></header>${renderProviderFlash(
    model.notice,
  )}<div class="provider-grid">${renderProviderForm(
    model.formOpen,
  )}${renderProviderTable(model.view.profiles, model.formOpen)}</div></section>`;
}

/**
 * Go's `renderOnboarding` (`views.go:228-264`), with two safe starting paths:
 * discover environments through a hosting provider, or ask the site CLI to
 * authorize a site by URL. Neither path gives HQ a WordPress credential.
 */
function renderOnboarding(model: ProvidersPageModel): Html {
  const openForm = seq(
    set("providerForm.open", jsBoolean(true)),
    set("providerForm.detailsOpen", jsBoolean(false)),
    focusElementById("provider-choice-heading"),
  );
  return html`<section class="page onboarding"><header class="page-head"><div><h1>Add site</h1><p class="lede">Add a site manually or from a hosting account. Then configure your AI client to manage your sites.</p></div></header>${renderProviderFlash(
    model.notice,
  )}<div class="onboard-cards"><a class="onboard-card feat"${hrefAttr(
    url("/sites", { new: "cli" }),
  )}><h2>Manually</h2><p>Connect a site directly when Novamira is already installed and you know its URL.</p><span class="button primary">Add site manually</span></a><button class="onboard-card" type="button"${ds.on(
    "click",
    openForm,
  )}><h2>From a hosting account</h2><p>Discover sites and environments from an existing account with a provider supported by Novamira HQ.</p><span class="button primary">Connect a hosting account</span></button></div>${renderProviderForm(
    model.formOpen,
  )}</section>`;
}

/* -------------------------------------------------------------------------- */
/* The form                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `#provider-form`.
 *
 * The `ds-toggle`/`open` pair is Go's `toggleClass` (`views.go:56-61`): the
 * server renders the `open` class when the form should already be open, so
 * `?new=host` and the Edit button do not produce a first-paint flash, and
 * `data-class` takes over from there.
 *
 * The submit scope is `/^(token|providerForm)(\.|$)/` — the only request in the
 * dashboard that carries the credential subtree, and it is a `@post`, so the
 * signals travel in the body. `expr.get` refuses that scope outright.
 */
export function renderProviderForm(open: boolean): Html {
  const saving = dynamicSignalPath("providerSaving", "account");
  const action = post(url("/_dashboard/providers/save"), {
    include: ["providerForm"],
  });
  const providerKinds = shuffledProviderKinds();
  return html`<form${idAttr("provider-form")}${classAttr(
    "panel",
    "form-panel",
    "ds-toggle",
    open && "open",
  )}${ds.classes({ open: signal("providerForm.open") })}${ds.indicator(saving)}${ds.onSubmit(
    action,
  )}><div class="panel-head"><div><h2>Connect a hosting account</h2><p>Novamira HQ uses this account to discover its sites and environments.</p></div></div><input type="hidden"${ds.bind(
    "providerForm.provider",
  )}><section class="provider-form-step"${ds.classes({
    hidden: signal("providerForm.detailsOpen"),
  })}><div class="provider-step-copy"><span class="eyebrow">Step 1 of 2</span><h3${idAttr(
    "provider-choice-heading",
  )}${attr(
    "tabindex",
    "-1",
  )}>Choose your hosting provider</h3><p>The provider determines which credentials and account details are required.</p></div><div class="provider-choice-grid">${providerKinds.map(
    (kind) =>
      html`<button${idAttr(
        `provider-${kind}`,
      )} class="provider-choice" type="button"${ds.on(
        "click",
        chooseProvider(kind),
      )}><strong>${providerLabel(kind)}</strong></button>`,
  )}</div><div class="button-row"><button class="button secondary" type="button"${ds.on(
    "click",
    resetProviderForm(false),
  )}>Cancel</button></div></section><section class="provider-form-step hidden"${ds.classes(
    {
      hidden: not(signal("providerForm.detailsOpen")),
    },
  )}><div class="provider-step-copy provider-details-head"><div><span class="eyebrow">Step 2 of 2</span><h3><span${ds.text(
    selectedProviderLabel(),
  )}></span> account details</h3></div><button class="button quiet" type="button"${ds.on(
    "click",
    returnToProviderChoice(),
  )}>Change provider</button></div><div class="form-grid"><label><span>Account name</span><input${idAttr(
    "profile",
  )} type="text"${ds.bind("providerForm.profile")}${ds.attrs({
    placeholder: selectedProviderProfilePlaceholder(),
  })} required><small class="field-help">A local name used to identify this hosting account in Novamira HQ.</small></label><label><span>Credential</span><input${idAttr(
    "credential-value",
  )} type="password"${ds.bind(
    "providerForm.credentialValue",
  )} autocomplete="new-password" required><small class="field-help"${ds.text(
    meta("credentialHelp"),
  )}></small><small class="field-help">Your hosting credentials are stored only on this computer.</small></label><label><span${idAttr("company-id-label")}${ds.text(
    meta("companyLabel"),
  )}>Company or account ID</span><input${idAttr("company-id")} type="text"${ds.bind(
    "providerForm.companyId",
  )}${ds.attrs({
    placeholder: meta("companyPlaceholder"),
  })}><small class="field-help"${ds.text(
    meta("companyHelp"),
  )}></small></label></div><div class="button-row"><button class="button primary" type="submit"${ds.attrs({ disabled: signal(saving) })}><span${ds.classes({ hidden: signal(saving) })}>Save and connect</span><span class="loading-inline ds-toggle"${ds.classes({ open: signal(saving) })}>Connecting…</span></button><button class="button secondary" type="button"${ds.on(
    "click",
    resetProviderForm(false),
  )}>Cancel</button></div></section></form>`;
}

/* -------------------------------------------------------------------------- */
/* The table                                                                  */
/* -------------------------------------------------------------------------- */

/** Go's `renderProviderTable` (`views.go:385-412`), as markup rather than text. */
export function renderProviderTable(
  profiles: readonly HostingProfileView[],
  formOpen: boolean,
): Html {
  const count = `${String(profiles.length)} hosting ${profiles.length === 1 ? "account" : "accounts"}`;
  return html`<section${classAttr(
    "panel",
    "table-panel",
    formOpen && "hidden",
  )}${ds.classes({
    hidden: signal("providerForm.open"),
  })}><div class="panel-head"><div><h2>Configured</h2><p>${count}</p></div></div>${
    profiles.length === 0
      ? html`<div class="empty">No hosting accounts configured.</div>`
      : html`<div class="table-wrap provider-table-wrap"><table><thead><tr><th>Name</th><th>Provider</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${profiles.map(
          (profile) => renderProviderRow(profile),
        )}</tbody></table></div>`
  }</section>`;
}

/**
 * Two `<tr>` per profile: the row, and the details row it toggles.
 *
 * The details row is rendered on every paint and hidden with `data-class` rather
 * than created on demand, exactly as Go did, so expanding it costs no request
 * and the whole table stays one fragment.
 */
export function renderProviderRow(profile: HostingProfileView): Html {
  const details = providerDetailsSignal(profile.name);
  return html`<tr><td><strong>${profile.name}</strong></td><td>${providerLabelFor(
    profile.provider,
  )}</td><td class="actions"><details class="profile-menu"><summary class="button tiny quiet"${attr("aria-label", "More actions for " + profile.name)}>⋯</summary><div class="profile-menu-popover"><a class="button tiny quiet profile-menu-action"${hrefAttr(url("/providers", { actions: profile.name }))}>Available actions</a><a class="button tiny quiet profile-menu-action"${hrefAttr(url("/history", { profile: profile.name }))}>Activity</a><button class="button tiny quiet profile-menu-action" type="button"${ds.on(
    "click",
    editProviderForm(profile),
  )}>Edit</button><button class="button tiny quiet profile-menu-action" type="button"${ds.on(
    "click",
    toggle(details),
  )}>Details</button>${renderCheckConnectionButton(
    profile.name,
  )}<hr><button class="button tiny quiet profile-menu-action danger" type="button"${ds.on(
    "click",
    confirmThen(
      `Remove hosting account ${profile.name} from Novamira HQ?`,
      providerAction("/_dashboard/providers/remove", profile.name),
    ),
  )}>Remove</button></div></details></td></tr><tr class="details-row ds-toggle"${ds.classes(
    {
      open: signal(details),
    },
  )}><td colspan="3"><dl class="details-list"><div><dt>Credential storage</dt><dd>${
    profile.credential
  }</dd></div><div><dt>Account</dt><dd>${
    profile.companyId ?? "—"
  }</dd></div><div><dt>Base URL</dt><dd>${
    profile.apiBaseUrl ?? "default"
  }</dd></div></dl></td></tr>`;
}

function renderCheckConnectionButton(profile: string): Html {
  return html`<button class="button tiny quiet profile-menu-action" type="button"${ds.indicator(
    connCheckingSignal(profile),
  )}${ds.on(
    "click",
    providerAction("/_dashboard/providers/validate", profile),
  )}>Verify access</button>`;
}

/* -------------------------------------------------------------------------- */
/* The connection cell                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The four states Go's `renderConnCell` distinguished (`views.go:472-499`).
 *
 * `error` is produced **only** by the validate handler's patch. A page render
 * can never claim it, because a failed check is not recorded — see
 * `HostingProfileView.lastCheckedMillis`.
 */
export type ProviderConnState = "connected" | "error" | "nocred" | "unchecked";

const CONN_PILLS: Readonly<Record<ProviderConnState, Html>> = {
  connected: html`<span class="pill ok">Verified</span>`,
  error: html`<span class="pill danger">Check failed</span>`,
  nocred: html`<span class="pill warn">No credential</span>`,
  unchecked: html`<span class="pill">Not checked</span>`,
};

/** Go's state derivation in `renderProviderRow` (`views.go:424-431`). */
export function pageConnState(profile: HostingProfileView): ProviderConnState {
  if (!profile.credentialAvailable) return "nocred";
  return profile.lastCheckedMillis === null ? "unchecked" : "connected";
}

/**
 * One profile's connection cell, and the only fragment in the dashboard whose
 * selector id is computed.
 *
 * The `<small>` carries `data-checked-at` and the text "just now";
 * `relative-time.js` overwrites that `textContent` on load and on an interval,
 * which is why the stamp is its own element and why the value must be unix
 * milliseconds (`ds.checkedAt` refuses anything else).
 */
export function renderConnCell(
  profile: string,
  state: ProviderConnState,
  atMillis: number | null,
): Html {
  const checking = connCheckingSignal(profile);
  return html`<td${idAttr(connCellId(profile))} class="conn-cell"><span class="loading-inline ds-toggle"${ds.classes(
    { open: signal(checking) },
  )}><span class="spinner" aria-hidden="true"></span> Checking…</span><span${ds.classes(
    { hidden: signal(checking) },
  )}>${CONN_PILLS[state]}${
    atMillis === null
      ? false
      : html` <small class="last-updated"${ds.checkedAt(
          atMillis,
        )}>just now</small>`
  }</span></td>`;
}

/* -------------------------------------------------------------------------- */
/* The flash                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `#provider-flash` (Go's `renderProviderFlash`, `views.go:560-569`).
 *
 * It exists so that a failure which must *not* repaint the table — a signal
 * parse failure on `providers/validate`, which would otherwise close an open
 * form — has somewhere to land. It is the only producer of this fragment, which
 * is why the catalog row and this renderer arrived together.
 */
export function renderProviderFlash(notice: DashboardNotice, body = ""): Html {
  return html`<div${idAttr("provider-flash")}>${
    notice.message === "" ? false : renderNotice(notice)
  }${body === "" ? false : html`<pre class="code-output">${body}</pre>`}</div>`;
}
