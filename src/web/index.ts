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
  type DashboardDoctor,
  type DashboardIntegration,
  type DashboardUpdates,
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
  type DeferredRoute,
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
  parseDeployForm,
  parseDiagnostics,
  parseProviderForm,
  parseSetup,
  parseSiteBrowser,
  readQuerySignals,
  MAX_QUERY_SIGNAL_BYTES,
  type DeployFormInput,
  type DiagnosticsInput,
  type ProviderFormInput,
  type SetupInput,
  type SiteBrowserInput,
} from "./signals-input.js";

export { patchPage, patchToast, type PagePatch } from "./patch.js";

export {
  createDeployPathService,
  createProviderService,
  createSetupJobService,
  createSitesService,
  connectionFor,
  connectionKey,
  MAX_EVENTS,
  MAX_JOBS,
  SITES_CACHE_TTL_MS,
  type DeployPathService,
  type EnvResolver,
  type ProviderMutation,
  type ProviderService,
  type ProviderServiceOptions,
  type SetupJobEvent,
  type SetupJobService,
  type SetupJobSnapshot,
  type SetupJobStatus,
  type SiteGroup,
  type SitesResult,
  type SitesService,
} from "./services/index.js";

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
  assertSignalPath,
  connCheckingSignal,
  defaultDashboardSignals,
  defaultDeployFormSignals,
  defaultProviderFormSignals,
  dynamicSignalPath,
  providerDetailsSignal,
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
  renderSidebar,
  renderToast,
  type DocumentInput,
} from "./views/layout.js";

export { renderPageBody, type PageModel } from "./views/pages.js";

export {
  pageConnState,
  renderConnCell,
  renderProviderFlash,
  renderProviderForm,
  renderProvidersPage,
  renderProviderRow,
  renderProviderTable,
  type ProviderConnState,
  type ProvidersPageModel,
} from "./views/providers.js";

export {
  renderSitesPage,
  renderSitesResult,
  renderSitesStatus,
  type SitesResultView,
} from "./views/sites.js";

export {
  deployPathsStatusLine,
  deployPushesSummary,
  renderDeployPathNewPage,
  renderDeployPathsPage,
  type DeployNewView,
  type WarmSitesView,
} from "./views/deploy-paths.js";

export {
  renderDiagnosticsOutput,
  renderDiagnosticsPage,
} from "./views/diagnostics.js";

export {
  createDiagnosticsCapabilitiesHandler,
  createDiagnosticsDoctorHandler,
  patchDiagnosticsOutput,
} from "./handlers/diagnostics.js";

export {
  initialUpdateCardView,
  renderSettingsPage,
  renderUpdateCard,
  type UpdateCardView,
} from "./views/settings.js";

export {
  createUpdateCheckHandler,
  createUpdateInstallHandler,
  patchUpdateCard,
} from "./handlers/updates.js";

export {
  humanizeSetupError,
  renderSetupPage,
  renderSetupWork,
  renderSetupWorkBody,
  setupViewForJob,
  type SetupView,
} from "./views/setup.js";

export {
  parseSetupJobPath,
  SETUP_JOBS_PREFIX,
  SETUP_POLL_MS,
} from "./handlers/setup.js";

export {
  connectionView,
  deployPathView,
  deployPushSupported,
  hostingProfileView,
  providerLabelFor,
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
