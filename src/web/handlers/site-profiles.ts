// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The four `/_dashboard/site-profiles/*` routes: connect, rename, sign out and
 * forget profiles held by the site CLI.
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
 * Each successful handler refreshes site-CLI state against the warm hosting
 * groups, then patches `#sites-status`, `#sites-result`, and `#toast`. If no
 * warm provider inventory exists, it patches only the toast:
 *
 * - repainting `#main` would discard whatever the operator had typed into the
 *   search box at the top of the Sites page;
 * - repainting `#sites-result` does not re-list hosting providers: the handlers
 *   use the warm five-minute listing and refresh only local site-CLI state;
 *
 * **Each mutating route re-lists before it patches.** The alternative — patch an
 * optimistic row and trust it — would show "Removed" for a profile the site CLI
 * still holds when the child failed halfway. One extra `sites list` is cheap
 * (it is local and makes no network request) and it is the only way the panel
 * can be a report of what `novamira` actually holds rather than of what HQ
 * hoped it would.
 *
 * **Inputs are validated before they can reach an argv array.** A URL
 * goes through `normalizeSiteUrl` — the same normalizer `hosting novamira setup`
 * and `/_dashboard/connect` use, which refuses userinfo, a query string, a
 * fragment and a non-loopback `http://` origin, and never echoes the raw value
 * into an error. A profile name goes through {@link isSiteProfileName}, whose
 * leading-character rule is what stops a `--json` in that position from running
 * a different command than the one HQ meant. Rename validates both names and
 * requires them to differ. A rejected value is a `usage_error`
 * toast and **nothing is spawned**.
 *
 * **Child output never reaches the page.** `SiteProfileOutcome`'s failure arm
 * carries an `UnavailableReason` and has nowhere to put a string, so a toast can
 * only ever show `unavailableHint(reason)` — a fixed sentence from a closed set.
 * The copyable command an operator needs when that sentence says "install the
 * site CLI" is already in each button's `title`.
 */

import { unavailableHint } from "../../connection-state.js";
import { randomUUID } from "node:crypto";
import { asCliError, CliError } from "../../errors.js";
import { normalizeSiteUrl } from "../../provisioning/index.js";
import { isSiteProfileName } from "../../site-profiles.js";
import type { SiteProfileOutcome } from "../../site-profiles.js";
import { patchPage, patchToast } from "../patch.js";
import { readSignals } from "../request.js";
import type { DashboardRequest } from "../request.js";
import type { DashboardResponse } from "../responses.js";
import { jsonSuccess, jsonFailure } from "../responses.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import { parseCliSites } from "../signals-input.js";
import { parseSiteBrowser } from "../signals-input.js";
import { parseSiteProfileRename } from "../signals-input.js";
import { defaultDashboardSignals } from "../signals.js";
import type { SseStream } from "../sse.js";
import { EMPTY_NOTICE, type DashboardNotice } from "../views/types.js";
import { patchSites } from "./sites.js";

function danger(message: string): DashboardNotice {
  return { level: "danger", message };
}

function listOptions(
  request: DashboardRequest,
  signals: Readonly<Record<string, unknown>>,
) {
  const sites = parseSiteBrowser(signals);
  return {
    profile: (request.query.get("profile") ?? "").trim() || sites.profile,
    includeEnvs: request.query.has("include_envs")
      ? request.query.get("include_envs") !== "false"
      : sites.includeEnvs,
    refresh: false,
  };
}

async function patchDestination(
  request: DashboardRequest,
  signals: Readonly<Record<string, unknown>>,
  stream: SseStream,
  context: RouteContext,
  notice: DashboardNotice,
): Promise<void> {
  const options = listOptions(request, signals);
  const warm = await context.sites.refreshWarm(
    options.profile,
    options.includeEnvs,
  );
  if (warm === undefined) {
    patchToast(stream, notice);
    return;
  }
  patchSites(stream, options, warm, notice);
}

