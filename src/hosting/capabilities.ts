// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Post-processing of a provider's capability document, in one place below the
 * CLI.
 *
 * **Why it moved here.** Go's `disabledSiteDeleteCapability` lived beside the
 * CLI's printers, and so did HQ's port, in `src/cli/print.ts`. That was correct
 * while `hosting providers capabilities` was the only caller. Phase 7 adds a
 * second one — the dashboard's `/_dashboard/diagnostics/capabilities` route —
 * and `src/web/` may not import `src/cli/`. So the rule lives here, beside the
 * `ProviderCapability` type it is about, and `src/cli/print.ts` re-exports it
 * for every existing caller. This is the same move `operations.ts` made out of
 * `hosting-command.ts` for `src/provisioning/`, for the same reason.
 *
 * **The rule itself.** `hosting sites delete` is deliberately not registered and
 * the dashboard offers no delete, so a provider that advertises `sites.delete`
 * must not be reported as offering it *through HQ*. The capability is rewritten
 * to `supported: false` with a fixed note, in both surfaces, so the two cannot
 * disagree about what HQ can do. A response that is not a capability list is
 * returned unchanged — Go's "unmarshal failed, pass it through" — because a
 * provider client is allowed to answer with a shape HQ does not model.
 */

import {
  serializeProviderCapability,
  type ProviderCapability,
} from "./types.js";

/** The capability HQ reports as unsupported regardless of the provider. */
export const SITE_DELETE_CAPABILITY = "sites.delete";

/** Why {@link SITE_DELETE_CAPABILITY} is reported unsupported. */
export const SITE_DELETE_DISABLED_NOTE =
  "site deletion is not exposed by Novamira HQ";

function asCapability(value: unknown): ProviderCapability | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const name = record.name;
  const supported = record.supported;
  const notes = record.notes;
  if (typeof name !== "string" || typeof supported !== "boolean")
    return undefined;
  if (typeof notes === "string" && notes !== "")
    return { name, supported, notes };
  if (notes !== undefined && notes !== null && typeof notes !== "string")
    return undefined;
  return { name, supported };
}

/** Go's `disabledSiteDeleteCapability`, behaviour for behaviour. */
export function disableSiteDeleteCapability(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const capabilities: ProviderCapability[] = [];
  for (const entry of value as readonly unknown[]) {
    const capability = asCapability(entry);
    if (capability === undefined) return value;
    capabilities.push(
      capability.name === SITE_DELETE_CAPABILITY
        ? {
            name: capability.name,
            supported: false,
            notes: SITE_DELETE_DISABLED_NOTE,
          }
        : capability,
    );
  }
  return capabilities.map(serializeProviderCapability);
}
