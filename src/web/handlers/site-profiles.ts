// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The four `/_dashboard/site-profiles*` routes: list the site CLI's profiles,
 * connect one, sign one out, forget one.
 *
 * **There is no Go original, and the absence is the point.** Go had
 * `/_dashboard/sites/save` and `/_dashboard/sites/remove`, which wrote and
 * deleted **Go's own** `site_profiles` — entries holding a WordPress Application
 * Password that Go had created over the site's REST API. Both rows are deleted,
 * not deferred, and `docs/v1-contract.md` says so; the routes here are a
 * different thing wearing a similar name. They manage the **site CLI's**
 * profiles, by spawning `novamira`, in the site CLI's own process, under the
 * site CLI's own credentials. HQ holds no WordPress token, issues no request to
 * a configured site, and stores nothing.
 *
 * **Every handler ends in the same two patches**, in this order: `#cli-sites`
 * outer, then `#toast` outer. Nothing here patches `#main`, `#sites-result` or
 * `#sites-status`:
 *
 * - repainting `#main` would discard whatever the operator had typed into the
 *   search box at the top of the Sites page;
 * - repainting `#sites-result` would mean *re-listing the hosting providers*, a
 *   round trip per configured profile, because a stale listing patched back
 *   would look like a refresh that lost data. Signing out of one site profile
 *   is not a reason to call eight hosting APIs. The provider listing's own
 *   Refresh button is what re-reads it, and the connection pills there go stale
 *   until it is pressed — which is the same five-minute staleness the cache
 *   already has.
 *
 * **Each mutating route re-lists before it patches.** The alternative — patch an
 * optimistic row and trust it — would show "Removed" for a profile the site CLI
 * still holds when the child failed halfway. One extra `sites list` is cheap
 * (it is local and makes no network request) and it is the only way the panel
 * can be a report of what `novamira` actually holds rather than of what HQ
 * hoped it would.
 *
 * **The two inputs are validated before they can reach an argv array.** A URL
 * goes through `normalizeSiteUrl` — the same normalizer `hosting novamira setup`
 * and `/_dashboard/connect` use, which refuses userinfo, a query string, a
 * fragment and a non-loopback `http://` origin, and never echoes the raw value
 * into an error. A profile name goes through {@link isSiteProfileName}, whose
 * leading-character rule is what stops a `--json` in that position from running
 * a different command than the one HQ meant. A rejected value is a `usage_error`
 * toast and **nothing is spawned**.
 *
 * **Child output never reaches the page.** `SiteProfileOutcome`'s failure arm
 * carries an `UnavailableReason` and has nowhere to put a string, so a toast can
 * only ever show `unavailableHint(reason)` — a fixed sentence from a closed set.
 * The copyable command an operator needs when that sentence says "install the
 * site CLI" is already in each button's `title`.
 */

import { unavailableHint } from "../../connection-state.js";
import { asCliError, CliError } from "../../errors.js";
import { normalizeSiteUrl } from "../../provisioning/index.js";
import { isSiteProfileName } from "../../site-profiles.js";
import type { SiteProfileOutcome } from "../../site-profiles.js";
import { patchToast } from "../patch.js";
import { readSignals } from "../request.js";
import type { DashboardRequest } from "../request.js";
import type { DashboardResponse } from "../responses.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import { parseCliSites } from "../signals-input.js";
import type { SseStream } from "../sse.js";
import { renderSiteProfiles } from "../views/site-profiles.js";
import { EMPTY_NOTICE, type DashboardNotice } from "../views/types.js";

function danger(message: string): DashboardNotice {
  return { level: "danger", message };
}

/**
 * The two fragments, always in this order and always both.
 *
 * Exported for the same reason `patchSites` is: four routes send exactly this
 * pair, and a fifth spelling would be a route that patched the same element in
 * a different mode.
 */
export async function patchSiteProfiles(
  stream: SseStream,
  context: RouteContext,
  notice: DashboardNotice,
): Promise<void> {
  // `listProfiles` resolves for every failure, so the listing itself is always
  // renderable; `siteProfilesHint` turns an untrustworthy one into a sentence.
  const listing = await context.integration.listProfiles();
  // Warm only, and it never triggers anything: the back-links to hosting
  // environments are a by-product of the last Hosting Sites load. Before one
  // has happened the map is empty and the rows carry no link, which is the
  // honest answer — fetching here would make this page open with a round trip
  // to every configured hosting API.
  stream.patchElements(
    renderSiteProfiles({ listing, links: context.sites.siteProfileLinks() }),
    { selectorId: "cli-sites", mode: "outer" },
  );
  patchToast(stream, notice);
}

/**
 * Run one handler body, and turn anything it throws into a toast.
 *
 * The browser is waiting for a patch stream; a JSON failure envelope would
 * leave it with nothing on screen. `details` reach nothing — `failureEnvelope`'s
 * `redact()` runs on the JSON path only, and a notice bypasses it entirely.
 */
