// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Saved-push upsert and remove, and the validation rules the form cannot
 * express.
 *
 * **What the Go did.** `upsertSavedPush` (`server.go:779-800`) checked the
 * required fields, checked that source and target differ, loaded the whole
 * config, wrote the map entry and saved — all under the server's one mutex —
 * and `handleDashboardSavedPushRemove` (`:802-828`) did a bare
 * `delete(cfg.Pushes, name)` followed by a save, which meant clicking
 * Remove on a row that had already been removed in another tab reported
 * success and rewrote the file for nothing.
 *
 * **What HQ does instead.** `ConfigStore` owns the locking, the atomic write and
 * the owner-only permissions, so this module is exactly what Go's method had
 * left once those were taken away: validation and a call. Removing a push
 * uses `removeSavedPush`, which raises `not_found` when the entry is absent —
 * the operator clicked a row, so the row must have existed, and reporting
 * "removed" for something that was not there hides a real disagreement between
 * two windows.
 *
 * **Why a service and not just the handler.** So the handler holds no business
 * rules: it parses signals, calls one method, and patches. The two validation
 * sentences are Go's, word for word, because they are the ones an operator sees
 * in the toast.
 */

import type { ConfigStore } from "../../config/profiles.js";
import { validateSavedPushName, type SavedPush } from "../../config/schema.js";
import { CliError } from "../../errors.js";
import type { PushFormInput } from "../signals-input.js";

export interface PushService {
  /** Validate and persist; returns the saved name. */
  upsert(input: PushFormInput): Promise<string>;
  /** Remove; raises `not_found` when the push is not there. Returns the name. */
  remove(name: string): Promise<string>;
}

export interface PushServiceOptions {
  readonly store: ConfigStore;
}

export function createPushService(options: PushServiceOptions): PushService {
  return {
    upsert: async (input) => {
      if (
        input.name === "" ||
        input.hostingProfile === "" ||
        input.siteId === "" ||
        input.sourceEnvId === "" ||
        input.targetEnvId === ""
      ) {
        throw new CliError(
          "usage_error",
          "name, hosting profile, site, source and target environments are all required.",
        );
      }
      if (input.sourceEnvId === input.targetEnvId) {
        throw new CliError(
          "usage_error",
          "source and target environments must differ.",
        );
      }
      if (!input.pushDb && !input.pushFiles) {
        throw new CliError(
          "usage_error",
          "Choose Database, All files, or both before saving the push.",
        );
      }
      if (input.searchReplace && !input.pushDb) {
        throw new CliError(
          "usage_error",
          "Search and replace URLs requires Database.",
        );
      }
      const name = validateSavedPushName(input.name);
      // The eleven persisted fields, and only those: `pushForm.open` is UI
      // state and `signals-input.ts` does not parse it.
      const push: SavedPush = {
        name,
        hostingProfile: input.hostingProfile,
        siteId: input.siteId,
        siteLabel: input.siteLabel,
        sourceEnvId: input.sourceEnvId,
        sourceEnvName: input.sourceEnvName,
        targetEnvId: input.targetEnvId,
        targetEnvName: input.targetEnvName,
        pushDb: input.pushDb,
        pushFiles: input.pushFiles,
        searchReplace: input.searchReplace,
      };
      await options.store.upsertSavedPush(push);
      return name;
    },

    remove: async (name) => {
      const key = validateSavedPushName(name);
      await options.store.removeSavedPush(key);
      return key;
    },
  };
}
