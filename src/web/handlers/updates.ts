// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two update routes: `GET /_dashboard/updates/check` and
 * `POST /_dashboard/updates/install`.
 *
 * **What the Go did.** `handleDashboardUpdateCheck` (`server.go:539-563`) and
 * `handleDashboardUpdateInstall` (`server.go:565-590`). Both re-checked the
 * method by hand. Both interpolated `err.Error()` into the card's `Err` field,
 * which the view rendered verbatim into the page — including whatever an
 * archive download, a checksum mismatch or an `os/exec` failure had put in it.
 * And the install handler carried Go's **signal-token fallback**:
 *
 * ```go
 * signals, err := readDashboardSignals(r)
 * if !s.authorizedDashboardAction(r, signals.Token) { … }
 * ```
 *
 * `authorizedDashboardAction` (server.go:598-600) accepted the token out of the
 * posted JSON body when the header was absent. That is exactly the form a plain
 * cross-origin form post can produce, whereas a custom request header cannot be
 * set cross-origin without a preflight this server never answers.
 *
 * **What HQ does instead.**
 *
 * - *The token check is the dispatcher's, and it is header-only.* Neither
 *   handler reads a token, and `createRouteTable` refuses to build a table where
 *   a `/_dashboard/` row is not `auth: "token"`. Go's body fallback is **not
 *   ported**; the contract forbids a request-body form of the token outright.
 * - *The method check is the dispatcher's too.* `install` is registered POST-only,
 *   so a `GET` is a `405` with an `Allow` header rather than a handler's early
 *   return.
 * - *An error reaches the card as a `CliError`'s `message`, truncated, and never
 *   as installer output.* `details` reach nothing — `failureEnvelope`'s
 *   `redact()` runs on the JSON path and a patched card bypasses it — and the
 *   child's stdout/stderr is consumed by a bounded sink that is **discarded**.
 *   An `npm` that echoed `<script>` would otherwise be rendered; here it is not
 *   rendered at all, and would be text if it were, because the card goes through
 *   the `html` template.
 *
 * **`?silent=true` on the check route** suppresses the "up to date" and "check
 * failed" toasts but **not** the "update available" one (Go 545, 552-560). It is
 * what the card's own `data-init` self-check sends: opening Settings must not
 * toast at you, but it must still tell you there is an update.
 *
 * **`src/web/` does not import `src/update/`.** Both operations arrive through
 * {@link RouteContext.updates}, a structurally-declared pair of functions that
 * `src/cli/dashboard.ts` supplies — the same arrangement `DashboardIntegration`
 * and `DashboardDoctor` use, and for the same layering reason.
 *
 * **Both routes patch `updates-card` first and `toast` second**, matching Go's
 * `patchUpdateCard` (server.go:915-919) and nothing else. Neither touches
 * `#main`: a repaint would discard the card the operator is looking at and
 * re-fire its self-check.
 */

import { asCliError } from "../../errors.js";
import { patchToast } from "../patch.js";
import type { DashboardResponse } from "../responses.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import type { SseStream } from "../sse.js";
import { renderUpdateCard, type UpdateCardView } from "../views/updates.js";
import { EMPTY_NOTICE, type DashboardNotice } from "../views/types.js";

/** How much of a `CliError` message the card will render. Go rendered all of it. */
const MAX_CARD_ERROR_LENGTH = 240;

/** Go's `patchUpdateCard`: the card first, the toast second, and no third. */
export function patchUpdateCard(
  stream: SseStream,
  view: UpdateCardView,
  notice: DashboardNotice,
): void {
  stream.patchElements(renderUpdateCard(view), {
    selectorId: "updates-card",
    mode: "outer",
  });
  // The card already contains a failed check's error message.
  patchToast(stream, view.error ? EMPTY_NOTICE : notice);
}

function boundedMessage(error: unknown): string {
  const { message } = asCliError(error);
  return message.length <= MAX_CARD_ERROR_LENGTH
    ? message
    : `${message.slice(0, MAX_CARD_ERROR_LENGTH - 1)}…`;
}

