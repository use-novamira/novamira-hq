// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two Novamira-setup routes: `POST /_dashboard/setup/start` and the prefix
 * route `GET /_dashboard/setup/jobs/…`, which answers both the one-shot snapshot
 * and the long-lived progress stream.
 *
 * **What the Go did.** `handleDashboardSetupStart` (`server.go:398-434`) read
 * `?profile=`, `?env=`, `?siteprofile=` and `?replace=`, re-checked the method
 * and the token (accepting the token out of the request body as well as the
 * header), started a job and patched `#main` and `#toast` — but not `#nav`,
 * alone among the four patch helpers. `handleDashboardSetupJob`
 * (`:436-462`) split the path by hand, and `streamDashboardSetupJob`
 * (`:985-1018`) held a one-second `time.Ticker` open, re-rendering the body and
 * patching only when the markup had changed.
 *
 * **What HQ does instead.** The table checks the method and the token before a
 * handler runs; the token is header-only. `?siteprofile=` and `?replace=` are
 * deleted with the site-profile surface, so the start route takes `?profile=`
 * and `?env=` plus the two display labels the Sites link already carried. The
 * repaint is `patchPage`, which also sends `#nav` — harmless, because the link
 * was already active, and it removes Go's one divergent copy.
 *
 * **The stream is the only looping handler in the dashboard**, and it has three
 * exits, all of them present in Go: the job leaves `running`, the job disappears
 * from the registry, or `request.signal` aborts because the operator closed the
 * tab (Go read `r.Context().Done()` at `server.go:1013`). There is deliberately
 * **no wall-clock cap**: a plugin install behind a slow provider operation can
 * legitimately take minutes, and a timeout would report a failure that had not
 * happened. The markup diff is Go's and is what stops a one-second repaint
 * storm; `streamSse`'s default `keepalive: false` is right, because this handler
 * owns its loop and the response ends when the loop returns.
 *
 * **An unknown job id is JSON, not SSE.** Go answered `writeError(…404…)` there
 * (`server.go:453`, `:988`), and the distinction matters: a browser opening a
 * stale `?job=` link gets a failure envelope it can read, rather than an event
 * stream that says nothing and never closes.
 *
 * **Every handler catches its own errors.** An escaping throw would be rendered
 * by `dispatch` as a JSON failure envelope, which is the wrong answer on an SSE
 * route. Each turns `asCliError(error).message` into a `danger` notice, repaints
 * the page with it, and routes the `code` to `onDiagnostic`; `details` reach
 * nothing.
 */

import { asCliError, CliError } from "../../errors.js";
import { renderHtml } from "../html.js";
import { patchPage } from "../patch.js";
import { readSignals, type DashboardRequest } from "../request.js";
import { jsonFailure, type DashboardResponse } from "../responses.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import { parseSetup } from "../signals-input.js";
import { defaultDashboardSignals } from "../signals.js";
import type { SseStream } from "../sse.js";
import { PROVIDER_KINDS } from "../../config/schema.js";
import {
  renderSetupWork,
  renderSetupWorkBody,
  setupViewForJob,
  type SetupView,
} from "../views/setup.js";
import type { DashboardNotice } from "../views/types.js";

/** The prefix the job route is mounted on, and the one it strips. */
export const SETUP_JOBS_PREFIX = "/_dashboard/setup/jobs/";

/** Go's default `time.NewTicker(time.Second)` (`server.go:990`). */
export const SETUP_POLL_MS = 1_000;

/* -------------------------------------------------------------------------- */
/* Shared                                                                     */
/* -------------------------------------------------------------------------- */

function trimmed(request: DashboardRequest, name: string): string {
  return (request.query.get(name) ?? "").trim();
}

/**
 * The view a request describes before any job is consulted: the four display
 * values the Sites page's Setup CTA puts on the link.
 */
function viewFromRequest(request: DashboardRequest): SetupView {
  return {
    profile: trimmed(request, "profile"),
    envId: trimmed(request, "env"),
    siteLabel: trimmed(request, "site"),
    envName: trimmed(request, "envname"),
    jobId: "",
    job: null,
  };
}

export async function patchSetupPage(
  context: RouteContext,
  stream: SseStream,
  setup: SetupView,
  notice: DashboardNotice,
): Promise<void> {
  const view = await context.loadConfigView();
  patchPage(stream, {
    page: "novamira-setup",
    notice,
    model: {
      view,
      notice,
      signals: defaultDashboardSignals(context.token, {
        firstProviderKind: PROVIDER_KINDS[0],
      }),
      setup,
    },
  });
}

