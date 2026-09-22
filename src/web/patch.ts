// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The two SSE patch shapes every dashboard handler uses: "repaint this page" and
 * "just say something".
 *
 * **What the Go did.** Four copies of the same three lines.
 * `patchProvidersPageWithConfig`, `patchSitesPageWithConfig`,
 * `patchPushesPageWithConfig` and `patchSetupMain` (`server.go:865-906`)
 * each opened an SSE generator, optionally marshalled a signal patch, and then
 * patched `#main`, `#nav` and `#toast` — except `patchSetupMain`, which omitted
 * `#nav` for no stated reason, so the setup page's active nav link went stale
 * after a start. Copy four is where a divergence like that hides.
 *
 * **What HQ does instead.** One {@link patchPage}. Every page-level handler
 * sends the identical sequence, so the divergence is not possible; the setup
 * handler now repaints `#nav` too, which is harmless (the link was already
 * active) and removes the special case.
 *
 * **The order is load-bearing and is Go's.** Signals first, then `#main`, then
 * `#nav`, then `#toast`. The RFC 7386 merge-patch has to land *before* the
 * markup, because the replaced `#main` mounts with whatever is in the signal
 * store at that moment: send the reset `providerForm` after the new form and the
 * form paints for one frame carrying the values the operator just submitted —
 * including, on the save path, the credential field. `#toast` goes last so the
 * notice appears with the page it describes rather than before it.
 *
 * **Nothing here formats an error.** A handler passes a {@link DashboardNotice}
 * it has already built from `asCliError(error).message`; `CliError.details`
 * never reaches a notice, because `failureEnvelope`'s `redact()` runs on the
 * JSON path only and a notice bypasses it entirely.
 */

import type { JsonValue } from "./expr.js";
import type { SseStream } from "./sse.js";
import { renderMain, renderNav, renderToast } from "./views/layout.js";
import { renderPageBody, type PageModel } from "./views/pages.js";
import type { DashboardNotice, DashboardPage } from "./views/types.js";

export interface PagePatch {
  readonly page: DashboardPage;
  readonly model: PageModel;
  readonly notice: DashboardNotice;
  /**
   * An RFC 7386 merge-patch over the client's signal store, sent **before** the
   * element patches. Typically `{ providerForm: defaultProviderFormSignals(…) }`
   * or `{ pushForm: defaultPushFormSignals() }` — a form reset.
   */
  readonly signals?: Readonly<Record<string, JsonValue>>;
}

/** signals → `#main` (outer) → `#nav` (outer) → `#toast` (outer). Always. */
export function patchPage(stream: SseStream, patch: PagePatch): void {
  if (patch.signals !== undefined) {
    stream.patchSignals(patch.signals);
  }
  stream.patchElements(
    renderMain(patch.page, renderPageBody(patch.page, patch.model)),
    { selectorId: "main", mode: "outer" },
  );
  stream.patchElements(renderNav(patch.page), {
    selectorId: "nav",
    mode: "outer",
  });
  // Providers already render their notice inside the page.
  patchToast(
    stream,
    patch.page === "providers"
      ? { level: "neutral", message: "" }
      : patch.notice,
  );
}

/**
 * `#toast` (outer) and nothing else.
 *
 * This is the whole response for an action that must **not** repaint the page —
 * `providers/validate` is the case that matters, because repainting `#main`
 * would replace the provider table out from under an open form and discard what
 * the operator had typed into it.
 */
export function patchToast(stream: SseStream, notice: DashboardNotice): void {
  stream.patchElements(renderToast(notice), {
    selectorId: "toast",
    mode: "outer",
  });
}
