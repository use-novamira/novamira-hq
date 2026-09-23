// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  renderProviderRemoval,
  type ProviderRemovalView,
} from "./provider-removal.js";

/**
 * The page-body dispatcher: one `DashboardPage` in, one `#main` body out.
 *
 * **What the Go did.** `renderMainWithSignals` (`views.go:109-129`) was a
 * `switch` on a `string` with a `default:` arm that rendered the providers page.
 * A page name nobody had implemented, or one misspelled at a call site, silently
 * showed the wrong page — and because the same function also wrapped the body in
 * `<main id="main">`, the wrapper and the dispatch could not be tested apart.
 *
 * **What HQ does instead.** {@link DashboardPage} is a closed union, the
 * `switch` below is exhaustive with a `never` default, and the wrapper lives in
 * `views/layout.ts`'s `renderMain`. A new page is a compile error here rather
 * than a silent fallback, and `renderPageBody` is a pure function a test can
 * call without a server.
 *
 * **This file was edited by all three 6b batches, one `case` arm each.** Keep it
 * a bare `switch` with a single call per arm — no shared locals, no early
 * returns, no clever grouping. Every arm now renders a real page: as of 6b-3
 * there is no placeholder body left in the dashboard, and `renderPlaceholderBody`
 * is gone from `views/layout.ts` rather than kept for a future page. A new page
 * arrives by extending {@link DashboardPage}, which makes this `switch` fail to
 * compile until its renderer exists — which is the point.
 *
 * **{@link PageModel} grew with those batches too.** 6b-1 gave it what every
 * page needs — the config view, the notice and the signals. 6b-2 added
 * `pushes?: WarmSitesView` and `pushNew?: PushNewView`; 6b-3 added
 * `setup?: SetupView`. Each is optional and each is declared in the view module
 * that owns it, rather than typed as `unknown` here: a field typed loosely
 * enough to be filled in later is a field a handler can fill in wrongly today.
 *
 * Sites may receive a process-local snapshot; rendering never refreshes it.
 */

import { CliError } from "../../errors.js";
import { renderHostingTools, type HostingToolsView } from "./hosting-tools.js";
import { renderRestore, type RestoreView } from "./restore.js";
import { renderAboutPage } from "./about.js";
import type { ProviderReadyView } from "./provider-ready.js";
import type { McpConfiguration } from "../../mcp-connection.js";
import {
  renderMcpPage,
  type McpPageClient,
  type McpSetupState,
} from "./mcp.js";
import { renderPushConfirmation } from "./push-confirmation.js";
import { renderPushJob } from "./push-job.js";
import type { PushJob } from "../services/push-execution.js";
import type { PushConfirmation } from "../services/push-execution.js";
import type { Html } from "../html.js";
import type { DashboardSignals } from "../signals.js";
import {
  renderPushNewPage,
  renderPushesPage,
  type PushNewView,
  type WarmSitesView,
} from "./pushes.js";
import { renderDiagnosticsPage } from "./diagnostics.js";
import { renderHistoryPage, type HistoryView } from "./history.js";
import { renderHowToUsePage } from "./how-to-use.js";
import { renderProvidersPage } from "./providers.js";
import { renderSettingsPage, type SettingsTab } from "./settings.js";
import { renderProPage } from "./pro.js";
import { renderUpdatesPage } from "./updates.js";
import { renderSetupPage, type SetupView } from "./setup.js";
import type { SitesResult } from "../services/sites.js";
import { renderSitesPage } from "./sites.js";
import {
  renderSiteConnectSuccess,
  type SiteConnectSuccessView,
} from "./site-profiles.js";
import type { ConfigView, DashboardNotice, DashboardPage } from "./types.js";

