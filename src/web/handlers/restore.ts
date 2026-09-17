// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../../errors.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import { readSignals } from "../request.js";
import { parseRestoreForm } from "../signals-input.js";
import { defaultDashboardSignals } from "../signals.js";
import { patchPage } from "../patch.js";
import type { RestoreView } from "../views/restore.js";

export function createRestoreHandler(
  context: RouteContext,
  action: "catalog" | "plan" | "apply" | "status" | "create-plan",
): RouteHandler {
  return (request) => ({
    kind: "sse",
    run: async (stream) => {
      const target = {
        profile: request.query.get("profile") ?? "",
        site: request.query.get("site") ?? "",
        env: request.query.get("env") ?? "",
      };
      let restore: RestoreView = { target, create: action === "create-plan" };
      try {
        const service = context.restore;
        if (!service)
          throw new CliError("provider_unsupported", "Restore is unavailable.");
        if (action === "status") {
          const id = request.query.get("job") ?? "";
          await service.wait(id, request.signal);
          const job = service.snapshot(id);
          if (!job) throw new CliError("not_found", "Restore job not found.");
          restore = { target: job.review, job };
        } else {
          const signals = await readSignals(request);
          if (action === "create-plan")
            restore = {
              target,
              create: true,
              review: await service.planCreate(target),
            };
          if (action === "catalog")
            restore = { target, catalog: await service.catalog(target) };
          if (action === "plan") {
            const form = parseRestoreForm(signals);
            restore = {
              target,
              review: await service.plan(
                target,
                form.backupId,
                form.allContent,
                form.notifiedUserId,
              ),
            };
          }
          if (action === "apply") {
            const job = service.start(request.query.get("confirmation") ?? "");
            restore = { target: job.review, job };
          }
        }
      } catch {
        restore = {
          target,
          create: action === "create-plan",
          error:
            "The request could not be completed. Check the selected backup, acknowledgement and required fields. If you already confirmed a restore, check Activity and your hosting provider before trying again.",
        };
      }
      if (!request.signal.aborted)
        patchPage(stream, {
          page: "sites",
          notice: { level: "neutral", message: "" },
          model: {
            restore,
            view: await context.loadConfigView(),
            notice: { level: "neutral", message: "" },
            signals: defaultDashboardSignals(context.token),
          },
          signals: {
            restoreForm:
              action === "catalog"
                ? {
                    backupId: "",
                    notifiedUserId: "",
                    allContent: false,
                    submitting: false,
                  }
                : { submitting: false },
          },
        });
      stream.close();
    },
  });
}
