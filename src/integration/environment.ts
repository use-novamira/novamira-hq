// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Use the same executable search path for resolution and shebang execution. */
export function siteCliEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  // An explicitly empty PATH is an intentional isolated environment.
  if (platform === "darwin" && environment.PATH !== "") {
    const entries = (environment.PATH ?? "").split(":").filter(Boolean);
    result.PATH = [
      ...new Set([
        ...entries,
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ]),
    ].join(":");
  }
  // Supported by Node 22.19+/24.6+. Never disable TLS verification or modify
  // the user's trust store; preserve an explicit operator override.
  result.NODE_USE_SYSTEM_CA ??= "1";
  return result;
}