export interface PageModel {
  readonly agentSetup?: import("../../agent-connection.js").AgentSetupView;
  readonly agentSetupError?: string;
  readonly pro?: import("../../pro/service.js").ProView;
  readonly updatesAvailable?: boolean;
  readonly desktopUpdates?: boolean;
  readonly hostingTools?: HostingToolsView;
  readonly restore?: RestoreView;
  readonly providerReady?: ProviderReadyView;
  readonly providerRemoval?: ProviderRemovalView;
  readonly settingsTab?: SettingsTab;
  readonly sitesSnapshot?: SitesResult;
  readonly siteConnectSuccess?: SiteConnectSuccessView;
  readonly pushConfirmation?: PushConfirmation;
  readonly pushJob?: PushJob;
  readonly pushJobs?: readonly PushJob[];
  readonly pushHistory?: boolean;
  readonly mcp?: McpConfiguration;
  readonly mcpClient?: McpPageClient;
  readonly mcpSetup?: McpSetupState;
  readonly history?: HistoryView;
  readonly historyProfile?: string;
  readonly view: ConfigView;
  readonly notice: DashboardNotice;
  /** The root-page first-run state, after checking both hosting and direct sites. */
  readonly providerOnboarding?: boolean;
  /**
   * The signals the page was rendered with.
   *
   * The providers page needs `providerForm.open` from it, because the form's
   * `open` class is rendered server-side to avoid a first-paint flash and
   * `data-class` only takes over afterwards. Nothing here may read
   * `signals.token`: the token reaches the page through the root
   * `data-signals` attribute and through nothing else.
   */
  readonly signals: DashboardSignals;
  /**
   * The warm sites inventory, for `/push`'s status line. Absent means
   * "nobody has listed sites in this process yet", which is a state the sentence
   * has words for — not a missing value to be invented.
   */
  readonly pushes?: WarmSitesView;
  /** The site and environments `/push/new` was opened for. */
  readonly pushNew?: PushNewView;
  /**
   * The setup target and, when one exists, the job running against it. Absent
   * renders the "Select an environment from Sites" empty state, which is what
   * `/novamira-setup` with no query means.
   */
  readonly setup?: SetupView;
}

/** Go's `renderMainWithSignals` switch, made exhaustive. */
export function renderPageBody(page: DashboardPage, model: PageModel): Html {
  switch (page) {
    case "about":
      return renderAboutPage(model.view);
    case "mcp":
      return renderMcpPage(
        model.view,
        model.mcp,
        model.mcpClient,
        model.mcpSetup,
      );
    case "history":
      return renderHistoryPage(
        model.history ?? [],
        model.historyProfile ?? "",
        model.view.profiles.map((profile) => profile.name),
      );
    case "providers":
      if (model.providerRemoval)
        return renderProviderRemoval(model.providerRemoval);
      return renderProvidersPage({
        ...(model.providerReady ? { ready: model.providerReady } : {}),
        view: model.view,
        notice: model.notice,
        onboarding: model.providerOnboarding ?? false,
        formOpen: model.signals.providerForm.open,
      });
    case "sites":
      if (model.hostingTools) return renderHostingTools(model.hostingTools);
      if (model.restore) return renderRestore(model.restore);
      return model.siteConnectSuccess
        ? renderSiteConnectSuccess(model.siteConnectSuccess)
        : renderSitesPage(
            model.view,
            model.signals.cliSites.open,
            model.sitesSnapshot,
          );
    case "how-to-use":
      return renderHowToUsePage();
    case "pushes":
      return model.pushJob
        ? renderPushJob(model.pushJob)
        : model.pushConfirmation
          ? renderPushConfirmation(model.pushConfirmation)
          : renderPushesPage(
              model.view,
              model.notice,
              model.pushes,
              model.pushJobs,
              model.pushHistory,
            );
    case "push-new":
      return renderPushNewPage(model.pushNew, model.view, model.pushes);
    case "novamira-setup":
      return renderSetupPage(model.setup);
    case "diagnostics":
      return renderDiagnosticsPage();
    case "settings":
      return renderSettingsPage(
        model.view,
        model.settingsTab,
        model.pro,
        model.agentSetup,
        model.agentSetupError,
      );
    case "novamira-pro":
      return renderProPage(model.pro ?? {});
    case "updates":
      return renderUpdatesPage(
        model.view.version,
        model.updatesAvailable,
        model.desktopUpdates,
      );
    default: {
      const unexpected: never = page;
      throw new CliError(
        "internal_error",
        `Unhandled dashboard page: ${String(unexpected)}.`,
      );
    }
  }
}
