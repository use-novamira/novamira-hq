// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { asRecord } from "../../json.js";

const CHECKS = new Set([
  "runtime.node",
  "storage.permissions",
  "storage.atomic",
  "credential.backend",
  "config.schema",
  "profile.credentials",
  "skills.bundled",
  "integration.site_cli",
  "update.available",
]);

function status(value: unknown): string {
  return value === "pass" || value === "warn" || value === "fail"
    ? value
    : "unknown";
}

/** Positive allowlist: free text and new evidence fields are private by default. */
export function shareableDiagnostics(value: unknown): unknown {
  const report = asRecord(value);
  return {
    version: 1,
    sharing:
      "Local paths, profile names, credential references and detailed evidence omitted.",
    offline: report?.offline === true,
    fix: report?.fix === true,
    status: status(report?.status),
    checks: (Array.isArray(report?.checks) ? report.checks : []).map(
      (value) => {
        const check = asRecord(value);
        return {
          id:
            typeof check?.id === "string" && CHECKS.has(check.id)
              ? check.id
              : "other",
          status: status(check?.status),
        };
      },
    ),
  };
}
