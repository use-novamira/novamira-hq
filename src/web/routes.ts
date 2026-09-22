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
 * paths a later phase will add, with the phase that owns them. They are *not*
 * registered: they 404 like any unknown path, because a stub returning invented
 * data is worse than an honest 404 — it looks like a working feature. The route
 * test asserts both that they 404 and that the list has not silently grown, so a
 * phase's diff is "move a row out of `DEFERRED_ROUTES` and into
 * `createRouteTable`". 6b emptied the list of its own rows, 7-1 of the two
 * diagnostics rows, and 7-2 of the last two, the `src/update/` pair — so the
 * list is now empty and the dashboard's route surface is complete.
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
 * discipline this table exists to replace.
 *
 * **The token is on the context now.** 6a's comment here said "`token` is not a
 * parameter", and that stopped being true the moment a handler had to *render a
 * page*: `patchPage` builds the root signal object, which carries the token, so
 * the provider handlers need it and 6b-2's and 6b-3's will too. It is a field on
 * {@link RouteContext} rather than a second positional argument so that a
 * handler factory takes one thing, and so that adding a service to the record
 * stays a one-line diff for the batch that adds it.
 */

import { PROVIDER_KINDS, isProviderKind } from "../config/schema.js";
import { createHostingToolsHandler } from "./handlers/hosting-tools.js";
import { createRestoreHandler } from "./handlers/restore.js";
import { isMcpPageClient } from "./views/mcp.js";
import { CliError } from "../errors.js";
import {
  createMcpBundleHandler,
  createMcpConnectHandler,
  createMcpVerifyHandler,
} from "./handlers/mcp.js";
import { createAcknowledgementHandler } from "./handlers/acknowledgement.js";
import { renderAcknowledgement } from "./views/acknowledgement.js";
import type { HistoryStore } from "../history/index.js";
import { createConnectHandler } from "./handlers/connect.js";
import { normalizeSiteUrl } from "../provisioning/site-url.js";
import {
  createPushRemoveHandler,
  createPushSaveHandler,
  createPushExecutionHandler,
  createPushStatusHandler,
} from "./handlers/pushes.js";
import {
  createDiagnosticsCapabilitiesHandler,
  createDiagnosticsDoctorHandler,
} from "./handlers/diagnostics.js";
import {
  createProviderRemoveHandler,
  createProviderSaveHandler,
  createProviderValidateHandler,
} from "./handlers/providers.js";
import {
  createSetupJobHandler,
  createSetupStartHandler,
  SETUP_JOBS_PREFIX,
} from "./handlers/setup.js";
import {
  createSiteProfileConnectHandler,
  createSiteProfileLogoutHandler,
  createSiteProfileRenameHandler,
  createSiteProfileRemoveHandler,
} from "./handlers/site-profiles.js";
import { createSitesHandler } from "./handlers/sites.js";
import { createProHandler } from "./handlers/pro.js";
import { createAgentSetupHandler } from "./handlers/agent-setup.js";
import {
  createUpdateCheckHandler,
  createUpdateInstallHandler,
} from "./handlers/updates.js";
import { htmlResponse, type DashboardResponse } from "./responses.js";
import type { DashboardRequest } from "./request.js";
import type { PushService } from "./services/pushes.js";
import type { ProviderService } from "./services/providers.js";
import type { SetupJobService } from "./services/setup-jobs.js";
import type { SitesService } from "./services/sites.js";
// Type-only, and it stays type-only: `server.ts` imports this module at
// runtime, so a value import here would close a cycle. `DashboardIntegration`
// is declared there because that is where the dependency record lives.
import type { DashboardIntegration, DashboardUpdates } from "./server.js";
import { defaultDashboardSignals, ALL_PROFILES_SENTINEL } from "./signals.js";
import { serveAsset } from "./static.js";
import { renderDocument } from "./views/layout.js";
import { renderPageBody, type PageModel } from "./views/pages.js";
import { setupViewForJob } from "./views/setup.js";
import {
  EMPTY_NOTICE,
  type ConfigView,
  type DashboardNotice,
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

/**
 * The dashboard's dependency record. `server.ts` builds it once per process.
 *
 * It grew one field per 6b batch: 6b-2 added `sites`, `pushes`,
 * `integration` and `environment`; 6b-3 added `setupJobs` and `setupPollMs`.
 * Keep it a flat list so a future batch's diff does not collide.
 */
export interface RouteContext {
  readonly agentSetup?: import("../agent-connection.js").AgentSetupService;
  readonly pro?: import("../pro/service.js").ProService;
  readonly hostingTools?: import("./services/hosting-tools.js").HostingToolsService;
  readonly restore?: import("./services/restore.js").RestoreService;
  readonly appAcknowledgement?: import("../config/app-acknowledgement.js").AppAcknowledgement;
  readonly pushExecution?: import("./services/push-execution.js").PushExecutionService;
  readonly mcpConnection?: import("../mcp-connection.js").McpConnectionService;
  readonly history: Pick<HistoryStore, "list">;
  /** Reads `config.json` and projects it into the view model. */
  loadConfigView: () => Promise<ConfigView>;
  /**
   * HQ's own version.
   *
   * The update card's failure path needs a "current version" to render when the
   * registry could not be reached, and reading `config.json` to find one — the
   * only other place the version is available to a handler — would be a
   * filesystem round trip on an error path for a value this process has known
   * since it started.
   */
  readonly version: string;
  /**
   * The doctor report the Diagnostics page renders.
   *
   * Declared as a function returning `unknown` because `src/web/` may not import
   * `src/doctor/`; `src/cli/dashboard.ts` supplies the real one, bound to
   * `{ offline: true, fix: false }`. The handler only stringifies it, so
   * `unknown` is not a widening — it is the whole truth about what this layer
   * knows.
   */
  readonly doctor: () => Promise<unknown>;
  /**
   * The Settings page's update card: check the registry, install what it found.
   *
   * Declared on `server.ts` as {@link DashboardUpdates} and supplied by
   * `src/cli/dashboard.ts`, because `src/web/` may not import `src/update/`
   * either. It is the only thing on this dashboard that reaches a network other
   * than a provider API — the diagnostics route is bound to `--offline`
   * precisely so that this stays true.
   */
  readonly updates: DashboardUpdates;
  /**
   * The per-process mutation token.
   *
   * Handlers need it because rendering a page means rendering the root
   * `data-signals` object, which is the token's one and only appearance in the
   * dashboard's output.
   */
  readonly token: string;
  /** The clock, for check stamps and cache TTLs. */
  readonly now: () => number;
  /** Provider-profile mutation and the `lastChecked` map. */
  readonly providers: ProviderService;
  /** Provider site inventory, its five-minute cache, and connected state. */
  readonly sites: SitesService;
  /** Saved-push validation and persistence. */
  readonly pushes: PushService;
  /** The Novamira-setup job registry and its `provisionNovamira` runner. */
  readonly setupJobs: SetupJobService;
  /**
   * How long `/_dashboard/setup/jobs/<id>/stream` waits between renders, in
   * milliseconds. Defaults to Go's one second; a contract test shortens it so a
   * job that finishes between two ticks can be observed without waiting.
   */
  readonly setupPollMs?: number;
  /**
   * Connected-state detection and the Connect action.
   *
   * `/_dashboard/connect` needs `connect`; `services/sites.ts` was given
   * `connectionStates` at construction. Both are on one record because
   * `src/cli/dashboard.ts` builds one service.
   */
  readonly integration: DashboardIntegration;
  /**
   * The injected process environment.
   *
   * The spec's context list omitted it, and then `/_dashboard/connect` needed
   * it: `normalizeSiteUrl` reads `NOVAMIRA_HQ_ALLOW_INSECURE_HTTP` from a record
   * rather than from `process.env`, which is what lets a contract test exercise
   * the opt-in without mutating the process it runs in. Nothing under
   * `src/web/` reads `process.env`.
   */
  readonly environment: NodeJS.ProcessEnv;
  /** Diagnostics sink. A handler routes an error `code` here, never to the page. */
  readonly onDiagnostic?: (label: string, payload: unknown) => void;
  /**
   * Extra rows, appended after the shipped ones. The only intended use is a
   * contract test that needs a route of its own to drive a guard with.
   * Production passes none.
   */
  readonly extraRoutes?: readonly Route[];
}

export interface DeferredRoute {
  readonly path: string;
  /** The batch that owns the row, for the route test's message. */
  readonly phase: string;
}

/**
 * The paths that exist but are not implemented yet, and who owns them.
 *
 * **It is empty, and that is the end state, not an omission.** 6b emptied it of
 * its own nine rows, 7-1 of the two diagnostics rows, and 7-2 of the last two —
 * `/_dashboard/updates/{check,install}` — together with `src/update/`, the
 * Settings page's card and the `updates-card` catalog row. Every path the
 * dashboard answers is in {@link createRouteTable}; every path it does not
 * answer is a `404`.
 *
 * The mechanism stays because it is how a future phase declares intent: add a
 * row here, and the route conventions test asserts it `404`s and that the
 * shipped table has not silently grown a path nobody listed. A stub returning
 * invented data would be worse than an honest `404` — it looks like a working
 * feature. The test does **not** become vacuous with an empty list: it pins the
 * shipped table's exact method-and-path surface, so a new route has to be
 * declared in the contract document and in the test before it can ship.
 */
export const DEFERRED_ROUTES: readonly DeferredRoute[] = Object.freeze([]);

const PAGE_PATHS: Readonly<Record<string, DashboardPage>> = {
  "/about": "about",
  "/": "providers",
  "/providers": "providers",
  "/hosting-accounts": "providers",
  "/sites": "sites",
  "/how-to-use": "how-to-use",
  "/push": "pushes",
  "/backup-restore": "sites",
  "/backup-create": "sites",
  "/hosting-tools": "sites",
  "/push/new": "push-new",
  "/novamira-setup": "novamira-setup",
  "/diagnostics": "diagnostics",
  "/settings": "settings",
  "/novamira-pro": "novamira-pro",
  "/updates": "updates",
  "/history": "history",
  "/hosting-activity": "history",
  "/mcp": "mcp",
  "/configure-ai": "mcp",
};

/**
 * Go's `currentDashboardPage` (server.go:205-222). `/` starts from the
 * providers page id, then `pageHandler` resolves it to onboarding or Sites
 * after checking both inventories.
 */
export function pageForPath(path: string): DashboardPage | undefined {
  return Object.hasOwn(PAGE_PATHS, path) ? PAGE_PATHS[path] : undefined;
}

/** The paths a page is rendered for, in the order the route test walks them. */
export const PAGE_ROUTE_PATHS: readonly string[] = Object.freeze(
  Object.keys(PAGE_PATHS),
);

/** Build the shipped table. */
/** Serves a dashboard asset, or reports that there is no such asset. */
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

/**
 * The per-page extras, read from process-local state only.
 *
 * Neither push page may trigger a provider call — Go's did not either
 * (`server.go:782`, `:931`) — so both of those are `Map` lookups that return
 * "we have not looked yet" rather than going and looking, and the setup page
 * is a lookup in the job registry. An absent value is a state each renderer
 * has words for, not a hole to fill with invented data.
 *
 * A returned `notice` is the page-load notice — currently only "Setup job not
 * found." — and reaches both the toast and the model. Everything else is a
 * `PageModel` field.
 */
function pageExtras(
  context: RouteContext,
  page: DashboardPage,
  request: DashboardRequest,
): Partial<PageModel> {
  if (request.path === "/backup-restore" || request.path === "/backup-create") {
    const id = request.query.get("job");
    const job = id ? context.restore?.snapshot(id) : undefined;
    return {
      restore: {
        create:
          request.path === "/backup-create" &&
          (!job || job.review.operation === "create"),
        target: {
          profile: request.query.get("profile") ?? "",
          site: request.query.get("site") ?? "",
          env: request.query.get("env") ?? "",
        },
        ...(job ? { job } : {}),
        ...(id && !job
          ? {
              error:
                "This job is no longer available in this session. Check Activity and the hosting provider before retrying.",
            }
          : {}),
        jobs: context.restore?.list() ?? [],
      },
    };
  }
  if (page === "settings") {
    const tab = request.query.get("tab");
    return {
      settingsTab:
        tab === "uninstall" || tab === "pro" || tab === "agents"
          ? tab
          : "general",
    };
  }
  if (page === "updates") {
    return {
      updatesAvailable: context.updates.available !== false,
      desktopUpdates: context.updates.desktop === true,
    };
  }
  if (page === "pushes") {
    const warm = context.sites.warm(ALL_PROFILES_SENTINEL, true);
    const jobId = request.query.get("job");
    const job = jobId ? context.pushExecution?.snapshot(jobId) : undefined;
    return {
      ...(job ? { pushJob: job } : {}),
      ...(jobId && !job
        ? {
            notice: {
              level: "warn" as const,
              message:
                "This job was not found in saved history. Check History and your hosting provider before retrying.",
            },
          }
        : {}),
      pushJobs: context.pushExecution?.list() ?? [],
      pushHistory: request.query.get("view") === "history",
      pushes: {
        groups: warm?.groups ?? [],
        cacheWarm: warm !== undefined,
      },
    };
  }
  if (page === "push-new") {
    const warm = context.sites.warm(ALL_PROFILES_SENTINEL, true);
    const profile = (request.query.get("profile") ?? "").trim();
    const siteId = (request.query.get("site") ?? "").trim();
    const site = context.sites.resolveSite(profile, siteId);
    const requestedSource = (request.query.get("source") ?? "").trim();
    const sourceEnvId = site?.envs.some(
      (environment) => environment.id === requestedSource,
    )
      ? requestedSource
      : "";
    const requestedTarget = (request.query.get("target") ?? "").trim();
    const targetEnvId =
      sourceEnvId !== "" &&
      requestedTarget !== sourceEnvId &&
      site?.envs.some((environment) => environment.id === requestedTarget)
        ? requestedTarget
        : sourceEnvId !== "" && site?.envs.length === 2
          ? (site.envs.find((environment) => environment.id !== sourceEnvId)
              ?.id ?? "")
          : "";
    return {
      pushes: { cacheWarm: warm !== undefined, groups: warm?.groups ?? [] },
      pushNew: {
        profile,
        siteId,
        // Go fell back to the raw site id so the page still names its target
        // when the cache is cold (`server.go:926`).
        siteLabel: site?.label ?? siteId,
        envs: site?.envs ?? [],
        sourceEnvId,
        targetEnvId,
      },
    };
  }
  if (page === "mcp") {
    const client = request.query.get("client");
    return isMcpPageClient(client) ? { mcpClient: client } : {};
  }
  if (page === "novamira-setup") {
    return setupExtras(context, request);
  }
  return {};
}

/**
 * Go's `setupViewFromRequest` (`server.go:959-983`), minus `?siteprofile=`
 * and `?replace=`, which went with the site-profile surface — and with them
 * the "running job only" branch, which existed solely to keep a replace from
 * attaching to a finished install.
 *
 * The precedence is Go's: an explicit `?job=` wins, then the latest job for
 * `(profile, env)`, then a fresh view built from the link's four values.
 */
function setupExtras(
  context: RouteContext,
  request: DashboardRequest,
): Partial<PageModel> {
  const query = (name: string): string =>
    (request.query.get(name) ?? "").trim();
  const profile = query("profile");
  const envId = query("env");
  const labels = { siteLabel: query("site"), envName: query("envname") };

  const jobId = query("job");
  if (jobId !== "") {
    const job = context.setupJobs.snapshot(jobId);
    if (job === undefined) {
      const notice: DashboardNotice = {
        level: "danger",
        message: "Setup job not found.",
      };
      return {
        notice,
        setup: { profile, envId, ...labels, jobId, job: null },
      };
    }
    return { setup: setupViewForJob(job, labels) };
  }

  if (profile !== "" && envId !== "") {
    const job = context.setupJobs.latestForTarget(profile, envId);
    if (job !== undefined) return { setup: setupViewForJob(job, labels) };
  }
  return { setup: { profile, envId, ...labels, jobId: "", job: null } };
}

function pageHandler(context: RouteContext, page: DashboardPage): RouteHandler {
  return async (request) => {
    const view = await context.loadConfigView();
    const reviewNotice = request.query.get("review-notice") === "1";
    if (
      reviewNotice ||
      (context.appAcknowledgement &&
        !(await context.appAcknowledgement.accepted()))
    ) {
      const signals = defaultDashboardSignals(context.token);
      return htmlResponse(
        renderDocument({
          automaticUpdates: context.updates.automatic === true,
          page,
          view,
          signals,
          notice: EMPTY_NOTICE,
          activeNav: false,
          body: renderAcknowledgement(reviewNotice),
        }),
      );
    }
    let renderedPage = page;
    if (page === "pushes") await context.pushExecution?.refresh(false);
    // Existing bookmarks still reach the dedicated page, with Updates active.
    if (page === "settings" && request.query.get("tab") === "updates") {
      renderedPage = "updates";
    }
    let providerOnboarding = false;
    if (request.path === "/") {
      if (view.profiles.length === 0) {
        // The site CLI's own list, asked directly rather than through the
        // sites service: the question is "has this operator configured
        // anything at all", and a warm hosting inventory cannot answer it.
        const listing = await context.integration.listProfiles();
        providerOnboarding = listing.profiles.length === 0;
      }
      if (!providerOnboarding) renderedPage = "sites";
    }
    // Go accepted `?new=host` and `?new=site`. The second opened the site
    // form, which no longer exists; an unknown value is ignored in silence
    // rather than turned into an error page, because the only way to send one
    // is a stale bookmark.
    let cliSiteUrl = "";
    if (page === "sites" && request.query.get("new") === "cli") {
      const candidate = request.query.get("site_url");
      if (candidate && candidate.length <= 2048) {
        try {
          cliSiteUrl = normalizeSiteUrl(candidate, {}, "--url").siteUrl;
        } catch {
          /* Never reflect invalid URLs or embedded credentials. */
        }
      }
    }
    const signals = defaultDashboardSignals(context.token, {
      cliSiteUrl,
      openProviderForm: request.query.get("new") === "host",
      openCliSiteForm: request.query.get("new") === "cli",
      // Go's `defaultProviderFormSignals` preselected `providerKinds()[0]`,
      // so the provider `<select>`, the metadata expressions and the reset
      // expression all start on the same kind.
      firstProviderKind: PROVIDER_KINDS[0],
    });
    const extras = pageExtras(context, renderedPage, request);
    if (
      context.agentSetup &&
      (request.path === "/" || renderedPage === "settings")
    ) {
      try {
        const agentSetup = await context.agentSetup.view();
        if (request.path === "/" && agentSetup.firstRun) {
          renderedPage = "settings";
          Object.assign(extras, { settingsTab: "agents" });
        }
        Object.assign(extras, { agentSetup });
      } catch {
        // Setup failure must not prevent access to the hosting dashboard.
        Object.assign(extras, {
          agentSetupError:
            "Agent setup is unavailable. Check local directory permissions and reload Settings to retry.",
        });
      }
    }
    if (request.path === "/hosting-tools") {
      const profile = request.query.get("profile") ?? "";
      const provider = view.profiles.find(
        (entry) => entry.name === profile,
      )?.provider;
      Object.assign(extras, {
        hostingTools: {
          target: {
            profile,
            site: request.query.get("site") ?? "",
            env: request.query.get("env") ?? "",
          },
          ...(provider && isProviderKind(provider) ? { provider } : {}),
        },
      });
    }
    const actionProfile = request.query.get("actions");
    if (renderedPage === "providers" && actionProfile !== null) {
      const profile = view.profiles.find(
        (profile) => profile.name === actionProfile,
      );
      if (!profile)
        throw new CliError("not_found", "Hosting account not found.");
      let capabilities: unknown;
      try {
        capabilities = await context.providers.capabilities(profile.name);
      } catch {
        // Do not expose credential references or adapter diagnostics here.
        capabilities = undefined;
      }
      Object.assign(extras, {
        providerActions: {
          profile: profile.name,
          provider: profile.provider,
          capabilities,
        },
      });
    }
    // The extras go first so the three fields every page must have cannot be
    // overwritten by one, and so the notice reaching the toast and the notice
    // reaching the body are one value.
    const notice = extras.notice ?? EMPTY_NOTICE;
    const sitesSnapshot =
      renderedPage === "sites"
        ? context.sites.snapshot(ALL_PROFILES_SENTINEL, true)
        : undefined;
    const model: PageModel = {
      ...((renderedPage === "settings" || renderedPage === "novamira-pro") &&
      context.pro
        ? {
            pro: await context.pro.view(request.query.get("site") ?? undefined),
          }
        : {}),
      ...(sitesSnapshot ? { sitesSnapshot } : {}),
      ...extras,
      view,
      notice,
      signals,
      providerOnboarding,
      ...(renderedPage === "mcp" && context.mcpConnection
        ? {
            mcp: context.mcpConnection.configuration(),
          }
        : {}),
      ...(renderedPage === "history"
        ? {
            history: await context.history.list(),
            historyProfile: request.query.get("profile") ?? "",
          }
        : {}),
    };
    return htmlResponse(
      renderDocument({
        automaticUpdates: context.updates.automatic === true,
        page: renderedPage,
        view,
        signals,
        notice,
        activeNav: !providerOnboarding,
        body: renderPageBody(renderedPage, model),
      }),
    );
  };
}

export function createRouteTable(context: RouteContext): readonly Route[] {
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
      handler: pageHandler(context, page),
    });
  }
  routes.push(
    {
      method: "GET",
      path: "/_dashboard/agents/status",
      auth: "token",
      handler: createAgentSetupHandler(context, "status"),
    },
    {
      method: "POST",
      path: "/_dashboard/agents/install",
      auth: "token",
      handler: createAgentSetupHandler(context, "install"),
    },
    {
      method: "POST",
      path: "/_dashboard/agents/repair",
      auth: "token",
      handler: createAgentSetupHandler(context, "repair"),
    },
    {
      method: "POST",
      path: "/_dashboard/agents/remove",
      auth: "token",
      handler: createAgentSetupHandler(context, "remove"),
    },
    {
      method: "POST",
      path: "/_dashboard/agents/cancel",
      auth: "token",
      handler: createAgentSetupHandler(context, "cancel"),
    },
    {
      method: "POST",
      path: "/_dashboard/agents/dismiss",
      auth: "token",
      handler: createAgentSetupHandler(context, "dismiss"),
    },
    {
      method: "POST",
      path: "/_dashboard/agents/command",
      auth: "token",
      handler: createAgentSetupHandler(context, "command"),
    },
    {
      method: "POST",
      path: "/_dashboard/pro/save",
      auth: "token",
      handler: createProHandler(context, "save"),
    },
    {
      method: "POST",
      path: "/_dashboard/pro/remove",
      auth: "token",
      handler: createProHandler(context, "remove"),
    },
    {
      method: "POST",
      path: "/_dashboard/pro/plan",
      auth: "token",
      handler: createProHandler(context, "plan"),
    },
    {
      method: "POST",
      path: "/_dashboard/pro/install",
      auth: "token",
      handler: createProHandler(context, "install"),
    },
    {
      method: "GET",
      path: "/_dashboard/hosting-tools/run",
      auth: "token",
      handler: createHostingToolsHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/hosting-tools/run",
      auth: "token",
      handler: createHostingToolsHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/backups/create-plan",
      auth: "token",
      handler: createRestoreHandler(context, "create-plan"),
    },
    {
      method: "POST",
      path: "/_dashboard/backups/catalog",
      auth: "token",
      handler: createRestoreHandler(context, "catalog"),
    },
    {
      method: "POST",
      path: "/_dashboard/backups/plan",
      auth: "token",
      handler: createRestoreHandler(context, "plan"),
    },
    {
      method: "POST",
      path: "/_dashboard/backups/apply",
      auth: "token",
      handler: createRestoreHandler(context, "apply"),
    },
    {
      method: "GET",
      path: "/_dashboard/backups/status",
      auth: "token",
      handler: createRestoreHandler(context, "status"),
    },
    {
      method: "GET",
      path: "/mcp/novamira-hq.mcpb",
      auth: "public",
      handler: createMcpBundleHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/app/acknowledge",
      auth: "token",
      handler: createAcknowledgementHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/pushes/plan",
      auth: "token",
      handler: createPushExecutionHandler(context, "plan"),
    },
    {
      method: "POST",
      path: "/_dashboard/pushes/apply",
      auth: "token",
      handler: createPushExecutionHandler(context, "apply"),
    },
    {
      method: "GET",
      path: "/_dashboard/pushes/status",
      auth: "token",
      handler: createPushStatusHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/mcp/connect",
      auth: "token",
      handler: createMcpConnectHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/mcp/verify",
      auth: "token",
      handler: createMcpVerifyHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/providers/save",
      auth: "token",
      handler: createProviderSaveHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/providers/remove",
      auth: "token",
      handler: createProviderRemoveHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/providers/validate",
      auth: "token",
      handler: createProviderValidateHandler(context),
    },
    // Go left this one unauthenticated. It is a GET that reaches live provider
    // APIs and whose answer is patched into the DOM, so HQ guards it like every
    // other row under the prefix — and `requireTokenAuth` refuses to build the
    // table if a future edit forgets.
    {
      method: "GET",
      path: "/_dashboard/sites",
      auth: "token",
      handler: createSitesHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/connect",
      auth: "token",
      handler: createConnectHandler(context),
    },
    // Site-profile actions on the unified inventory, and a different subject:
    // these four operate on what `novamira sites list` holds, by spawning `novamira`,
    // where the row above lists what the hosting providers report. The GET is
    // guarded like every other row under the prefix even though it reaches no
    // provider API: it reports which sites this machine is authorized against,
    // which is not a thing a cross-origin page may enumerate.
    {
      method: "POST",
      path: "/_dashboard/site-profiles/connect",
      auth: "token",
      handler: createSiteProfileConnectHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/site-profiles/logout",
      auth: "token",
      handler: createSiteProfileLogoutHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/site-profiles/rename",
      auth: "token",
      handler: createSiteProfileRenameHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/site-profiles/remove",
      auth: "token",
      handler: createSiteProfileRemoveHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/pushes/save",
      auth: "token",
      handler: createPushSaveHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/pushes/remove",
      auth: "token",
      handler: createPushRemoveHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/setup/start",
      auth: "token",
      handler: createSetupStartHandler(context),
    },
    // The only prefix row outside `/assets/`. The job id is part of the path,
    // and so is the optional `/stream` suffix; `parseSetupJobPath` refuses
    // anything else under the prefix with a `404`, so `prefix: true` widens the
    // match without widening what is served.
    {
      method: "GET",
      path: SETUP_JOBS_PREFIX,
      prefix: true,
      auth: "token",
      handler: createSetupJobHandler(context),
    },
    // Both diagnostics rows are GETs and both are token-guarded. Go left them
    // unauthenticated; the capabilities one reaches a live provider API and the
    // doctor one reports the operator's local paths and credential references,
    // so neither is a thing a cross-origin page may trigger.
    {
      method: "GET",
      path: "/_dashboard/diagnostics/doctor",
      auth: "token",
      handler: createDiagnosticsDoctorHandler(context),
    },
    {
      method: "GET",
      path: "/_dashboard/diagnostics/capabilities",
      auth: "token",
      handler: createDiagnosticsCapabilitiesHandler(context),
    },
    // The last two rows the dashboard was ever missing. The check is a GET
    // because it is idempotent and cacheable in intent, the install is a POST
    // because it changes the machine; both are token-guarded, so Go's
    // signal-token fallback on the install has nothing to fall back to and is
    // not ported.
    {
      method: "GET",
      path: "/_dashboard/updates/check",
      auth: "token",
      handler: createUpdateCheckHandler(context),
    },
    {
      method: "POST",
      path: "/_dashboard/updates/install",
      auth: "token",
      handler: createUpdateInstallHandler(context),
    },
  );
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