function siteProfileRoute(
  context: RouteContext,
  path: string,
  body: (request: DashboardRequest, stream: SseStream) => Promise<void>,
): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      try {
        await body(request, stream);
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", { path, code: cliError.code });
        // The panel is still repainted: the operator asked for an action, and
        // leaving the pre-action list on screen beside a failure toast is how a
        // dashboard ends up disagreeing with the CLI it reports on. A second
        // failure inside the repaint is caught by the outer `run`'s own guard.
        try {
          await patchSiteProfiles(stream, context, danger(cliError.message));
        } catch {
          patchToast(stream, danger(cliError.message));
        }
      }
      stream.close();
    },
  });
}

/** Turn an action's outcome into the sentence the toast shows. */
function noticeFor(
  outcome: SiteProfileOutcome,
  done: string,
  missing: string,
): DashboardNotice {
  switch (outcome.kind) {
    case "done":
      return { level: "ok", message: done };
    case "missing":
      // Not a failure: the site CLI does not hold that profile, which is the
      // state the operator was asking for.
      return { level: "warn", message: missing };
    case "failed":
      // A fixed sentence from a closed set. No child output, ever.
      return danger(unavailableHint(outcome.reason));
  }
}

/**
 * `?name=`, refused before it can become an argv element.
 *
 * The error names the grammar and never the value: an operator who reached this
 * by editing a URL does not need it echoed back, and a rendered notice is not
 * redacted.
 */
function requireName(request: DashboardRequest): string {
  const name = (request.query.get("name") ?? "").trim();
  if (!isSiteProfileName(name)) {
    throw new CliError(
      "usage_error",
      "A Novamira site profile name must start with a letter or digit and may contain only letters, digits, '.', '_' and '-'.",
    );
  }
  return name;
}

/* -------------------------------------------------------------------------- */
/* GET /_dashboard/site-profiles                                              */
/* -------------------------------------------------------------------------- */

export function createSiteProfilesHandler(context: RouteContext): RouteHandler {
  return siteProfileRoute(
    context,
    "/_dashboard/site-profiles",
    async (_request, stream) => {
      // A plain load says nothing: the panel's own body carries the hint when
      // the listing could not be trusted, and a toast on every page mount would
      // be noise.
      await patchSiteProfiles(stream, context, EMPTY_NOTICE);
    },
  );
}

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/site-profiles/connect                                     */
/* -------------------------------------------------------------------------- */

/**
 * `?url=` wins, then the `cliSites.url` signal.
 *
 * Two inputs because there are two callers and they differ in kind: a row's
 * Reconnect button knows the address already and puts it on the link, while the
 * "connect another site" box holds a value the operator typed, which belongs in
 * a request body rather than in a URL. The precedence is stated rather than
 * discovered, exactly as `siteRequestOptions`' is.
 */
export function createSiteProfileConnectHandler(
  context: RouteContext,
): RouteHandler {
  return siteProfileRoute(
    context,
    "/_dashboard/site-profiles/connect",
    async (request, stream) => {
      // Read past the body for the same reason the provider routes do: an
      // unparseable body is a client that is not the dashboard's own page.
      const signals = await readSignals(request);
      const raw =
        (request.query.get("url") ?? "").trim() || parseCliSites(signals).url;
      // `normalizeSiteUrl` throws `usage_error` on anything the site CLI would
      // refuse, *before* the value can become an argv element, and it never puts
      // the raw string in the error.
      const site = normalizeSiteUrl(raw, context.environment, "--url");

      const outcome = await context.integration.connect(site.siteUrl);
      await patchSiteProfiles(
        stream,
        context,
        outcome.kind === "failed"
          ? danger(unavailableHint(outcome.reason))
          : { level: "ok", message: `Connected. ${site.siteUrl}` },
      );
    },
  );
}

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/site-profiles/logout                                      */
/* -------------------------------------------------------------------------- */

export function createSiteProfileLogoutHandler(
  context: RouteContext,
): RouteHandler {
  return siteProfileRoute(
    context,
    "/_dashboard/site-profiles/logout",
    async (request, stream) => {
      await readSignals(request);
      const name = requireName(request);
      const outcome = await context.integration.logoutProfile(name);
      await patchSiteProfiles(
        stream,
        context,
        noticeFor(
          outcome,
          `Signed out of ${name}.`,
          `The Novamira site CLI no longer holds ${name}.`,
        ),
      );
    },
  );
}

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/site-profiles/remove                                      */
/* -------------------------------------------------------------------------- */

export function createSiteProfileRemoveHandler(
  context: RouteContext,
): RouteHandler {
  return siteProfileRoute(
    context,
    "/_dashboard/site-profiles/remove",
    async (request, stream) => {
      await readSignals(request);
      const name = requireName(request);
      const outcome = await context.integration.removeProfile(name);
      await patchSiteProfiles(
        stream,
        context,
        noticeFor(
          outcome,
          `Removed ${name}.`,
          `The Novamira site CLI no longer holds ${name}.`,
        ),
      );
    },
  );
}
