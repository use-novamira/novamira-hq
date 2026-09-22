// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isProviderKind } from "../../config/schema.js";
import { CliError } from "../../errors.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import { patchPage } from "../patch.js";
import { defaultDashboardSignals } from "../signals.js";
import type { HostingToolsView } from "../views/hosting-tools.js";

export function createHostingToolsHandler(context: RouteContext): RouteHandler {
  return (request) => ({
    kind: "sse",
    run: async (stream) => {
      const target = {
        profile: request.query.get("profile") ?? "",
        site: request.query.get("site") ?? "",
        env: request.query.get("env") ?? "",
      };
      const option = request.query.get("option") ?? "";
      let tools: HostingToolsView = { target, selected: option };
      try {
        const view = await context.loadConfigView();
        const provider = view.profiles.find(
          (entry) => entry.name === target.profile,
        )?.provider;
        if (!provider || !isProviderKind(provider) || !context.hostingTools)
          throw new CliError("not_found", "Hosting account unavailable.");
        tools = { ...tools, provider };
        if (option.startsWith("cache:") && request.method !== "POST")
          throw new CliError("usage_error", "Cache purge requires POST.");
        tools = {
          ...tools,
          result: await context.hostingTools.run(target, option),
        };
      } catch {
        tools = {
          ...tools,
          error: option.startsWith("cache:")
            ? "Could not confirm the cache purge. Check HQ Activity and your provider before trying again."
            : "Could not load this report. Check the account permissions and selected environment, then try again. This does not mean the report is empty.",
        };
      }
      if (!request.signal.aborted)
        patchPage(stream, {
          page: "sites",
          notice: { level: "neutral", message: "" },
          model: {
            hostingTools: tools,
            view: await context.loadConfigView(),
            notice: { level: "neutral", message: "" },
            signals: defaultDashboardSignals(context.token),
          },
          signals: { hostingTools: { loading: false } },
        });
      stream.close();
    },
  });
}
