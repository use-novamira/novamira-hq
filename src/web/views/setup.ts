// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Novamira-setup page: the target panel, the action panel, the live event
 * log, the result block and the failure block.
 *
 * **What the Go did.** `renderSetupPage` (`views.go:1168-1179`),
 * `renderSetupWork` (`:1181-1192`), `renderSetupWorkBody` (`:1194-1267`),
 * `renderSetupEvents` (`:1269-1293`), `renderSetupResult` (`:1295-1307`) and
 * `humanizeSetupError` (`:23-35`), all `strings.Builder` renderers escaping by
 * hand with `h(...)`. Every one of them is an `html` template here, and both
 * URLs — the start `@post` and the stream `@get` — are `url()` values rather
 * than `url.Values.Encode()` concatenations.
 *
 * **The boundary rule rewrites two of these blocks outright.**
 *
 * 1. *The action panel's description.* Go promised the run "detects the site
 *    (URL and admin), creates a WordPress application password, and connects the
 *    site so your agent can work on it" (`views.go:1239`). All three claims are
 *    false under the boundary rule: HQ creates no WordPress user, holds no site
 *    token and connects nothing. The sentence now describes what
 *    `provisionNovamira` actually does — PHP gate, install, activate, AI
 *    Abilities, compatibility check — and says out loud that connecting the
 *    agent is a **separate** step run with the site CLI.
 * 2. *The result block.* Go's `renderSetupResult` rendered "Saved Site Profile"
 *    with the site's URL, REST URL, **username**, **credential** and the config
 *    path it had just been written to. Deleted whole. The replacement renders
 *    `NovamiraSetupResult` (`src/provisioning/setup.ts:163-188`) — what landed on
 *    the site and whether it verified — and then the handoff command, taken from
 *    `result.handoff` (`src/provisioning/handoff.ts`) rather than concatenated
 *    here, so the dashboard and the CLI print the same line.
 *
 * **`humanizeSetupError` is rewritten over `ErrorCode`, not over English.** Go
 * lower-cased the error text and searched it for `"json"`, `"timeout"`, `"401"`,
 * `"permission"` and six more substrings, which misfires on any message that
 * happens to contain one of those words — "Failed to install the plugin: the
 * provider rejected the timeout parameter" was reported as an unreachable site.
 * HQ switches on the code the error already carries. The `<details>` below the
 * sentence renders `code` and `message` and **never** `details`: a failed
 * compatibility preflight puts the whole install record there, and
 * `failureEnvelope`'s `redact()` runs on the JSON path only.
 *
 * **Deleted with the site-profile surface:** `setupView.SiteProfile` and
 * `.ReplaceProfile`, the `siteprofile` and `replace` query parameters, the "Fix
 * set up" button label (`views.go:1235`), and the "Direct site profile" and
 * "Mode: Replace saved direct site connection" rows (`views.go:1223-1228`).
 * There is no saved site connection to replace, so the button is always
 * `Start Setup`.
 *
 * **Two fragments, two modes, one element.** `#setup-work` is patched **outer**
 * by `/_dashboard/setup/jobs/<id>` ({@link renderSetupWork}, whose root carries
 * the id and the `data-init` stream) and **inner** by `…/stream`
 * ({@link renderSetupWorkBody}, which must not re-emit the wrapper or the stream
 * would restart itself on every tick). Go's catalog carried the same id twice for
 * the same reason.
 */

import type { ErrorCode } from "../../errors.js";
import type { NovamiraSetupResult } from "../../provisioning/index.js";
import * as ds from "../datastar.js";
import { getStream, post, seq, set, jsString, signal, not } from "../expr.js";
import { classAttr, hrefAttr, html, idAttr, url, type Html } from "../html.js";
import type {
  SetupJobEvent,
  SetupJobFailure,
  SetupJobSnapshot,
} from "../services/setup-jobs.js";
import { statusClass, type NoticeLevel } from "./types.js";

/* -------------------------------------------------------------------------- */
/* The view model                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Go's `setupView` (`types.go`), minus the two site-profile fields.
 *
 * `siteLabel` and `envName` are display strings carried on the link from the
 * Sites page; both may be empty, and the target panel has a fallback for each.
 * `job` is `null` for a fresh view *and* for a `?job=` id nobody knows, which is
 * the case the page's toast explains.
 */
export interface SetupView {
  readonly profile: string;
  readonly envId: string;
  readonly siteLabel: string;
  readonly envName: string;
  readonly jobId: string;
  readonly job: SetupJobSnapshot | null;
}