/** Go's `parseBool` for `?silent=`; anything but a true-ish value is false. */
function isSilent(value: string | null): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

/* -------------------------------------------------------------------------- */
/* GET /_dashboard/updates/check                                              */
/* -------------------------------------------------------------------------- */

export function createUpdateCheckHandler(context: RouteContext): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      if (isSilent(request.query.get("automatic"))) {
        try {
          if (context.updates.automatic) {
            const status = await context.updates.refresh?.();
            if (status?.updateAvailable)
              patchToast(stream, {
                level: "warn",
                message: `Novamira HQ ${status.latest} is available. Open App updates to download it.`,
              });
          }
        } catch {
          /* Automatic checks never interrupt the dashboard. */
        }
        stream.close();
        return;
      }
      if (context.updates.available === false) {
        patchUpdateCard(
          stream,
          {
            checked: false,
            current: context.version,
            updateAvailable: false,
            unavailable: true,
          },
          EMPTY_NOTICE,
        );
        stream.close();
        return;
      }
      const silent = isSilent(request.query.get("silent"));
      try {
        const status = await context.updates.check();
        const view: UpdateCardView = {
          desktop: context.updates.desktop === true,
          ...(status.downloadUrl === undefined
            ? {}
            : { downloadUrl: status.downloadUrl }),
          ...(status.releaseUrl === undefined
            ? {}
            : { releaseUrl: status.releaseUrl }),
          checked: true,
          current: status.current,
          latest: status.latest,
          updateAvailable: status.updateAvailable,
          checkedAt: status.checkedAt,
          ...(status.registry === undefined
            ? {}
            : { registry: status.registry }),
        };
        const notice: DashboardNotice = status.updateAvailable
          ? {
              level: "warn",
              message: `Novamira HQ ${status.latest} is available.`,
            }
          : silent
            ? EMPTY_NOTICE
            : { level: "ok", message: "Novamira HQ is up to date." };
        patchUpdateCard(stream, view, notice);
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/updates/check",
          code: cliError.code,
        });
        patchUpdateCard(
          stream,
          {
            checked: true,
            current: context.version,
            updateAvailable: false,
            error: boundedMessage(cliError),
            desktop: context.updates.desktop === true,
          },
          silent
            ? EMPTY_NOTICE
            : { level: "danger", message: "Update check failed." },
        );
      }
      stream.close();
    },
  });
}

/* -------------------------------------------------------------------------- */
/* POST /_dashboard/updates/install                                           */
/* -------------------------------------------------------------------------- */

export function createUpdateInstallHandler(
  context: RouteContext,
): RouteHandler {
  return (): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      if (context.updates.available === false) {
        patchUpdateCard(
          stream,
          {
            checked: false,
            current: context.version,
            updateAvailable: false,
            unavailable: true,
          },
          EMPTY_NOTICE,
        );
        stream.close();
        return;
      }
      try {
        const result = await context.updates.install();
        // `updated: false` means the checker found nothing newer; the install
        // never ran. That is an `ok` notice, not a failure — Go said the same.
        if (!result.updated) {
          patchUpdateCard(
            stream,
            {
              checked: true,
              current: result.from,
              latest: result.to,
              updateAvailable: false,
            },
            { level: "ok", message: "Novamira HQ is already up to date." },
          );
          stream.close();
          return;
        }
        patchUpdateCard(
          stream,
          {
            checked: true,
            current: result.from,
            latest: result.to,
            updateAvailable: false,
            installed: true,
            command: result.command,
          },
          {
            level: "ok",
            message:
              "Update installed. Restart the dashboard to use the new version.",
          },
        );
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/updates/install",
          code: cliError.code,
        });
        patchUpdateCard(
          stream,
          {
            checked: true,
            current: context.version,
            updateAvailable: false,
            error: boundedMessage(cliError),
            desktop: context.updates.desktop === true,
          },
          { level: "danger", message: "Update install failed." },
        );
      }
      stream.close();
    },
  });
}
