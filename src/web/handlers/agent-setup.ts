// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { asCliError, CliError } from "../../errors.js";
import { isAgentCliSetupEnabled } from "../../agent-connection.js";
import { patchPage, patchToast } from "../patch.js";
import { defaultDashboardSignals } from "../signals.js";
import type { RouteContext, RouteHandler } from "../routes.js";

export function createAgentSetupHandler(
  context: RouteContext,
  action:
    | "status"
    | "install"
    | "repair"
    | "remove"
    | "cancel"
    | "dismiss"
    | "command",
): RouteHandler {
  return (request) => ({
    kind: "sse",
    run: async (stream) => {
      try {
        if (!isAgentCliSetupEnabled())
          throw new CliError(
            "provider_unsupported",
            "Terminal access and skill installation are temporarily unavailable. Use Configure AI to connect through MCP.",
          );
        const service = context.agentSetup;
        if (!service)
          throw new CliError(
            "provider_unsupported",
            "Agent setup requires the installed desktop application.",
          );
        const repaint = async () => {
          const notice = { level: "neutral" as const, message: "" };
          patchPage(stream, {
            page: action === "dismiss" ? "providers" : "settings",
            notice,
            model: {
              view: await context.loadConfigView(),
              notice,
              signals: defaultDashboardSignals(context.token),
              settingsTab: "agents",
              agentSetup: await service.view(),
            },
          });
        };
        if (action === "install" || action === "repair" || action === "remove")
          service.start(request.query.get("agent") ?? "", action);
        if (action === "cancel") service.cancel();
        if (action === "dismiss") await service.dismiss();
        if (action === "command") {
          const operation = request.query.get("operation");
          if (
            operation !== "enable" &&
            operation !== "repair" &&
            operation !== "remove"
          )
            throw new CliError(
              "usage_error",
              "Choose enable, repair or remove.",
            );
          await service.command(operation);
        }
        await repaint();
        if (
          action === "install" ||
          action === "repair" ||
          action === "remove" ||
          action === "status" ||
          action === "cancel"
        ) {
          await service.wait();
          await repaint();
        }
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
