// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The route table: which paths exist, which methods they take, and which of
 * them require the mutation token.
 *
 * **What the Go did.** `routes()` (server.go:150-170) registered fifteen
 * `mux.HandleFunc` entries against `http.ServeMux` and a catch-all `"/"` whose
 * handler re-derived the page with `dashboardPath()` and
 * `currentDashboardPage()`. Method checking, authorization and the 404 were each
 * repeated inside every handler — `if r.Method != http.MethodPost { writeError(…)
 * }` appears a dozen times — so a handler that forgot the check simply did not
 * have one.
 *
 * **What HQ does instead.** The table is data. Method, path, and auth policy are
 * declared per row; the dispatcher in `server.ts` enforces all three before a
 * handler runs, so a handler cannot forget. A handler is a pure function from
 * {@link DashboardRequest} to {@link DashboardResponse} and never touches
 * `IncomingMessage`, `ServerResponse` or the socket.
 *
 * **Deferred rows are declared, not stubbed.** {@link DEFERRED_ROUTES} lists the
 * paths 6b and Phase 7 will add, with the phase that owns them. They are *not*
 * registered: in 6a they 404 like any unknown path, because a stub returning
 * invented data is worse than an honest 404 — it looks like a working feature.
 * The route test asserts both that they 404 and that the list has not silently
 * grown, so 6b's diff is "move a row out of `DEFERRED_ROUTES` and into
 * `createRouteTable`".
 *
 * **Two rows are deleted for good.** `/_dashboard/sites/save` and
 * `/_dashboard/sites/remove` wrote WordPress site profiles, complete with an
 * Application Password, into Go's config. HQ has no site profiles and holds no
 * site credential; the routes are absent from the table and from
 * `DEFERRED_ROUTES`, and the conventions test asserts they appear nowhere.
 *
 * **Every `/_dashboard/*` row is `token`, including the GETs.** Go left
 * `/_dashboard/sites` unauthenticated. That GET reaches live provider APIs, so a
 * cross-origin `<img>` or `<script>` could burn an operator's provider rate
 * limit, and its response is patched straight into the DOM. See `server.ts` for
 * the guard itself.
 *
 * That last rule is checked rather than remembered: {@link createRouteTable}
 * refuses to build a table containing a `/_dashboard/` row whose `auth` is not
 * `"token"`, whether the row is one of the shipped ones or comes in through
 * `extraRoutes`. Otherwise the invariant would hold only for as long as every
 * future author typed `auth: "token"`, which is exactly the per-handler
 * discipline this table exists to replace — and 6b moves nine credential-writing
 * rows out of {@link DEFERRED_ROUTES}.
 */

import { CliError } from "../errors.js";
import { htmlResponse, type DashboardResponse } from "./responses.js";
import type { DashboardRequest } from "./request.js";
import { defaultDashboardSignals } from "./signals.js";
import { serveAsset } from "./static.js";
import { renderDocument, renderPlaceholderBody } from "./views/layout.js";
import {
  EMPTY_NOTICE,
  type ConfigView,
  type DashboardPage,
} from "./views/types.js";

export type HttpMethod = "GET" | "HEAD" | "POST";

export type RouteAuth = "public" | "token";

export type RouteHandler = (
  request: DashboardRequest,
) => Promise<DashboardResponse> | DashboardResponse;

export interface Route {
  readonly method: HttpMethod;
  /** An exact path, or a prefix when `prefix` is true. */
  readonly path: string;
  readonly prefix?: boolean;
  readonly auth: RouteAuth;
  readonly handler: RouteHandler;
}

/** What the page handlers need. The server builds it once per process. */
export interface RouteContext {
  /** Reads `config.json` and projects it into the view model. */
  loadConfigView: () => Promise<ConfigView>;
  /**
   * Extra rows, appended after the shipped ones.
   *
   * The only intended use is a contract test that needs a `token` route to
   * drive the guard with, because in 6a every real token route is still in
   * {@link DEFERRED_ROUTES}. Production passes none.
   */
  readonly extraRoutes?: readonly Route[];
}

/** The paths that exist but are not implemented yet, and who owns them. */
export const DEFERRED_ROUTES: readonly {
  readonly path: string;
  readonly phase: "6b" | "7";
}[] = Object.freeze([
  { path: "/_dashboard/providers/save", phase: "6b" },
  { path: "/_dashboard/providers/remove", phase: "6b" },
  { path: "/_dashboard/providers/validate", phase: "6b" },
  { path: "/_dashboard/sites", phase: "6b" },
  { path: "/_dashboard/deploy-paths/save", phase: "6b" },
  { path: "/_dashboard/deploy-paths/remove", phase: "6b" },
  { path: "/_dashboard/setup/start", phase: "6b" },
  { path: "/_dashboard/setup/jobs/", phase: "6b" },
  { path: "/_dashboard/connect", phase: "6b" },
  { path: "/_dashboard/diagnostics/doctor", phase: "7" },
  { path: "/_dashboard/diagnostics/capabilities", phase: "7" },
  { path: "/_dashboard/updates/check", phase: "7" },
  { path: "/_dashboard/updates/install", phase: "7" },
] as const);

