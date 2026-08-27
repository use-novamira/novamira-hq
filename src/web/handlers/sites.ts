// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `GET /_dashboard/sites` — the site browser's one data route.
 *
 * **What the Go did.** `handleDashboardSites` (`server.go:335-396`) checked the
 * method, loaded the config, read `siteRequestOptions`, conditionally
 * re-unmarshalled the signals when `?datastar=` was present, resolved the
 * profile, hand-rolled the cache lookup and the store, and called
 * `patchSitesResult`. All of it in one function, and — this is the part HQ does
 * not port — **without an authorization check**. The route was public.
 *
 * **What HQ does instead.** The route is `auth: "token"` like every other
 * `/_dashboard/*` row, and `createRouteTable` refuses to build a table where it
 * is not. It is a `GET`, but it reaches live provider APIs and its answer is
 * patched straight into the DOM, so a cross-origin `<img src>` against an
 * unauthenticated version would burn an operator's provider rate limit from any
 * page they happened to have open. The cache, the profile walk and the
 * connected-state round all live in `services/sites.ts`; what is left here is
 * the option precedence and the patch set.
 *
 * **The option precedence is Go's, in Go's order** (`siteRequestOptions`,
 * `server.go:849-863`): the `sites` signal subtree first, then `?profile=`,
 * `?include_envs=` and `?refresh=` overriding it, then `?all=` forcing the
 * `__all__` sentinel. A `@get`'s signals arrive in `?datastar=`, not in the
 * body, which is what `readQuerySignals` exists for.
 *
 * **The patch set, in this order and no other** (Go's `patchSitesResult`,
 * `server.go:890-895`): `#sites-status` **inner**, `#sites-result` **outer**,
 * `#toast` **outer**. The modes are load-bearing rather than stylistic — see
 * `views/sites.ts` for the `MutationObserver` in the shipped filter script that
 * they are chosen for. This route never patches `#main` or `#nav`: repainting
 * the page would discard whatever the operator had typed into the search box.
 *
 * **A failure is a notice, never an envelope.** The browser is waiting for a
 * patch stream; a JSON failure would leave it with nothing on screen. So the
 * handler catches, sends the same three fragments with the error's *message*
 * in `#sites-result`, clears the toast so the sentence appears once, and routes
 * the `code` to `onDiagnostic`. Successful actions do the inverse: the refreshed
 * inventory stays in `#sites-result` and the message appears only in the toast.
 * `details` reach nothing: `failureEnvelope`'s `redact()` runs on the JSON path
 * only.
 */

import { asCliError } from "../../errors.js";
import { patchToast } from "../patch.js";
import type { DashboardRequest } from "../request.js";
import type { DashboardResponse } from "../responses.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import { parseSiteBrowser, readQuerySignals } from "../signals-input.js";
import { ALL_PROFILES_SENTINEL } from "../signals.js";
import type { SitesResult } from "../services/sites.js";
import type { SseStream } from "../sse.js";
import { renderSitesResult, renderSitesStatus } from "../views/sites.js";
import { EMPTY_NOTICE, type DashboardNotice } from "../views/types.js";

/** Go's `parseBool` (`server.go:1993-2000`), the same four spellings. */
function parseBoolean(value: string | null): boolean {
  if (value === null) return false;
  switch (value.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

export interface SiteRequestOptions {
  readonly profile: string;
  readonly includeEnvs: boolean;
  readonly refresh: boolean;
}

/**
 * Go's `siteRequestOptions`, with the signals read from the query string.
 *
 * Exported so a contract test can pin the precedence without driving a whole
 * request; the handler is its only production caller.
 */
export function siteRequestOptions(
  request: DashboardRequest,
): SiteRequestOptions {
  const browser = parseSiteBrowser(readQuerySignals(request));
  let profile =
    browser.profile === "" ? ALL_PROFILES_SENTINEL : browser.profile;
  const queryProfile = (request.query.get("profile") ?? "").trim();
  if (queryProfile !== "") profile = queryProfile;
  if (parseBoolean(request.query.get("all"))) profile = ALL_PROFILES_SENTINEL;

  const includeEnvs = request.query.has("include_envs")
    ? parseBoolean(request.query.get("include_envs"))
    : browser.includeEnvs;

  return {
    profile,
    includeEnvs,
    refresh: parseBoolean(request.query.get("refresh")),
  };
}

/**
 * The three fragments, always in this order.
 *
 * Exported because `/_dashboard/connect` sends exactly the same set after a
 * successful login — one sequence, one place, so the two routes cannot drift
 * into patching the same elements in different modes.
 */
export function patchSites(
  stream: SseStream,
  options: SiteRequestOptions,
  result: SitesResult | undefined,
  notice: DashboardNotice,
): void {
  // A successful action keeps the inventory visible and reports through the
  // global toast. A page-level listing failure has no inventory to show, so it
  // occupies `#sites-result` and leaves the toast quiet. Never render one
  // message in both places.
  const inlineNotice = result === undefined ? notice : EMPTY_NOTICE;
  const toastNotice = result === undefined ? EMPTY_NOTICE : notice;
  stream.patchElements(renderSitesStatus(result?.storedAt ?? null), {
    selectorId: "sites-status",
    mode: "inner",
  });
  stream.patchElements(
    renderSitesResult({
      profile: options.profile,
      includeEnvs: options.includeEnvs,
      groups: result?.groups ?? [],
      connections: result?.connections ?? null,
      siteProfiles: result?.siteProfiles ?? null,
      notice: inlineNotice,
    }),
    { selectorId: "sites-result", mode: "outer" },
  );
  patchToast(stream, toastNotice);
}

export function createSitesHandler(context: RouteContext): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      // Parsed before the try so a failure to read the options still knows what
      // to render the (empty) result under.
      let options: SiteRequestOptions = {
        profile: ALL_PROFILES_SENTINEL,
        includeEnvs: true,
        refresh: false,
      };
      try {
        options = siteRequestOptions(request);
        const result = await context.sites.list(options);
        patchSites(stream, options, result, EMPTY_NOTICE);
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/sites",
          code: cliError.code,
        });
        patchSites(stream, options, undefined, {
          level: "danger",
          message: cliError.message,
        });
      }
      stream.close();
    },
  });
}
