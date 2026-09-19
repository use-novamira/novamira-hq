// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { asCliError, CliError } from "../../errors.js";
import type { ProReview } from "../../pro/service.js";
import { patchPage, patchToast } from "../patch.js";
import { readSignals } from "../request.js";
import { parseProLicense } from "../signals-input.js";
import { defaultDashboardSignals } from "../signals.js";
import type { RouteContext, RouteHandler } from "../routes.js";

export function createProHandler(
  context: RouteContext,
  action: "save" | "remove" | "plan" | "install",
): RouteHandler {
  return (request) => ({
    kind: "sse",
    run: async (stream) => {
      const site = request.query.get("site") ?? undefined;
      try {
        if (!context.pro)
          throw new CliError(
            "provider_unsupported",
            "Novamira Pro setup is unavailable in this instance.",
          );
        let review: ProReview | undefined;
        let message = "";
        if (action === "save") {
          await context.pro.save(parseProLicense(await readSignals(request)));
          message =
            "License saved on this computer. It has not been activated on any site.";
        }
        if (action === "remove") {
          await context.pro.remove();
          message =
            "Saved license removed from this computer. Existing site activations are unchanged.";
        }
        if (action === "plan") review = await context.pro.plan(site ?? "");
        if (action === "install")
          message = await context.pro.install(
            request.query.get("confirmation") ?? "",
          );
        const notice = { level: "ok" as const, message };
        patchPage(stream, {
          page: site ? "novamira-pro" : "settings",
          notice,
          model: {
            settingsTab: "pro",
            view: await context.loadConfigView(),
            notice,
            signals: defaultDashboardSignals(context.token),
            pro: {
              ...(await context.pro.view(site)),
              ...(review ? { review } : {}),
              ...(action === "install" ? { message } : {}),
            },
          },
        });
      } catch (error) {
        stream.patchSignals({ proForm: { license: "", busy: false } });
        patchToast(stream, {
          level: "danger",
          message: asCliError(error).message,
        });
      }
      stream.close();
    },
  });
}