const PAGE_PATHS: Readonly<Record<string, DashboardPage>> = {
  "/": "providers",
  "/providers": "providers",
  "/sites": "sites",
  "/deploy-paths": "deploy-paths",
  "/deploy-paths/new": "deploy-path-new",
  "/novamira-setup": "novamira-setup",
  "/diagnostics": "diagnostics",
  "/settings": "settings",
};

/** Go's `currentDashboardPage` (server.go:205-222); `/` is the providers page. */
export function pageForPath(path: string): DashboardPage | undefined {
  return Object.hasOwn(PAGE_PATHS, path) ? PAGE_PATHS[path] : undefined;
}

/** The paths a page is rendered for, in the order the route test walks them. */
export const PAGE_ROUTE_PATHS: readonly string[] = Object.freeze(
  Object.keys(PAGE_PATHS),
);

/**
 * Build the shipped table.
 *
 * `token` is not a parameter: the page handler reads it from the signals the
 * server built, and nothing else in the table needs it. That keeps the token out
 * of every closure that does not have to hold it.
 */
export function createRouteTable(
  context: RouteContext,
  token: string,
): readonly Route[] {
  const assetHandler: RouteHandler = async (request) => {
    const response = await serveAsset(
      request.path,
      request.method,
      request.headers["if-none-match"],
    );
    if (response === undefined) {
      throw new CliError("not_found", "No such dashboard asset.");
    }
    return response;
  };

  const pageHandler = (page: DashboardPage): RouteHandler => {
    return async (request) => {
      const view = await context.loadConfigView();
      // Go accepted `?new=host` and `?new=site`. The second opened the site
      // form, which no longer exists; an unknown value is ignored in silence
      // rather than turned into an error page, because the only way to send one
      // is a stale bookmark.
      const signals = defaultDashboardSignals(token, {
        openProviderForm: request.query.get("new") === "host",
      });
      return htmlResponse(
        renderDocument({
          page,
          view,
          signals,
          notice: EMPTY_NOTICE,
          body: renderPlaceholderBody(page),
        }),
      );
    };
  };

  const routes: Route[] = [
    {
      method: "GET",
      path: "/assets/",
      prefix: true,
      auth: "public",
      handler: assetHandler,
    },
    {
      method: "HEAD",
      path: "/assets/",
      prefix: true,
      auth: "public",
      handler: assetHandler,
    },
  ];
  for (const [path, page] of Object.entries(PAGE_PATHS)) {
    routes.push({
      method: "GET",
      path,
      auth: "public",
      handler: pageHandler(page),
    });
  }
  routes.push(...(context.extraRoutes ?? []));
  return Object.freeze(routes.map(requireTokenAuth));
}

/** The `/_dashboard/*` prefix everything mutating lives under. */
const GUARDED_PREFIX = "/_dashboard/";

/**
 * The one invariant the dispatcher cannot derive for itself.
 *
 * `matchRoute` and `dispatch` read the row's `auth`, so a `/_dashboard/` row
 * that forgot `auth: "token"` would simply be public and nothing would fail.
 * Here it is a build-time refusal instead: an unauthenticated guarded path is a
 * programming error, not a configuration.
 */
function requireTokenAuth(route: Route): Route {
  if (route.path.startsWith(GUARDED_PREFIX) && route.auth !== "token") {
    throw new CliError(
      "internal_error",
      `The dashboard route ${route.method} ${route.path} is under ${GUARDED_PREFIX} and must require the mutation token.`,
      { details: { path: route.path } },
    );
  }
  return route;
}

export type RouteMatch =
  { readonly route: Route } | { readonly allow: readonly string[] };

/**
 * Resolve a method and path against the table.
 *
 * `undefined` is "no such path" (404). An `allow` list is "that path exists,
 * that method does not" (405 plus an `Allow` header), which is the distinction
 * Go's per-handler `if r.Method != …` checks made by accident and inconsistently.
 */
export function matchRoute(
  table: readonly Route[],
  method: string,
  path: string,
): RouteMatch | undefined {
  const allow = new Set<string>();
  for (const route of table) {
    const matches =
      route.prefix === true ? path.startsWith(route.path) : path === route.path;
    if (!matches) {
      continue;
    }
    if (route.method === method) {
      return { route };
    }
    allow.add(route.method);
  }
  if (allow.size === 0) {
    return undefined;
  }
  return { allow: [...allow].sort() };
}
