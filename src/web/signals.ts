// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dashboard's one root signal object, its defaults, and the compiler-derived
 * union of every legal signal path.
 *
 * **What the Go did.** `dashboardSignals` (types.go:134-223) was a struct tree
 * serialized into the root `data-signals` attribute, and every reference to a
 * signal elsewhere was a hand-written string: `"$providerForm.open"`,
 * `bindSignal("providerForm.companyID")`, `"$" + dsig`. Two conventions tests
 * (`TestDashboardDatastarBindingsUseBareSignalPaths` and the `data-indicator`
 * twin) existed precisely because those strings could drift — a `$` in a
 * `data-bind`, or a path naming a field that no longer existed, was a runtime
 * silence Go could only catch by regexing rendered output.
 *
 * **What HQ does instead.** `SignalPath` is derived from `DashboardSignals` by
 * the compiler, so a path that names a field the interface does not have is a
 * type error, and `ds.bind`/`ds.indicator` take that type rather than a
 * `string`. A leading `$` cannot type-check, and `assertSignalPath` re-checks the
 * grammar at runtime so an `as SignalPath` cast cannot smuggle one through.
 *
 * **Deliberate departures from the Go struct.**
 *
 * - `siteForm` is **deleted**, with `siteFormSignals`, `siteUpsertRequest`,
 *   `siteProfileSummary` and `configResponse.SiteProfiles`. HQ's schema has no
 *   site profiles and the dashboard has no site form; under the boundary rule
 *   there is nothing for those signals to hold.
 * - Go's `companyID` / `apiBaseURL` are spelled `companyId` / `apiBaseUrl`, to
 *   match `HostingProfile.companyId` in `src/config/schema.ts`. Nothing shipped
 *   depends on the old spelling — the only signal path our own static JS selects
 *   on is `sites.search` — and one spelling across config, JSON and DOM is worth
 *   the rename.
 * - Go's `setupSignals.EnableAIAbilities *bool` becomes two types. The rendered
 *   `SetupSignals.enableAiAbilities` is a plain `boolean` defaulted to `true`;
 *   the *parsed* incoming shape (6b) is `{ enableAiAbilities?: boolean }`, where
 *   absent means "keep the default, enabled" and `false` means explicitly off.
 *   Go's comment for the pointer is carried below verbatim, because it explains
 *   why the incoming shape must stay optional.
 * - Every member is written out explicitly in `defaultDashboardSignals`. Go
 *   relied on struct zero values, which `encoding/json` still emits;
 *   TypeScript's object literals must carry the keys or the root `data-signals`
 *   object loses them and a `data-bind` on a missing path silently creates it.
 *
 * **The dynamic-signal escape hatch (6b).** `DashboardSignals` cannot describe
 * one signal per configured provider profile, and it should not try: those
 * signals are per-row UI state that Datastar creates on first write, and putting
 * one per profile into the root `data-signals` would grow the token-bearing
 * attribute on every page for no benefit. {@link dynamicSignalPath} is the one
 * way to mint such a path, it hex-encodes the caller's key, and it goes through
 * {@link assertSignalPath} like everything else. See its comment for the Go
 * collision it exists to fix.
 */

import { CliError } from "../errors.js";
import type { JsonValue } from "./expr.js";

/** The "every configured provider profile" selection in the site browser. */
export const ALL_PROFILES_SENTINEL = "__all__";

export interface ProviderFormSignals {
  readonly open: boolean;
  readonly profile: string;
  readonly provider: string;
  readonly credentialEnv: string;
  /**
   * The only signal that ever holds a secret. It is typed into the local page,
   * posted in the request body, and handed straight to the credential store; it
   * is never rendered back, never logged, and never placed in a URL.
   */
  readonly credentialValue: string;
  readonly companyId: string;
  readonly apiBaseUrl: string;
  readonly force: boolean;
}

export interface DeployFormSignals {
  readonly open: boolean;
  readonly name: string;
  readonly hostingProfile: string;
  readonly siteId: string;
  readonly siteLabel: string;
  readonly sourceEnvId: string;
  readonly sourceEnvName: string;
  readonly targetEnvId: string;
  readonly targetEnvName: string;
  readonly pushDb: boolean;
  readonly pushFiles: boolean;
  readonly searchReplace: boolean;
}