/**
 * The two fragments, always in this order and always both.
 *
 * Exported for the same reason `patchSites` is: four routes send exactly this
 * pair, and a fifth spelling would be a route that patched the same element in
 * a different mode.
 */
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
        patchToast(stream, danger(cliError.message));
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
    case "rejected":
      return danger(
        "The Novamira site CLI rejected that rename. The new name may already be in use, or the installed CLI may need updating.",
      );
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
/* POST /_dashboard/site-profiles/connect                                     */
/* -------------------------------------------------------------------------- */

/**
 * `?url=` wins, then the `cliSites.url` signal. A row also carries `?name=` so
 * reconnecting updates that exact profile instead of creating a new one from
 * the URL-derived default name.
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

      const name =
        (request.query.get("name") ?? "").trim() || parseCliSites(signals).name;
      if (name !== "" && !isSiteProfileName(name)) {
        throw new CliError(
          "usage_error",
          "A Novamira site profile name must start with a letter or digit and may contain only letters, digits, '.', '_' and '-'.",
        );
      }
      patchToast(stream, {
        level: "neutral",
        message:
          "Starting authorization… Complete the authorization in your browser when it opens. This may take a few minutes; do not click Reconnect again.",
      });
      const outcome = await context.integration.connect(
        site.siteUrl,
        name === "" ? undefined : name,
      );
      const reconnecting = (request.query.get("url") ?? "").trim() !== "";
      if (outcome.kind === "connected" && !reconnecting) {
        const options = listOptions(request, signals);
        await context.sites.refreshWarm(options.profile, options.includeEnvs);
        const view = await context.loadConfigView();
        patchPage(stream, {
          page: "sites",
          notice: EMPTY_NOTICE,
          model: {
            view,
            notice: EMPTY_NOTICE,
            signals: defaultDashboardSignals(context.token),
            siteConnectSuccess: {
              siteUrl: site.siteUrl,
              ...(name === "" ? {} : { profileName: name }),
            },
          },
          signals: {
            cliSites: { open: false, url: "", name: "", loading: false },
          },
        });
        return;
      }
      await patchDestination(
        request,
        signals,
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
  const streamHandler = siteProfileRoute(
    context,
    "/_dashboard/site-profiles/logout",
    async (request, stream) => {
      const signals = await readSignals(request);
      const name = requireName(request);
      const outcome = await context.integration.logoutProfile(name);
      await patchDestination(
        request,
        signals,
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
  return async (request) => {
    if (request.query.get("response") !== "json") return streamHandler(request);
    try {
      const name = requireName(request);
      const outcome = await context.integration.logoutProfile(name);
      if (outcome.kind !== "done" && outcome.kind !== "missing") {
        throw new CliError(
          "internal_error",
          "Access could not be disconnected. Check the site's access before trying again.",
        );
      }
      return jsonSuccess({ disconnected: true }, { requestId: randomUUID() });
    } catch (error) {
      return jsonFailure(asCliError(error));
    }
  };
}

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/site-profiles/rename                                      */
/* -------------------------------------------------------------------------- */

export function createSiteProfileRenameHandler(
  context: RouteContext,
): RouteHandler {
  return siteProfileRoute(
    context,
    "/_dashboard/site-profiles/rename",
    async (request, stream) => {
      const signals = await readSignals(request);
      const name = requireName(request);
      const newName = parseSiteProfileRename(signals, name);
      if (!isSiteProfileName(newName)) {
        throw new CliError(
          "usage_error",
          "A Novamira site profile name must start with a letter or digit and may contain only letters, digits, '.', '_' and '-'.",
        );
      }
      if (newName === name) {
        throw new CliError(
          "usage_error",
          "The new Novamira site profile name must differ from the current name.",
        );
      }
      const outcome = await context.integration.renameProfile(name, newName);
      await patchDestination(
        request,
        signals,
        stream,
        context,
        noticeFor(
          outcome,
          `Renamed ${name} to ${newName}.`,
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
      const signals = await readSignals(request);
      const name = requireName(request);
      const outcome = await context.integration.removeProfile(name);
      await patchDestination(
        request,
        signals,
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
