// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two push routes: `/_dashboard/pushes/{save,remove}`.
 *
 * **What the Go did.** `handleDashboardSavedPushSave` and `…Remove`
 * (`server.go:752-828`) each re-checked the method, re-read the signals,
 * re-checked authorization — accepting the token out of the request body as
 * well as the header — loaded the config, mutated the map and saved, then
 * repainted the page. `…Remove` deleted a key that might not be there and
 * reported success either way.
 *
 * **What HQ does instead.** The table checks the method and the token before a
 * handler runs, and the token is header-only. The validation and the write are
 * `services/pushes.ts`; the repaint is `patchPage`. Removing a saved push
 * that is not there is `not_found` and says so, because the operator clicked a
 * row, so the row existed a moment ago and the disagreement is worth reporting.
 *
 * **The repaint reads the warm sites cache, never the providers.** The
 * push list resolves environment names and domains from the inventory
 * (`views/types.ts`'s `pushView`), and the empty-state sentence needs to
 * know whether the cache is warm at all. Both come from
 * `sites.warm("__all__", true)`, which is a `Map` lookup: saving a push
 * must not cost a round of provider API calls.
 *
 * **Every handler catches its own errors.** An escaping throw would be rendered
 * by `dispatch` as a JSON failure envelope, which is the wrong answer on an SSE
 * route: the browser is waiting for patches. So each one turns
 * `asCliError(error).message` into a `danger` notice, repaints the page with it,
 * and routes the `code` to `onDiagnostic`. `details` reach nothing.
 */

import { asCliError, CliError } from "../../errors.js";
import type { PushConfirmation, PushJob } from "../services/push-execution.js";
import type { JsonValue } from "../expr.js";
import { patchPage } from "../patch.js";
import { readSignals, type DashboardRequest } from "../request.js";
import type { DashboardResponse } from "../responses.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import { parsePushForm } from "../signals-input.js";
import {
  defaultDashboardSignals,
  defaultPushFormSignals,
  ALL_PROFILES_SENTINEL,
} from "../signals.js";
import type { SseStream } from "../sse.js";
import { PROVIDER_KINDS } from "../../config/schema.js";
import type { DashboardNotice } from "../views/types.js";
import { displayLabel } from "../services/sites.js";

/** The reset both mutations send before the new markup, as Go's `patch` did. */
function resetFormSignals(): Readonly<Record<string, JsonValue>> {
  return { pushForm: { ...defaultPushFormSignals() } };
}

/**
 * Repaint `/push`.
 *
 * `loadConfigView` is re-read rather than mutated in place, so the table shows
 * what is actually on disk — including the environment names resolved from the
 * warm inventory, which the posted form did not carry.
 */
async function patchPushesPage(
  context: RouteContext,
  stream: SseStream,
  notice: DashboardNotice,
  signals?: Readonly<Record<string, JsonValue>>,
  confirmation?: PushConfirmation,
  job?: PushJob,
): Promise<void> {
  const view = await context.loadConfigView();
  const warm = context.sites.warm(ALL_PROFILES_SENTINEL, true);
  patchPage(stream, {
    page: "pushes",
    notice,
    model: {
      ...(confirmation ? { pushConfirmation: confirmation } : {}),
      ...(job ? { pushJob: job } : {}),
      pushJobs: context.pushExecution?.list() ?? [],
      view,
      notice,
      signals: defaultDashboardSignals(context.token, {
        firstProviderKind: PROVIDER_KINDS[0],
      }),
      pushes: {
        groups: warm?.groups ?? [],
        cacheWarm: warm !== undefined,
      },
    },
    ...(signals === undefined ? {} : { signals }),
  });
}

function danger(message: string): DashboardNotice {
  return { level: "danger", message };
}

export function createPushExecutionHandler(
  context: RouteContext,
  action: "plan" | "apply",
): RouteHandler {
  return (request) => ({
    kind: "sse",
    run: async (stream) => {
      try {
        await readSignals(request);
        if (!context.pushExecution)
          throw new CliError(
            "provider_unsupported",
            "Push execution is unavailable.",
          );
        if (action === "plan") {
          const confirmation = await context.pushExecution.plan(
            pushParameter(request),
          );
          await patchPushesPage(
            context,
            stream,
            {
              level: "neutral",
              message: "",
            },
            { pushForm: { submitting: false } },
            confirmation,
          );
        } else {
          const job = context.pushExecution.start(
            request.query.get("confirmation") ?? "",
          );
          await patchPushesPage(
            context,
            stream,
            { level: "neutral", message: "" },
            { pushForm: { submitting: false } },
            undefined,
            job,
          );
        }
      } catch (error) {
        await patchPushesPage(
          context,
          stream,
          danger(asCliError(error).message),
        );
      }
      stream.close();
    },
  });
}

/** Observes the accepted job only. Never starts or repeats a provider operation. */
export function createPushStatusHandler(context: RouteContext): RouteHandler {
  return (request) => ({
    kind: "sse",
    run: async (stream) => {
      try {
        const id = request.query.get("job") ?? "";
        if (!context.pushExecution?.snapshot(id))
          throw new CliError(
            "not_found",
            "Push job not found. Check History and the provider before retrying.",
          );
        await context.pushExecution.wait(id, request.signal);
        if (!request.signal.aborted) {
          const job = context.pushExecution.snapshot(id);
          if (!job)
            throw new CliError(
              "not_found",
              "Push job no longer available. Check History.",
            );
          await patchPushesPage(
            context,
            stream,
            { level: "neutral", message: "" },
            undefined,
            undefined,
            job,
          );
        }
      } catch (error) {
        if (!request.signal.aborted)
          await patchPushesPage(
            context,
            stream,
            danger(asCliError(error).message),
          );
      }
      stream.close();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/pushes/save                                         */
/* -------------------------------------------------------------------------- */

export function createPushSaveHandler(context: RouteContext): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      try {
        const input = parsePushForm(await readSignals(request));
        const site = context.sites.resolveSite(
          input.hostingProfile,
          input.siteId,
        );
        const environmentName = (id: string, fallback: string): string => {
          const environment = site?.envs.find(
            (candidate) => candidate.id === id,
          );
          return environment === undefined
            ? fallback
            : displayLabel(
                environment.displayName,
                environment.name,
                environment.id,
              );
        };
        await context.pushes.upsert({
          ...input,
          sourceEnvName: environmentName(
            input.sourceEnvId,
            input.sourceEnvName,
          ),
          targetEnvName: environmentName(
            input.targetEnvId,
            input.targetEnvName,
          ),
        });
        await patchPushesPage(
          context,
          stream,
          { level: "ok", message: "Push saved." },
          resetFormSignals(),
        );
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/pushes/save",
          code: cliError.code,
        });
        // No signal patch on the failure path: the operator's values stay in
        // the form so a name collision can be fixed without retyping.
        await patchPushesPage(context, stream, danger(cliError.message));
      }
      stream.close();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/pushes/remove                                       */
/* -------------------------------------------------------------------------- */

/** The selected saved push, trimmed before it becomes a store lookup key. */
function pushParameter(request: DashboardRequest): string {
  return (request.query.get("push") ?? "").trim();
}

export function createPushRemoveHandler(context: RouteContext): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      try {
        await readSignals(request);
        const removed = await context.pushes.remove(pushParameter(request));
        await patchPushesPage(context, stream, {
          level: "ok",
          message: `${removed} removed.`,
        });
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/pushes/remove",
          code: cliError.code,
        });
        await patchPushesPage(context, stream, danger(cliError.message));
      }
      stream.close();
    },
  });
}
