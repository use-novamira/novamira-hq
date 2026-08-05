// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Deploy-path upsert and remove, and the two validation rules the form cannot
 * express.
 *
 * **What the Go did.** `upsertDeployPath` (`server.go:779-800`) checked the
 * required fields, checked that source and target differ, loaded the whole
 * config, wrote the map entry and saved — all under the server's one mutex —
 * and `handleDashboardDeployPathRemove` (`:802-828`) did a bare
 * `delete(cfg.DeployPaths, name)` followed by a save, which meant clicking
 * Remove on a row that had already been removed in another tab reported
 * success and rewrote the file for nothing.
 *
 * **What HQ does instead.** `ConfigStore` owns the locking, the atomic write and
 * the owner-only permissions, so this module is exactly what Go's method had
 * left once those were taken away: two validations and a call. The removal path
 * uses `removeDeployPath`, which raises `not_found` when the entry is absent —
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
import {
  validateDeployPathName,
  type DeployPath,
} from "../../config/schema.js";
import { CliError } from "../../errors.js";
import type { DeployFormInput } from "../signals-input.js";

export interface DeployPathService {
  /** Validate and persist; returns the saved name. */
  upsert(input: DeployFormInput): Promise<string>;
  /** Remove; raises `not_found` when the path is not there. Returns the name. */
  remove(name: string): Promise<string>;
}

export interface DeployPathServiceOptions {
  readonly store: ConfigStore;
}

export function createDeployPathService(
  options: DeployPathServiceOptions,
): DeployPathService {
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
      const name = validateDeployPathName(input.name);
      // The eleven persisted fields, and only those: `deployForm.open` is UI
      // state and `signals-input.ts` does not parse it.
      const deployPath: DeployPath = {
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
      await options.store.upsertDeployPath(deployPath);
      return name;
    },

    remove: async (name) => {
      const key = validateDeployPathName(name);
      await options.store.removeDeployPath(key);
      return key;
    },
  };
}
