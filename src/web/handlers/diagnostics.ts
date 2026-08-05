// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two diagnostics routes: `GET /_dashboard/diagnostics/{doctor,capabilities}`.
 *
 * **What the Go did.** `handleDashboardDoctor` (`server.go:480-500`) and
 * `handleDashboardCapabilities` (`server.go:503-537`) each re-checked the
 * method, loaded the config, and then repeated
 * `if err != nil { patchDiagnosticsOutput(…, dashboardNotice{Level: "error", …}, "") ; return }`
 * five and six times respectively — with `err.Error()` interpolated straight
 * into the page. `"error"` was not even one of the levels `statusClass`
 * recognized (views.go:1563-1574), so every diagnostics failure rendered with
 * the default `neutral` styling: a red condition in a grey box.
 *
 * **What HQ does instead.** The dispatcher checks the method and the token
 * before either handler runs, so neither repeats that. Each handler has exactly
 * one `try`, one `catch`, and one patch helper; a failure becomes a `danger`
 * notice — one of `NoticeLevel`'s four members, so it is styled — carrying the
 * `CliError`'s **message only**. `details` reach nothing: `failureEnvelope`'s
 * `redact()` runs on the JSON path, and a notice bypasses it, so a provider
 * response body or a credential reference in `details` would go straight onto
 * the page. The `code` goes to `onDiagnostic`.
 *
 * **The doctor route is offline and never repairs.** It runs the report with
 * `{ offline: true, fix: false }`. The dashboard is a *view*: a GET that patches
 * a panel must not mutate an operator's filesystem permissions, and it must not
 * make a network request on a page repaint. The update card owns the one thing
 * on this dashboard that talks to a registry, and it is Phase 7-2's.
 *
 * **`src/web/` does not import `src/doctor/`.** The report arrives through
 * {@link RouteContext.doctor}, a structurally-declared `() => Promise<unknown>`
 * that `src/cli/dashboard.ts` supplies — the same arrangement
 * `DashboardIntegration` uses, and for the same layering reason. `unknown` is
 * honest: this module only stringifies it.
 *
 * **The capabilities route forces `sites.delete` unsupported**, exactly as
 * `hosting providers capabilities` does, through the shared rule in
 * `src/hosting/capabilities.ts`. HQ registers no delete in either surface, and a
 * dashboard that showed the provider's raw `supported: true` would contradict
 * the CLI about what HQ can do. The provider call itself goes through
 * `services/providers.ts`, not through `HostingClientFactory` directly: no
 * handler in the dashboard resolves a profile into a client, and this one is not
 * about to be the first.
 *
 * **Nothing is interpolated as markup.** Both bodies go through
 * `renderDiagnosticsOutput`, which puts them inside a `<pre>` built by the
 * `html` template, so a provider response containing `<script>` is text.
 */

import { asCliError } from "../../errors.js";
import { patchToast } from "../patch.js";
import type { DashboardRequest } from "../request.js";
import type { DashboardResponse } from "../responses.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import { parseDiagnostics, readQuerySignals } from "../signals-input.js";
import { ALL_PROFILES_SENTINEL } from "../signals.js";
import type { SseStream } from "../sse.js";
import { renderDiagnosticsOutput } from "../views/diagnostics.js";
import type { DashboardNotice } from "../views/types.js";

/**
 * Go's `patchDiagnosticsOutput` (`server.go:908-912`): the panel first, the
 * toast second, and no third fragment. It deliberately never patches `#main` —
 * repainting the page would reset the provider `<select>` the operator just
 * chose from.
 */
export function patchDiagnosticsOutput(
  stream: SseStream,
  notice: DashboardNotice,
  body: string,
): void {
  stream.patchElements(renderDiagnosticsOutput(notice, body), {
    selectorId: "diagnostics-output",
    mode: "outer",
  });
  patchToast(stream, notice);
}

function danger(message: string): DashboardNotice {
  return { level: "danger", message };
}

/**
 * Go's `prettyJSON`: two-space indent, and the whole document.
 *
 * `value ?? null` because `JSON.stringify(undefined)` is `undefined` at runtime
 * while its type says `string`. A provider that answered with nothing renders
 * the literal `null`, which is true, rather than the string `"undefined"`.
 */
function pretty(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

/* -------------------------------------------------------------------------- */
/* GET /_dashboard/diagnostics/doctor                                         */
/* -------------------------------------------------------------------------- */

export function createDiagnosticsDoctorHandler(
  context: RouteContext,
): RouteHandler {
  return (): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      try {
        const report = await context.doctor();
        patchDiagnosticsOutput(
          stream,
          { level: "ok", message: "Doctor report generated." },
          pretty(report),
        );
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/diagnostics/doctor",
          code: cliError.code,
        });
        patchDiagnosticsOutput(stream, danger(cliError.message), "");
      }
      stream.close();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* GET /_dashboard/diagnostics/capabilities                                   */
/* -------------------------------------------------------------------------- */

/**
 * Which profile to ask, in Go's precedence (`server.go:510-516`): `?profile=`
 * first, then the posted signal, which wins when the request carries one.
 */
function selectedProfile(request: DashboardRequest): string {
  const query = (request.query.get("profile") ?? "").trim();
  const signalled = parseDiagnostics(readQuerySignals(request)).profile;
  return signalled === "" ? query : signalled;
}

export function createDiagnosticsCapabilitiesHandler(
  context: RouteContext,
): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      try {
        const profile = selectedProfile(request);
        // "All hosting" is a listing convenience, not a provider. Asking every
        // configured profile for its capability document would be several live
        // API calls behind one click, and the answer would be a pile of
        // documents with no way to tell them apart.
        if (profile === "" || profile === ALL_PROFILES_SENTINEL) {
          patchDiagnosticsOutput(
            stream,
            danger("Select one provider profile first."),
            "",
          );
          stream.close();
          return;
        }
        const document = await context.providers.capabilities(profile);
        patchDiagnosticsOutput(
          stream,
          { level: "ok", message: `Capabilities loaded for ${profile}.` },
          pretty(document),
        );
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/diagnostics/capabilities",
          code: cliError.code,
        });
        patchDiagnosticsOutput(stream, danger(cliError.message), "");
      }
      stream.close();
    },
  });
}
