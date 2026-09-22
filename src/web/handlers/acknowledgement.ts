// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { asCliError, CliError } from "../../errors.js";
import { isAgentCliSetupEnabled } from "../../agent-connection.js";
import { patchPage, patchToast } from "../patch.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import { defaultDashboardSignals } from "../signals.js";

export function createAcknowledgementHandler(
  context: RouteContext,
): RouteHandler {
  return () => ({
    kind: "sse",
    run: async (stream) => {
      try {
        if (!context.appAcknowledgement)
          throw new CliError(
            "provider_unsupported",
            "App onboarding is unavailable in this instance.",
          );
        await context.appAcknowledgement.accept();
        const view = await context.loadConfigView();
        const agentSetup = isAgentCliSetupEnabled()
          ? await context.agentSetup?.view().catch(() => undefined)
          : undefined;
        const notice = {
          level: "neutral",
          message: "",
        } as const;
        patchPage(stream, {
          page: agentSetup?.firstRun ? "settings" : "providers",
          notice,
          model: {
            view,
            notice,
            signals: defaultDashboardSignals(context.token),
            providerOnboarding: true,
            ...(agentSetup?.firstRun
              ? { settingsTab: "agents" as const, agentSetup }
              : {}),
          },
        });
      } catch (error) {
        patchToast(stream, {
          level: "danger",
          message: asCliError(error).message,
        });
      }
      stream.close();
    },
  });
}