const EMPTY_SETUP: SetupView = Object.freeze({
  profile: "",
  envId: "",
  siteLabel: "",
  envName: "",
  jobId: "",
  job: null,
});

export interface SetupViewLabels {
  readonly siteLabel?: string;
  readonly envName?: string;
}

/**
 * The view for a known job.
 *
 * Go rebuilt this literal at four call sites and dropped `siteLabel`/`envName`
 * at three of them, so the Target panel fell back to the profile name the moment
 * a job existed (`server.go:422`, `:457`, `:970`, `:975`). HQ keeps whatever
 * labels the caller still has — they came off the same link — which is the one
 * behavioural improvement in this file.
 */
export function setupViewForJob(
  job: SetupJobSnapshot,
  labels: SetupViewLabels = {},
): SetupView {
  return {
    profile: job.profile,
    envId: job.envId,
    siteLabel: labels.siteLabel ?? "",
    envName: labels.envName ?? "",
    jobId: job.id,
    job,
  };
}

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

/** `/novamira-setup`. Go's `renderSetupPage` (`views.go:1168-1179`). */
export function renderSetupPage(view: SetupView = EMPTY_SETUP): Html {
  const head = html`<header class="page-head"><div><h1>Novamira Setup</h1></div><a class="button secondary"${hrefAttr(
    url("/sites"),
  )}>Hosting Sites</a></header>`;
  if (view.profile === "" && view.envId === "" && view.jobId === "") {
    return html`<section class="page">${head}<div class="empty">Select an environment from Hosting Sites to start setup.</div></section>`;
  }
  return html`<section class="page">${head}${renderSetupWork(view)}</section>`;
}

/**
 * `#setup-work`, the **outer** fragment.
 *
 * The `data-init` stream is attached only while the job is running
 * (`views.go:1184`): a finished job's page must not open a long-lived request
 * that would immediately find nothing to say. `getStream` is the constructor
 * that carries `openWhenHidden` and `requestCancellation: "disabled"` — a setup
 * run takes minutes, and an operator who switches tabs must not watch the
 * progress list freeze.
 */
export function renderSetupWork(view: SetupView): Html {
  const streaming = view.job !== null && view.job.status === "running";
  return html`<div${idAttr("setup-work")} class="setup-work"${
    streaming
      ? ds.init(
          getStream(url(`/_dashboard/setup/jobs/${view.jobId}/stream`), {
            include: [],
          }),
        )
      : false
  }>${renderSetupWorkBody(view)}</div>`;
}

/**
 * The **contents** of `#setup-work` — no wrapper, because the stream patches it
 * inner. Go's `renderSetupWorkBody` (`views.go:1194-1267`).
 */
export function renderSetupWorkBody(view: SetupView, now = Date.now()): Html {
  const job = view.job;
  const status = job?.status ?? "ready";
  const result = job?.result ?? null;
  return html`<div class="setup-grid">${renderTargetPanel(view, status)}${
    view.jobId === "" ? renderActionPanel(view) : renderSetupEvents(view, now)
  }${result === null ? false : renderSetupResult(result)}${
    job?.status === "error" ? renderSetupFailure(job.error) : false
  }</div>`;
}

/* -------------------------------------------------------------------------- */
/* Target                                                                     */
/* -------------------------------------------------------------------------- */

/** The job status a `ready` view has before anything has been started. */
type SetupDisplayStatus = SetupJobSnapshot["status"] | "ready";

/**
 * Job status → notice level.
 *
 * Go's `statusClass` (`views.go:1563-1574`) lower-cased an arbitrary `string`
 * and matched it against four word lists, falling through to `neutral`; a status
 * nobody had thought of styled itself silently. This lookup is total over a
 * four-member union, so a new status is a compile error here.
 */
const STATUS_LEVELS: Readonly<Record<SetupDisplayStatus, NoticeLevel>> = {
  ready: "warn",
  running: "warn",
  done: "ok",
  error: "danger",
};

