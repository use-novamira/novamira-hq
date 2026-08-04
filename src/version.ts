// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * HQ's own version string, as one leaf module with no imports.
 *
 * It used to be declared in `src/main.ts`, next to the composition root that
 * hands it to commander. Phase 5's compatibility preflight sends
 * `User-Agent: novamira-hq/<version>` on the single site-directed request, and
 * `src/provisioning/` may not import `src/cli/` or the composition root that
 * builds it — that would close a cycle through the command tree. Rather than
 * duplicate the literal and let the two drift, the constant lives here and
 * `src/main.ts` re-exports it, so `test/cli-program-contract.test.mjs`'s
 * `VERSION === package.json.version` assertion is unchanged.
 */

/** Kept in step with `package.json`'s `version`; the release job matches them. */
export const VERSION = "0.1.0";
