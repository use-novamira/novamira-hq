// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Use the same executable search path for resolution and shebang execution. */
export function siteCliEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  result.NOVAMIRA_UPDATE_CHECK = "0";
  // HQ validates dashboard URLs with its own opt-in. Translate it for the
  // child so an accepted development URL also passes the CLI's validation.
  if (environment.NOVAMIRA_HQ_ALLOW_INSECURE_HTTP === "1") {
    result.NOVAMIRA_ALLOW_INSECURE_HTTP = "1";
  }
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
