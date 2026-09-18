// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = "Novamira HQ Credentials.app";
const EXECUTABLE = "Contents/MacOS/novamira-hq-keychain";

/** Fixed install locations only: never PATH, cwd, a request, or an env override. */
export function macOsHelperPath(executable = process.execPath): string {
  const candidates = [
    join(dirname(executable), "..", "Helpers", BUNDLE, EXECUTABLE),
    join(dirname(executable), BUNDLE, EXECUTABLE),
    fileURLToPath(
      new URL(`../../native/macos/${BUNDLE}/${EXECUTABLE}`, import.meta.url),
    ),
  ];
  return (
    candidates.find((path) => existsSync(path)) ??
    fileURLToPath(
      new URL(`../../native/macos/${BUNDLE}/${EXECUTABLE}`, import.meta.url),
    )
  );
}
