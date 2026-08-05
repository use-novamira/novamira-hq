// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two deploy-path routes: `/_dashboard/deploy-paths/{save,remove}`.
 *
 * **What the Go did.** `handleDashboardDeployPathSave` and `…Remove`
 * (`server.go:752-828`) each re-checked the method, re-read the signals,
 * re-checked authorization — accepting the token out of the request body as
 * well as the header — loaded the config, mutated the map and saved, then
 * repainted the page. `…Remove` deleted a key that might not be there and
 * reported success either way.
 *
 * **What HQ does instead.** The table checks the method and the token before a
 * handler runs, and the token is header-only. The validation and the write are
 * `services/deploy-paths.ts`; the repaint is `patchPage`. A removal of a path
 * that is not there is `not_found` and says so, because the operator clicked a
 * row, so the row existed a moment ago and the disagreement is worth reporting.
 *
 * **The repaint reads the warm sites cache, never the providers.** The
 * deploy-path list resolves environment names and domains from the inventory
 * (`views/types.ts`'s `deployPathView`), and the empty-state sentence needs to
 * know whether the cache is warm at all. Both come from
 * `sites.warm("__all__", true)`, which is a `Map` lookup: saving a deploy path
 * must not cost a round of provider API calls.
 *
 * **Every handler catches its own errors.** An escaping throw would be rendered
 * by `dispatch` as a JSON failure envelope, which is the wrong answer on an SSE
 * route: the browser is waiting for patches. So each one turns
 * `asCliError(error).message` into a `danger` notice, repaints the page with it,
 * and routes the `code` to `onDiagnostic`. `details` reach nothing.
 */

import { asCliError } from "../../errors.js";
import type { JsonValue } from "../expr.js";
import { patchPage } from "../patch.js";
import { readSignals, type DashboardRequest } from "../request.js";
import type { DashboardResponse } from "../responses.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import { parseDeployForm } from "../signals-input.js";
import {
  defaultDashboardSignals,
  defaultDeployFormSignals,
  ALL_PROFILES_SENTINEL,
} from "../signals.js";
import type { SseStream } from "../sse.js";
import { PROVIDER_KINDS } from "../../config/schema.js";
import type { DashboardNotice } from "../views/types.js";

/** The reset both mutations send before the new markup, as Go's `patch` did. */
function resetFormSignals(): Readonly<Record<string, JsonValue>> {
  return { deployForm: { ...defaultDeployFormSignals() } };
}

/**
 * Repaint `/deploy-paths`.
 *
 * `loadConfigView` is re-read rather than mutated in place, so the table shows
 * what is actually on disk — including the environment names resolved from the
 * warm inventory, which the posted form did not carry.
 */
async function patchDeployPathsPage(
  context: RouteContext,
  stream: SseStream,
  notice: DashboardNotice,
  signals?: Readonly<Record<string, JsonValue>>,
): Promise<void> {
  const view = await context.loadConfigView();
  const warm = context.sites.warm(ALL_PROFILES_SENTINEL, true);
  patchPage(stream, {
    page: "deploy-paths",
    notice,
    model: {
      view,
      notice,
      signals: defaultDashboardSignals(context.token, {
        firstProviderKind: PROVIDER_KINDS[0],
      }),
      deployPaths: {
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

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/deploy-paths/save                                         */
/* -------------------------------------------------------------------------- */

export function createDeployPathSaveHandler(
  context: RouteContext,
): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      try {
        const input = parseDeployForm(await readSignals(request));
        await context.deployPaths.upsert(input);
        await patchDeployPathsPage(
          context,
          stream,
          { level: "ok", message: "Deploy path saved." },
          resetFormSignals(),
        );
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/deploy-paths/save",
          code: cliError.code,
        });
        // No signal patch on the failure path: the operator's values stay in
        // the form so a name collision can be fixed without retyping.
        await patchDeployPathsPage(context, stream, danger(cliError.message));
      }
      stream.close();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/deploy-paths/remove                                       */
/* -------------------------------------------------------------------------- */

/** `?path=`, trimmed. Go's `strings.TrimSpace(r.URL.Query().Get("path"))`. */
function pathParameter(request: DashboardRequest): string {
  return (request.query.get("path") ?? "").trim();
}

export function createDeployPathRemoveHandler(
  context: RouteContext,
): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      try {
        await readSignals(request);
        const removed = await context.deployPaths.remove(
          pathParameter(request),
        );
        await patchDeployPathsPage(context, stream, {
          level: "ok",
          message: `${removed} removed.`,
        });
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/deploy-paths/remove",
          code: cliError.code,
        });
        await patchDeployPathsPage(context, stream, danger(cliError.message));
      }
      stream.close();
    },
  });
}
