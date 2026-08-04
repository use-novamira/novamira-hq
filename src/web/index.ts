// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web layer's public surface.
 *
 * `src/web/` is a peer of `src/cli/`, not a consumer of it: the dashboard runs
 * the same services the commands do — `ConfigStore`, `HostingClientFactory`,
 * `src/provisioning/` — with no commander, no `Renderer` and no `CommandIo` in
 * the graph. Nothing under `src/web/` may import `src/cli/`; `src/cli/` imports
 * this module, and only this module.
 *
 * Deliberately not re-exported: `unsafeRawHtml` (it has zero call sites outside
 * `html.ts` and should keep them), and every `@starfederation/datastar-sdk`
 * type (`sse.ts` is the one place the SDK is imported, and its wrapper is the
 * only shape that leaves).
 */

export {
  createDashboardServer,
  isLoopbackHost,
  parseListenAddress,
  requireLoopbackHost,
  type BoundAddress,
  type DashboardIntegration,
  type DashboardServer,
  type DashboardServerDependencies,
  type ListenAddress,
} from "./server.js";

export {
  createRouteTable,
  matchRoute,
  pageForPath,
  DEFERRED_ROUTES,
  PAGE_ROUTE_PATHS,
  type HttpMethod,
  type Route,
  type RouteAuth,
  type RouteContext,
  type RouteHandler,
  type RouteMatch,
} from "./routes.js";

export {
  htmlResponse,
  httpStatusFor,
  jsonFailure,
  jsonSuccess,
  ASSET_CACHE_CONTROL,
  HTML_CACHE_CONTROL,
  HTML_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  SECURITY_HEADERS,
  type DashboardResponse,
} from "./responses.js";

export {
  dashboardRequestFrom,
  isBodyTooLarge,
  readSignals,
  MAX_REQUEST_BODY_BYTES,
  type DashboardRequest,
} from "./request.js";

export {
  connCellId,
  SSE_PATCH_FRAGMENTS,
  type ConnCellId,
  type PatchFragment,
  type PatchMode,
  type PatchSelectorId,
  type StaticPatchSelectorId,
} from "./patches.js";

export {
  streamSse,
  type SseHandler,
  type SsePatchTarget,
  type SseStream,
  type SseStreamOptions,
} from "./sse.js";

export {
  serveAsset,
  ASSET_PREFIX,
  STATIC_ASSETS,
  STATIC_ROOT,
  type StaticAsset,
} from "./static.js";

export {
  defaultDashboardSignals,
  toSignalRecord,
  ALL_PROFILES_SENTINEL,
  type DashboardSignals,
  type SignalPath,
} from "./signals.js";

export {
  renderDocument,
  renderMain,
  renderNav,
  renderNotice,
  renderPlaceholderBody,
  renderSidebar,
  renderToast,
  type DocumentInput,
} from "./views/layout.js";

export {
  statusClass,
  DASHBOARD_PAGES,
  EMPTY_NOTICE,
  type ConfigView,
  type ConnectionQuery,
  type ConnectionResult,
  type ConnectionSnapshot,
  type ConnectionState,
  type ConnectionView,
  type DashboardNotice,
  type DashboardPage,
  type DeployPathView,
  type HostingProfileView,
  type NoticeLevel,
  type UnavailableReason,
} from "./views/types.js";

export { renderHtml, type Html } from "./html.js";
