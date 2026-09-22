// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SITE_CLI_OVERRIDE_ENV } from "../connection-state.js";

export {
  SITE_CLI_INSTALL_HINT,
  SITE_CLI_OVERRIDE_ENV,
} from "../connection-state.js";
export const SITE_CLI_COMMAND = "novamira";

/** A child executable and fixed arguments preceding public site-CLI argv. */
export interface SiteCliResolution {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export type ResolveSiteCli = () => Promise<SiteCliResolution | undefined>;

export interface SiteCliResolverOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly isFile: (candidate: string) => Promise<boolean>;
  readonly execPath?: string;
  /** Desktop injects its own executable and --site-cli role. */
  readonly packagedTarget?: SiteCliResolution;
  /** Test seam: production resolves only from this HQ installation. */
  readonly resolveEntry?: () => string;
}

export async function nodeIsFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** No PATH discovery or global npm layout probing, including on damaged installs. */
export function createSiteCliResolver(
  options: SiteCliResolverOptions,
): ResolveSiteCli {
  let cached: SiteCliResolution | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    const override = options.environment[SITE_CLI_OVERRIDE_ENV]?.trim();
    if (override) {
      // Windows script shims require a shell or an external Node executable.
      // Neither is implied by a desktop process.execPath; require a native image.
      if (options.platform === "win32" && !/\.(exe|com)$/i.test(override))
        return undefined;
      return (cached = { command: override, prefixArgs: [] });
    }
    if (options.packagedTarget !== undefined)
      return (cached = options.packagedTarget);
    try {
      const entry = (
        options.resolveEntry ??
        (() => import.meta.resolve("@novamira/cli/entry"))
      )();
      const wrapper = fileURLToPath(
        new URL("./bundled-entry.js", import.meta.url),
      );
      if (
        !(await options.isFile(fileURLToPath(entry))) ||
        !(await options.isFile(wrapper))
      )
        return undefined;
      return (cached = {
        command: options.execPath ?? process.execPath,
        prefixArgs: [wrapper],
      });
    } catch {
      return undefined;
    }
  };
}