export interface SiteBrowserSignals {
  readonly profile: string;
  readonly includeEnvs: boolean;
  readonly loading: boolean;
  readonly search: string;
  readonly newMenuOpen: boolean;
}

/**
 * The Sites page's site-profile panel.
 *
 * `url` is the "connect a site the providers do not list" box. It holds a site
 * URL — a public address, never a credential — which is why it is a `@post`'s
 * include scope rather than a query parameter: it is typed, not rendered, and a
 * `@get` would put whatever the operator pasted into a URL.
 *
 * There is deliberately no `name` signal. Profile naming belongs to the site
 * CLI, and `auth login` is spawned with the URL as its only argument.
 */
export interface CliSitesSignals {
  readonly open: boolean;
  readonly url: string;
  readonly name: string;
  readonly loading: boolean;
}

export interface DiagnosticsSignals {
  readonly profile: string;
}

export interface UpdateSignals {
  readonly loading: boolean;
  readonly installing: boolean;
}

/**
 * Go's comment on the pointer field, verbatim, because the reasoning survives
 * the type change:
 *
 * > setupSignals uses a pointer so old/no-JS posts that include only the token
 * > keep the default setup behavior: AI Abilities are enabled unless the
 * > dashboard checkbox explicitly sends false.
 */
export interface SetupSignals {
  readonly enableAiAbilities: boolean;
}

export interface DashboardSignals {
  /** The per-process mutation token; the page's only copy of it. */
  readonly token: string;
  readonly providerForm: ProviderFormSignals;
  readonly deployForm: DeployFormSignals;
  readonly sites: SiteBrowserSignals;
  readonly cliSites: CliSitesSignals;
  readonly diagnostics: DiagnosticsSignals;
  readonly updates: UpdateSignals;
  readonly setup: SetupSignals;
}

/**
 * Every dotted path in a signal tree, branch nodes included, derived by the
 * compiler. `object` rather than `Record<string, unknown>` is the test, because
 * an `interface` has no implicit index signature and would fail the latter.
 */
export type SignalPathsOf<T> = {
  [K in keyof T & string]: NonNullable<T[K]> extends object
    ? K | `${K}.${SignalPathsOf<NonNullable<T[K]>>}`
    : K;
}[keyof T & string];

/** Every dotted path in `DashboardSignals`. */
export type SignalPath = SignalPathsOf<DashboardSignals>;

/** The runtime grammar a signal path must satisfy: bare, dotted, no `$`. */
const SIGNAL_PATH = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

/**
 * Runtime guard for the attribute helpers.
 *
 * The type already rules out a `$` prefix and a misspelled field; this catches
 * the one hole the type cannot, an `as SignalPath` cast on a computed string,
 * and it is what 6b's `dynamicSignalPath` will have to satisfy too.
 */
