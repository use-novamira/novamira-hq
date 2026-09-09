// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { atomicWriteFile } from "./atomic-write.js";
import type { VerifiedFileSecurity } from "./file-security.js";
import { appAcknowledgementPath, type PlatformPaths } from "./paths.js";
import { asRecord } from "../json.js";
import { CliError } from "../errors.js";

/** App onboarding only. Never consulted by CLI or MCP operations. */
export interface AppAcknowledgement {
  accepted(): Promise<boolean>;
  accept(): Promise<void>;
}

export function createAppAcknowledgement(
  paths: PlatformPaths,
  security: VerifiedFileSecurity,
): AppAcknowledgement {
  const file = appAcknowledgementPath(paths);
  return {
    async accepted() {
      try {
        const info = await lstat(file);
        if (
          !info.isFile() ||
          info.size > 1024 ||
          !(await security.verifyFile(file))
        )
          throw new Error("unsafe");
        const handle = await open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          if ((await handle.stat()).size > 1024) throw new Error("oversized");
          const value = asRecord(
            JSON.parse(await handle.readFile("utf8")) as unknown,
          );
          return (
            value?.version === 1 &&
            typeof value.acceptedAt === "string" &&
            Number.isFinite(Date.parse(value.acceptedAt))
          );
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new CliError(
          "config_error",
          "The application acknowledgement record is unreadable or unsafe.",
        );
      }
    },
    async accept() {
      await atomicWriteFile(
        file,
        JSON.stringify({ version: 1, acceptedAt: new Date().toISOString() }),
        security,
      );
    },
  };
}
