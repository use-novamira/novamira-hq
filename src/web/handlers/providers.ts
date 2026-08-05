// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The three provider routes: `/_dashboard/providers/{save,remove,validate}`.
 *
 * **What the Go did.** `handleDashboardProviderSave`, `…Remove` and `…Validate`
 * (`server.go:234-315`) each re-checked the method, re-read the signals,
 * re-checked authorization — accepting the token out of the **request body** as
 * well as the header (`authorizedDashboardAction`, `server.go:601-603`) — and
 * then hand-rolled an SSE response. Three copies of four concerns.
 *
 * **What HQ does instead.** The route table checks the method and the token
 * before a handler runs, and the token is header-only: a custom request header
 * cannot be set cross-origin without a preflight this server never answers,
 * whereas a *body* can be produced by a plain cross-origin form post. A `token`
 * field in the posted signals is read past and ignored.
 *
 * **Every handler catches its own errors.** `dispatch` turns an escaping throw
 * into a JSON failure envelope, which is the wrong answer on an SSE route: the
 * browser's Datastar client is waiting for a patch stream and would simply see
 * the request fail with nothing on screen. So each handler below wraps its work,
 * turns `asCliError(error)` into a `danger` notice carrying the **message only**,
 * and sends the patch set its route documents. The `code` goes to
 * `onDiagnostic`, never to the page — and `details` goes nowhere at all, because
 * `failureEnvelope`'s `redact()` runs on the JSON path and a notice bypasses it.
 *
 * **The credential path, stated once.** `providers/save` is the only route in
 * HQ through which a provider secret travels. It arrives in the request body, in
 * `providerForm.credentialValue`, is parsed by `signals-input.ts` (which does
 * not trim it), and is handed to `services/providers.ts`, which writes it to the
 * credential store. It is never read back: the success patch explicitly resets
 * `providerForm` to `defaultProviderFormSignals`, whose `credentialValue` is
 * `""`, and the re-rendered page has no field that could hold one. Neither the
 * remove nor the validate route reads the form subtree at all — their `@post`s
 * are scoped to `/^(token)(\.|$)/`, so the secret is not even sent.
 */

import { PROVIDER_KINDS } from "../../config/schema.js";
import { asCliError } from "../../errors.js";
import type { JsonValue } from "../expr.js";
import { patchPage, patchToast } from "../patch.js";
import { connCellId } from "../patches.js";
import { readSignals, type DashboardRequest } from "../request.js";
import type { DashboardResponse } from "../responses.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import {
  defaultDashboardSignals,
  defaultProviderFormSignals,
} from "../signals.js";
import { parseProviderForm } from "../signals-input.js";
import type { SseStream } from "../sse.js";
import { renderConnCell, renderProviderFlash } from "../views/providers.js";
import type { DashboardNotice } from "../views/types.js";

/** The reset every provider mutation sends before the new markup. */
function resetFormSignals(): Readonly<Record<string, JsonValue>> {
  return { providerForm: { ...defaultProviderFormSignals(PROVIDER_KINDS[0]) } };
}

function danger(message: string): DashboardNotice {
  return { level: "danger", message };
}

function ok(message: string): DashboardNotice {
  return { level: "ok", message };
}

/** A mutation's notice: `ok`, or `warn` when a best-effort step failed. */
function mutationNotice(
  message: string,
  warning: string | undefined,
): DashboardNotice {
  return warning === undefined
    ? ok(message)
    : { level: "warn", message: `${message} ${warning}` };
}

/**
 * Repaint the providers page.
 *
 * `loadConfigView` is re-read rather than mutated in place, so the page shows
 * what is actually on disk after the write — including a name normalization or a
 * credential reference the operator did not type.
 */