export function assertSignalPath(path: string): asserts path is SignalPath {
  if (!SIGNAL_PATH.test(path)) {
    throw new CliError(
      "internal_error",
      `"${path}" is not a bare signal path. Datastar bindings take a dotted path with no leading '$' and no characters outside [A-Za-z0-9_.].`,
      { details: { signalPath: path } },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Dynamic per-row signals                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A per-row signal path derived from a caller-supplied key.
 *
 * **The bug this fixes.** Go's `rowSignal` (views.go:456-466) built
 * `prefix + <the key's alphanumerics>`, dropping every other character. That map
 * is not injective: the profiles `a-b` and `ab` both become `…ab`, so expanding
 * one row's Details expanded the other's, and clicking "Check connection" on one
 * spun the spinner on both. Worse, a profile named `-` collapsed to the bare
 * prefix and collided with every other punctuation-only name.
 *
 * Hex encoding is injective by construction and stays inside the
 * `[A-Za-z0-9_]` grammar {@link assertSignalPath} enforces, so any legal profile
 * name — including one with `.`, `-`, `_` or non-ASCII characters — yields a
 * distinct, valid path. It is the same recipe `connCellId` uses for element ids,
 * for the same reason.
 *
 * These paths are deliberately **absent from {@link DashboardSignals}**:
 * Datastar creates a signal on first write, which is what Go relied on too.
 */
export function dynamicSignalPath(prefix: string, key: string): SignalPath {
  if (prefix === "" || key === "") {
    throw new CliError(
      "internal_error",
      "A dynamic signal path needs a non-empty prefix and a non-empty key.",
    );
  }
  const path = `${prefix}_${Buffer.from(key, "utf8").toString("hex")}`;
  assertSignalPath(path);
  return path;
}

/** `checking_<hex>` — Go's `connSignal`, the row's `data-indicator` target. */
export function connCheckingSignal(profile: string): SignalPath {
  return dynamicSignalPath("checking", profile);
}

/** `details_<hex>` — Go's `rowSignal("details", …)`, the details-row toggle. */
export function providerDetailsSignal(profile: string): SignalPath {
  return dynamicSignalPath("details", profile);
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Go's `defaultProviderFormSignals` (views.go:1498-1506).
 *
 * Exported because three call sites need the *same* object: the root
 * `data-signals` of a rendered page, the reset expression the Cancel and Add
 * Profile buttons run, and the RFC 7386 signal patch the save and remove
 * handlers send. A fourth spelling would be a form that resets to a different
 * state depending on how it was reset.
 */
export function defaultProviderFormSignals(
  firstProviderKind?: string,
): ProviderFormSignals {
  return {
    open: false,
    profile: "",
    provider: firstProviderKind ?? "",
    credentialEnv: "",
    credentialValue: "",
    companyId: "",
    apiBaseUrl: "",
    force: false,
  };
}

/** The deploy form's reset state; 6b-3's save handler patches it. */
export function defaultDeployFormSignals(): DeployFormSignals {
  return {
    open: false,
    name: "",
    hostingProfile: "",
    siteId: "",
    siteLabel: "",
    sourceEnvId: "",
    sourceEnvName: "",
    targetEnvId: "",
    targetEnvName: "",
    pushDb: false,
    pushFiles: false,
    searchReplace: false,
  };
}

export interface DefaultSignalOptions {
  /** `?new=host` opens the provider form on load. `?new=site` is ignored. */
  readonly openProviderForm?: boolean;
  /** `?new=cli` opens the site-CLI connection form on the unified Sites page. */
  readonly openCliSiteForm?: boolean;
  /** Preselects the provider `<select>`, as Go's `defaultProviderFormSignals` did. */
  readonly firstProviderKind?: string;
}

/** The root signal object every rendered page carries on `.shell`. */
export function defaultDashboardSignals(
  token: string,
  options?: DefaultSignalOptions,
): DashboardSignals {
  return {
    token,
    providerForm: {
      ...defaultProviderFormSignals(options?.firstProviderKind),
      open: options?.openProviderForm ?? false,
    },
    deployForm: defaultDeployFormSignals(),
    sites: {
      profile: ALL_PROFILES_SENTINEL,
      includeEnvs: true,
      loading: false,
      search: "",
      newMenuOpen: false,
    },
    cliSites: {
      open: options?.openCliSiteForm ?? false,
      url: "",
      name: "",
      loading: false,
    },
    diagnostics: { profile: "" },
    updates: { loading: false, installing: false },
    setup: { enableAiAbilities: true },
  };
}

/**
 * The same object, widened to the JSON record `ds.signals` takes.
 *
 * `DashboardSignals` is an interface, and an interface has no implicit index
 * signature, so it is not assignable to `Record<string, JsonValue>` however
 * JSON-shaped it is. Rather than loosen `ds.signals` — which would let any
 * object through — the widening happens once, here, and the compiler still
 * checks that every branch is JSON-serializable. It also fails loudly if a
 * future signal ever holds something JSON cannot carry.
 *
 * The type-only import of `JsonValue` is erased at emit, so this does not close
 * a runtime cycle with `expr.ts`.
 */
export function toSignalRecord(
  signals: DashboardSignals,
): Readonly<Record<string, JsonValue>> {
  return {
    token: signals.token,
    providerForm: { ...signals.providerForm },
    deployForm: { ...signals.deployForm },
    sites: { ...signals.sites },
    cliSites: { ...signals.cliSites },
    diagnostics: { ...signals.diagnostics },
    updates: { ...signals.updates },
    setup: { ...signals.setup },
  };
}
