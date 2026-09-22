// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { join } from "node:path";
import type { VerifiedFileSecurity } from "../config/file-security.js";
import type { ProfileLockManager } from "../config/lock.js";
import { CliError } from "../errors.js";
import { DesktopUpdateChecker, type DesktopUpdateStatus } from "./desktop.js";

export const UPDATE_CHECK_FILE = "desktop-update-check.json";
export const UPDATE_CHECK_LOCK = "__desktop_update_check__";
export type UpdateStatus = DesktopUpdateStatus;
export interface UpdateCheckEnvironment {
  readonly NOVAMIRA_HQ_UPDATE_CHECK?: string;
}

/** CLI and doctor share the desktop release catalog and its private cache. */
export class UpdateChecker {
  private readonly checker: DesktopUpdateChecker;
  readonly releaseSource =
    "https://github.com/use-novamira/novamira-hq/releases";
  readonly recordPath: string;

  constructor(
    stateDir: string,
    _locks: ProfileLockManager,
    security: VerifiedFileSecurity,
    options: {
      currentVersion: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
      now?: () => number;
      statsEnabled?: boolean;
    },
  ) {
    this.recordPath = join(stateDir, UPDATE_CHECK_FILE);
    this.checker = new DesktopUpdateChecker(stateDir, security, {
      current: options.currentVersion,
      ...(options.statsEnabled === undefined
        ? {}
        : { statsEnabled: options.statsEnabled }),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
  }

  async check(): Promise<UpdateStatus> {
    const status = await this.checker.check(true);
    if (!status)
      throw new CliError(
        "network_error",
        "Desktop update check failed. Try again later.",
      );
    return status;
  }

  refresh(): Promise<UpdateStatus | undefined> {
    return this.checker.check();
  }

  async notice(): Promise<string | undefined> {
    try {
      const status = await this.refresh();
      return status?.updateAvailable ? updateNotice(status) : undefined;
    } catch {
      return undefined;
    }
  }
}

export function updateNotice(status: UpdateStatus): string {
  return `A new Novamira HQ desktop release is available: ${status.current} -> ${status.latest}. Download: ${status.downloadUrl ?? status.releaseUrl ?? "https://github.com/use-novamira/novamira-hq/releases"}. Install the desktop download to update; automatic replacement is not implemented.`;
}

export function updateCheckEnabled(
  environment: UpdateCheckEnvironment,
): boolean {
  return (
    environment.NOVAMIRA_HQ_UPDATE_CHECK !== "0" &&
    environment.NOVAMIRA_HQ_UPDATE_CHECK !== "false"
  );
}