async function patchProvidersPage(
  context: RouteContext,
  stream: SseStream,
  notice: DashboardNotice,
  signals?: Readonly<Record<string, JsonValue>>,
): Promise<void> {
  const view = await context.loadConfigView();
  patchPage(stream, {
    page: "providers",
    notice,
    model: {
      view,
      notice,
      // The re-rendered form is closed: the mutation succeeded, or it failed
      // and the operator reopens it from Add Profile or Edit. `data-class` then
      // follows `$providerForm.open`, which the client still owns.
      signals: defaultDashboardSignals(context.token, {
        firstProviderKind: PROVIDER_KINDS[0],
      }),
    },
    ...(signals === undefined ? {} : { signals }),
  });
}

/** `?profile=`, trimmed. Go's `strings.TrimSpace(r.URL.Query().Get(...))`. */
function profileParameter(request: DashboardRequest): string {
  return (request.query.get("profile") ?? "").trim();
}

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/providers/save                                            */
/* -------------------------------------------------------------------------- */

export function createProviderSaveHandler(context: RouteContext): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      try {
        const input = parseProviderForm(await readSignals(request));
        const saved = await context.providers.upsert(input);
        await patchProvidersPage(
          context,
          stream,
          mutationNotice("Provider profile saved.", saved.warning),
          resetFormSignals(),
        );
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/providers/save",
          code: cliError.code,
        });
        // No signal patch on the failure path: the operator's typed values stay
        // in the form so a name collision or a validation failure can be fixed
        // without retyping the credential.
        await patchProvidersPage(context, stream, danger(cliError.message));
      }
      stream.close();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/providers/remove                                          */
/* -------------------------------------------------------------------------- */

export function createProviderRemoveHandler(
  context: RouteContext,
): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      try {
        // Go read the body here only to find the token. HQ reads it to keep the
        // parse path uniform — an unparseable body from something that is not
        // the dashboard's own page is still a client error — and uses nothing
        // from it.
        await readSignals(request);
        const removed = await context.providers.remove(
          profileParameter(request),
        );
        await patchProvidersPage(
          context,
          stream,
          mutationNotice(`${removed.name} removed.`, removed.warning),
          resetFormSignals(),
        );
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/providers/remove",
          code: cliError.code,
        });
        await patchProvidersPage(context, stream, danger(cliError.message));
      }
      stream.close();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/providers/validate                                        */
/* -------------------------------------------------------------------------- */

/**
 * Check one profile's credential against the live provider API.
 *
 * This route **never patches `#main`**, and that is the whole reason it patches
 * a computed fragment id instead: repainting the page would replace the provider
 * table under an open form and discard whatever the operator had typed. It
 * replaces exactly one `<td>`.
 *
 * Note the asymmetry Go established and HQ keeps (`server.go:307-311`): both
 * paths render the timestamp, but only the success path *records* it. So a
 * failed check shows how long ago it happened without the row ever inferring
 * "connected" from a stamp — see `views/types.ts`.
 */
export function createProviderValidateHandler(
  context: RouteContext,
): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      const profile = profileParameter(request);
      const at = context.now();
      let parsed = false;
      try {
        await readSignals(request);
        parsed = true;
        await context.providers.validate(profile);
        context.providers.recordChecked(profile, at);
        stream.patchElements(renderConnCell(profile, "connected", at), {
          selectorId: connCellId(profile),
          mode: "outer",
        });
        patchToast(stream, ok(`${profile} is connected.`));
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/providers/validate",
          code: cliError.code,
        });
        const notice = danger(cliError.message);
        if (parsed && profile !== "") {
          stream.patchElements(renderConnCell(profile, "error", at), {
            selectorId: connCellId(profile),
            mode: "outer",
          });
        } else {
          // A malformed body, or no profile at all, means there is no cell to
          // patch — `connCellId("")` is itself an error. Go's `patchProviderFlash`
          // (`server.go:299`) exists for exactly this, and it is the only
          // producer of the `provider-flash` fragment.
          stream.patchElements(renderProviderFlash(notice), {
            selectorId: "provider-flash",
            mode: "outer",
          });
        }
        patchToast(stream, notice);
      }
      stream.close();
    },
  });
}