function danger(message: string): DashboardNotice {
  return { level: "danger", message };
}

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/setup/start                                               */
/* -------------------------------------------------------------------------- */

export function createSetupStartHandler(context: RouteContext): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      const requested = viewFromRequest(request);
      try {
        const setup = parseSetup(await readSignals(request));
        if (!setup.enableAiAbilities) {
          throw new CliError(
            "usage_error",
            "Approve enabling AI Abilities before starting setup. Nothing has been installed or changed.",
          );
        }
        const jobId = await context.setupJobs.start({
          profile: requested.profile,
          envId: requested.envId,
          aiAbilities: setup.enableAiAbilities,
        });
        const job = context.setupJobs.snapshot(jobId);
        if (job === undefined) {
          throw new CliError(
            "internal_error",
            "The setup job was not found after it was started.",
          );
        }
        await patchSetupPage(
          context,
          stream,
          setupViewForJob(job, {
            siteLabel: requested.siteLabel,
            envName: requested.envName,
          }),
          { level: "ok", message: "" },
        );
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/setup/start",
          code: cliError.code,
        });
        await patchSetupPage(
          context,
          stream,
          requested,
          danger(cliError.message),
        );
      }
      stream.close();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* GET /_dashboard/setup/jobs/<id>[/stream]                                   */
/* -------------------------------------------------------------------------- */

interface JobPath {
  readonly id: string;
  readonly stream: boolean;
}

/**
 * Go's `setupJobPath` (`server.go:464-478`), ported exactly: strip the prefix,
 * trim `/`, an empty rest is a 404, a `/stream` suffix selects the stream, and a
 * remaining `/` — a nested path nobody serves — is a 404 rather than a lookup of
 * something that could never be an id.
 */
export function parseSetupJobPath(path: string): JobPath | undefined {
  let rest = path.startsWith(SETUP_JOBS_PREFIX)
    ? path.slice(SETUP_JOBS_PREFIX.length)
    : path;
  rest = rest.replace(/^\/+/, "").replace(/\/+$/, "");
  if (rest === "") return undefined;
  let stream = false;
  if (rest.endsWith("/stream")) {
    stream = true;
    rest = rest.slice(0, -"/stream".length);
  }
  if (rest === "" || rest.includes("/")) return undefined;
  return { id: rest, stream };
}

/**
 * Sleep, or return early when the client goes away.
 *
 * The listener is removed on both paths, so a long-lived request cannot
 * accumulate one per tick on the same signal.
 */
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createSetupJobHandler(context: RouteContext): RouteHandler {
  const pollMs = context.setupPollMs ?? SETUP_POLL_MS;
  return (request): DashboardResponse => {
    const parsed = parseSetupJobPath(request.path);
    if (parsed === undefined) {
      return jsonFailure(
        new CliError("not_found", "No such dashboard route."),
        404,
      );
    }
    const known = context.setupJobs.snapshot(parsed.id);
    if (known === undefined) {
      return jsonFailure(
        new CliError("not_found", "Setup job not found."),
        404,
      );
    }

    if (!parsed.stream) {
      return {
        kind: "sse",
        run: (stream) => {
          stream.patchElements(renderSetupWork(setupViewForJob(known)), {
            selectorId: "setup-work",
            mode: "outer",
          });
          stream.close();
        },
      };
    }

    return {
      kind: "sse",
      run: async (stream) => {
        let last = "";
        for (;;) {
          const job = context.setupJobs.snapshot(parsed.id);
          // The registry evicts finished jobs under pressure; a stream that
          // outlives its record stops rather than repainting a stale body.
          if (job === undefined) break;
          const body = renderSetupWorkBody(setupViewForJob(job));
          const markup = renderHtml(body);
          if (markup !== last) {
            // **Inner**: the wrapper carries the `data-init` that opened this
            // stream, and re-sending it would restart the stream every tick.
            stream.patchElements(body, {
              selectorId: "setup-work",
              mode: "inner",
            });
            last = markup;
          }
          if (job.status !== "running") break;
          // One check, after the wait: `wait` returns immediately on an already
          // aborted signal, so a second check before it would be dead code — and
          // the compiler says so, because `AbortSignal.aborted` is readonly and
          // narrowing survives the await.
          await wait(pollMs, request.signal);
          if (request.signal.aborted) break;
        }
        stream.close();
      },
    };
  };
}
