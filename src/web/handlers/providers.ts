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
import { asCliError, CliError } from "../../errors.js";
import { randomUUID } from "node:crypto";
import type { ProviderRemovalView } from "../views/provider-removal.js";
import type { JsonValue } from "../expr.js";
import { patchPage, patchToast } from "../patch.js";
import { readSignals, type DashboardRequest } from "../request.js";
import type { DashboardResponse } from "../responses.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import {
  defaultDashboardSignals,
  defaultProviderFormSignals,
} from "../signals.js";
import { parseProviderForm } from "../signals-input.js";
import type { SseStream } from "../sse.js";
import type { DashboardNotice } from "../views/types.js";
import type { ProviderReadyView } from "../views/provider-ready.js";

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
  ready?: ProviderReadyView,
): Promise<void> {
  const view = await context.loadConfigView();
  patchPage(stream, {
    page: "providers",
    notice,
    model: {
      ...(ready ? { providerReady: ready } : {}),
      view,
      notice,
      // The re-rendered form is closed: the mutation succeeded, or it failed
      // and the operator reopens it from Connect hosting account or Edit.
      // `data-class` then
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

/** What removing a hosting account would also disconnect, and whether we know. */
interface LinkedSites {
  readonly verified: boolean;
  readonly sites: ProviderRemovalView["sites"];
}

/**
 * Read the linked sites out of a fresh inventory.
 *
 * Only a complete inventory counts as verified: the site CLI reachable, this
 * profile present, no group failed or serving a listing kept after a failure,
 * and a live connection index. Anything less and `verified` is false, because a
 * partial inventory is indistinguishable from an account with no linked sites —
 * and that is exactly the difference between keeping a site connection and
 * silently removing it.
 */
function linkedSites(
  inventory: Awaited<ReturnType<RouteContext["sites"]["list"]>>,
  profile: string,
): LinkedSites {
  const verified =
    inventory.siteProfiles.cliAvailable &&
    !inventory.siteProfiles.reason &&
    inventory.groups.some((group) => group.profile === profile) &&
    inventory.groups.every((group) => !group.error && !group.stale) &&
    inventory.connections?.cliAvailable === true;
  // The last clause of `verified` is what proves `connections` is there.
  if (!verified) return { verified, sites: [] };

  const connected = new Set(
    [...inventory.connections.byKey.values()].flatMap(
      (connection) => connection.profiles,
    ),
  );
  return {
    verified,
    sites: inventory.siteProfiles.profiles
      .filter((site) => connected.has(site.name))
      .map(({ name, siteUrl }) => ({ name, siteUrl })),
  };
}

/**
 * True when the site CLI still holds every planned site exactly as planned.
 *
 * The plan was shown to the operator and they approved removing those sites. If
 * the CLI has become unreachable, or any of them has since been renamed,
 * re-pointed or removed, the approval no longer describes what would happen.
 */
function stillExactlyAsPlanned(
  planned: ProviderRemovalView["sites"],
  current: Awaited<ReturnType<RouteContext["integration"]["listProfiles"]>>,
): boolean {
  if (!current.cliAvailable || current.reason) return false;
  return planned.every((site) =>
    current.profiles.some(
      (entry) => entry.name === site.name && entry.siteUrl === site.siteUrl,
    ),
  );
}

export function createProviderSaveHandler(context: RouteContext): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      try {
        const input = parseProviderForm(await readSignals(request));
        const saved = await context.providers.upsert(input);
        context.providers.clearChecked(saved.name);
        let notice: DashboardNotice;
        let ready: ProviderReadyView | undefined;
        try {
          await context.providers.validate(saved.name);
          context.providers.recordChecked(saved.name, context.now());
          notice = mutationNotice(
            `${saved.name}: account saved and access verified.`,
            saved.warning,
          );
          if (!input.force) {
            ready = {
              profile: saved.name,
              provider: input.provider,
            };
          }
        } catch {
          // Saving succeeded: do not invite a second create or suggest that
          // the credential was rejected when the provider may be unreachable.
          notice = mutationNotice(
            "Hosting account saved, but access could not be verified. Check the account details and try Verify access again.",
            saved.warning,
          );
          notice = { ...notice, level: "warn" };
        }
        await patchProvidersPage(
          context,
          stream,
          notice,
          resetFormSignals(),
          ready,
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
  const plans = new Map<string, ProviderRemovalView & { expiresAt: number }>();
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      try {
        // Go read the body here only to find the token. HQ reads it to keep the
        // parse path uniform — an unparseable body from something that is not
        // the dashboard's own page is still a client error — and uses nothing
        // from it.
        await readSignals(request);
        const profile = profileParameter(request);
        const confirmation = request.query.get("confirmation");
        if (!confirmation) {
          for (const [id, plan] of plans)
            if (plan.expiresAt <= Date.now()) plans.delete(id);
          if (plans.size >= 64)
            throw new CliError(
              "conflict",
              "Too many pending removal requests. Try again later.",
            );
          let linked: LinkedSites = { verified: false, sites: [] };
          try {
            linked = linkedSites(
              await context.sites.list({
                profile,
                includeEnvs: true,
                refresh: true,
              }),
              profile,
            );
          } catch {
            /* Never infer an empty list from a failed inventory. */
          }
          const { verified, sites } = linked;
          const plan = {
            profile,
            confirmation: randomUUID(),
            sites,
            verified,
            expiresAt: Date.now() + 300_000,
          };
          plans.set(plan.confirmation, plan);
          patchPage(stream, {
            page: "providers",
            notice: { level: "neutral", message: "" },
            model: {
              view: await context.loadConfigView(),
              notice: { level: "neutral", message: "" },
              signals: defaultDashboardSignals(context.token),
              providerRemoval: plan,
            },
          });
          stream.close();
          return;
        }
        const plan = plans.get(confirmation);
        plans.delete(confirmation);
        if (plan?.profile !== profile || plan.expiresAt <= Date.now())
          throw new CliError(
            "conflict",
            "This removal confirmation expired or was already used. Review the account again.",
          );
        const removeSites = request.query.get("remove_sites");
        if (removeSites !== "true" && removeSites !== "false")
          throw new CliError(
            "usage_error",
            "Choose whether to keep the linked sites.",
          );
        if (removeSites === "true") {
          if (!plan.verified)
            throw new CliError(
              "conflict",
              "Linked sites could not be verified.",
            );
          const current = await context.integration.listProfiles();
          if (!stillExactlyAsPlanned(plan.sites, current))
            throw new CliError(
              "conflict",
              "Saved site connections changed. Review the account again before removing them.",
            );
          for (const site of plan.sites) {
            const outcome = await context.integration.removeProfile(site.name);
            if (outcome.kind !== "done" && outcome.kind !== "missing")
              throw new CliError(
                "integration_unavailable",
                "Some site connections could not be removed. The hosting account was kept. Check Sites before trying again; earlier removals may have completed.",
              );
          }
        }
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
 * Only the inline notice is patched. Never repaint an open form or imply a
 * persistent provider connection by attaching a status badge to the account.
 */
export function createProviderValidateHandler(
  context: RouteContext,
): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      const profile = profileParameter(request);
      const at = context.now();
      try {
        await readSignals(request);
        await context.providers.validate(profile);
        context.providers.recordChecked(profile, at);
        patchToast(stream, ok(`${profile}: access verified.`));
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/providers/validate",
          code: cliError.code,
        });
        const notice = danger(cliError.message);
        patchToast(stream, notice);
      }
      stream.close();
    },
  });
}
