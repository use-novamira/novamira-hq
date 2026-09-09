// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { asCliError, CliError } from "../../errors.js";
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
        const notice = {
          level: "ok",
          message: "You can now configure hosting and connect your AI.",
        } as const;
        patchPage(stream, {
          page: "mcp",
          notice,
          model: {
            view,
            notice,
            signals: defaultDashboardSignals(context.token),
            ...(context.mcpConnection
              ? { mcp: context.mcpConnection.configuration() }
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