function dlField(label: string, value: string): Html {
  return html`<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

function renderTargetPanel(view: SetupView, status: SetupDisplayStatus): Html {
  const target = view.siteLabel === "" ? view.profile : view.siteLabel;
  const envDisplay = view.envName === "" ? view.envId : view.envName;
  return html`<section class="panel"><div class="panel-head"><div><h2>Target</h2><p>${target}</p></div><span${classAttr(
    "pill",
    statusClass(STATUS_LEVELS[status]),
  )}>${status}</span></div><dl class="details-list">${
    view.siteLabel === "" ? false : dlField("Site", view.siteLabel)
  }${dlField("Environment", envDisplay)}${dlField(
    "Hosting profile",
    view.profile,
  )}${view.jobId === "" ? false : dlField("Job", view.jobId)}</dl></section>`;
}

/* -------------------------------------------------------------------------- */
/* Action                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the run actually does. Go's sentence named three steps HQ deliberately
 * does not perform; this one names the five it does and points at the separate
 * command that connects the agent.
 */
const SETUP_DESCRIPTION =
  "This checks compatibility before changing the plugin. An outdated installation requires an explicit update. After setup, choose Connect this site to authorize access in your browser.";

const AI_ABILITIES_WARNING =
  "When enabled, AI agents can execute PHP code and perform filesystem operations on this site. Use AI Abilities only on development or staging sites with a current backup.";

/** Go's action panel (`views.go:1237-1247`), with one label and no `Fix set up`. */
function renderActionPanel(view: SetupView): Html {
  // Go's `setupStartURL` carried only `profile` and `env`, so the page it
  // repainted after a start had lost the site and environment names and fell
  // back to the profile. Carrying them here costs nothing and keeps the Target
  // panel reading the same before and after the click.
  const action = post(
    url("/_dashboard/setup/start", {
      profile: view.profile,
      env: view.envId,
      site: view.siteLabel === "" ? undefined : view.siteLabel,
      envname: view.envName === "" ? undefined : view.envName,
    }),
    { include: ["setup"] },
  );
  return html`<section class="panel action-panel"><p class="field-help">${SETUP_DESCRIPTION}</p><label class="toggle setup-ai-toggle"><input type="checkbox"${ds.bind(
    "setup.enableAiAbilities",
  )}><span>I understand and approve enabling AI Abilities on this site</span></label><p class="field-help">Approval is required to start setup. Without it, nothing will be installed or changed.</p><p class="field-help setup-warning"><strong>Security note:</strong> ${AI_ABILITIES_WARNING}</p><button class="button primary" type="button" disabled${ds.attrs({ disabled: not(signal("setup.enableAiAbilities")) })}${ds.on(
    "click",
    action,
  )}>Start Setup</button></section>`;
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                   */
/* -------------------------------------------------------------------------- */

const EVENT_LEVELS: Readonly<Record<SetupJobEvent["level"], NoticeLevel>> = {
  info: "neutral",
  ok: "ok",
  error: "danger",
};

/**
 * `HH:MM`, Go's `time.Kitchen`.
 *
 * `Intl` is a `node:` builtin, so the locale format costs no dependency. The
 * locale is pinned to `en-US` rather than taken from the host: the dashboard's
 * copy is English, and a mixed-locale page reads like a bug.
 */
function eventTime(millis: number): string {
  return new Date(millis).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Go's `renderSetupEvents` (`views.go:1269-1293`). */
function renderSetupEvents(view: SetupView, now: number): Html {
  const events = view.job?.events ?? [];
  const waiting =
    view.job?.status === "running"
      ? html`<div class="setup-wait"><span class="spinner" aria-hidden="true"></span><div><strong>Setup in progress</strong><p>Waiting for your hosting provider. A step can take 30 seconds or longer.</p><span role="timer">${Math.max(0, Math.floor((now - view.job.startedAt) / 1000))} seconds elapsed</span></div></div>`
      : false;
  return html`<section class="panel"><div class="panel-head"><div><h2>Progress</h2><p>${
    view.jobId
  }</p></div></div>${waiting}<ol class="events">${
    events.length === 0
      ? html`<li><time></time><span class="event-level">info</span><span>Waiting for progress.</span></li>`
      : events.map(
          (event) =>
            html`<li><time>${eventTime(event.at)}</time><span${classAttr(
              "event-level",
              statusClass(EVENT_LEVELS[event.level]),
            )}>${event.level}</span><span>${event.message}</span></li>`,
        )
  }</ol></section>`;
}

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/**
 * What landed on the site, and the handoff.
 *
 * Every field here comes off `NovamiraSetupResult`; none of them is a
 * credential, a username, a REST URL or a config path, because HQ produces none
 * of those. The `<pre>` renders `result.handoff.commandLine` — the copyable
 * one-liner, not `handoff.command`, which is the argv array the Connect action
 * spawns — so it cannot drift from what `hosting novamira setup` prints.
 */
function renderSetupResult(result: NovamiraSetupResult): Html {
  const compatibility =
    result.compatibility.status === "supported"
      ? `supported${detail(" · WordPress ", result.compatibility.wordpressVersion)}${detail(
          " · Novamira ",
          result.compatibility.pluginVersion,
        )}${
          result.compatibility.restApiVersion === null
            ? ""
            : ` · REST v${String(result.compatibility.restApiVersion)}`
        }`
      : "skipped";
  return html`<section class="panel"><div class="panel-head"><div><h2>Novamira installed</h2><p>${
    result.siteUrl
  }</p></div><span class="pill ok">done</span></div><dl class="details-list">${dlField(
    "Plugin",
    `${result.plugin.slug} ${result.plugin.version ?? "—"} · Activated: ${yesNo(
      result.plugin.activated,
    )}`,
  )}${dlField(
    "AI Abilities",
    `${result.aiAbilities.enabled ? "enabled" : "disabled"}${detail(
      " · locked to ",
      result.aiAbilities.domain,
    )}`,
  )}${dlField("Compatibility", compatibility)}${dlField(
    "Ready",
    result.ready === true
      ? "yes"
      : result.compatibility.status === "supported"
        ? "AI Abilities are not enabled for this domain"
        : "not checked",
  )}</dl>${result.warnings.map(
    (warning) => html`<div class="notice warn">${warning.message}</div>`,
  )}<div class="setup-connect"><h3>Connect this site to Novamira</h3><p>Authorize access in your browser to finish connecting this site.</p><button class="button primary" type="button"${ds.on("click", seq(set("cliSites.url", jsString(result.siteUrl)), set("cliSites.name", jsString("")), post(url("/_dashboard/site-profiles/connect", { unified: true }), { include: ["cliSites"] })))}${ds.indicator("cliSites.loading")}${ds.attrs({ disabled: signal("cliSites.loading") })}>Connect this site</button><p class="field-help ds-toggle"${ds.classes({ open: signal("cliSites.loading") })}>Waiting for authorization in your browser…</p><details class="setup-detail"><summary>Connect manually with Novamira CLI</summary><p class="field-help">If Novamira CLI is not installed, install it first.</p><pre>${
    result.handoff.commandLine
  }</pre></details></div></section>`;
}

/** `prefix + value`, or nothing when the value is absent. */
function detail(prefix: string, value: string | null): string {
  return value === null || value === "" ? "" : `${prefix}${value}`;
}

/* -------------------------------------------------------------------------- */
/* Failure                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One sentence per error code. Go matched English substrings of the message
 * (`views.go:23-35`); this switches on the code the error already carries, so a
 * provider message containing the word "timeout" is no longer reported as an
 * unreachable site.
 */
const HUMANIZED: Partial<Record<ErrorCode, string>> = {
  network_error:
    "Couldn't reach the site. Check the URL and that the site is online.",
  timeout:
    "Couldn't reach the site. Check the URL and that the site is online.",
  credential_missing:
    "The credentials were rejected. Check the provider API key.",
  credential_invalid:
    "The credentials were rejected. Check the provider API key.",
  rate_limited: "The credentials were rejected. Check the provider API key.",
  schema_validation_failed:
    "Couldn't read the site's response. The site may be unreachable or returned something unexpected.",
  server_unsupported:
    "The site isn't ready for Novamira yet. Update WordPress and the Novamira plugin, then try again.",
};

const HUMANIZED_DEFAULT = "Setup failed. See the technical details below.";

export function humanizeSetupError(code: ErrorCode): string {
  return HUMANIZED[code] ?? HUMANIZED_DEFAULT;
}

/**
 * Go's failure block (`views.go:1254-1264`).
 *
 * `failure` is nullable because a job's status and its recorded error are two
 * fields: a job that ended in `error` with no `{ code, message }` would be a bug
 * in the runner, and the honest rendering of it is the default sentence rather
 * than a page that silently omits the panel.
 */
function renderSetupFailure(failure: SetupJobFailure | null): Html {
  return html`<section class="panel"><div class="panel-head"><h2>Setup failed</h2></div><div class="setup-failure-body"><div class="empty error">${
    failure === null ? HUMANIZED_DEFAULT : humanizeSetupError(failure.code)
  }</div>${
    failure === null
      ? false
      : html`<details class="setup-detail"><summary>Technical details</summary><pre>${failure.code}: ${failure.message}</pre></details>`
  }</div></section>`;
}
