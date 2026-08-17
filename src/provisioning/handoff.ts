// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The handoff HQ emits instead of a credential.
 *
 * Go's `hosting novamira setup` ended by creating a WordPress Application
 * Password, storing it in a `site_profiles` entry, and printing the profile
 * name and config path. Under the boundary rule none of that exists: HQ never
 * holds a WordPress site token, never calls a REST route on a configured site's
 * behalf, and never proxies an Ability. What it emits instead is the one
 * command the operator runs next, on the separate `novamira` CLI, which is the
 * tool that does hold the credential.
 *
 * Both renderings come from one {@link Handoff} so the human line and the JSON
 * `next_step` cannot drift. `command` is argv with no shell in it, so Phase 6's
 * dashboard can spawn it verbatim; `commandLine` is the copyable fallback.
 *
 * `novamira auth login <url>` carries NO `--name` and NO `--no-open`. Profile
 * naming belongs to the site CLI (it is the tool that owns the profile), and
 * whether a browser opens is the operator's call, not HQ's.
 */

import type { NovamiraSetupResult } from "./setup.js";
import { redactText } from "../output/redact.js";

/** The separate CLI that owns the site credential. HQ only prints its name. */
export const SITE_CLI_EXECUTABLE = "novamira";

export interface Handoff {
  /** argv, no shell. The dashboard's Connect action spawns this verbatim. */
  readonly command: readonly string[];
  /** The copyable one-line fallback. */
  readonly commandLine: string;
}

/** `novamira auth login <url>`. */
export function connectHandoff(siteUrl: string): Handoff {
  const command = [SITE_CLI_EXECUTABLE, "auth", "login", siteUrl];
  return { command, commandLine: command.join(" ") };
}

/**
 * The `data` member of the success envelope, frozen in `docs/v1-contract.md`.
 *
 * snake_case throughout: the surviving Go struct tags used it, and the
 * `compatibility` block keeps the plugin's own spellings so it is byte-
 * comparable with what `/.well-known/oauth-protected-resource` served.
 *
 * `site_profile`, `username`, `credential`, `rest_url` and `config_path` are
 * permanently absent. `config_path` in particular existed only because Go wrote
 * a `site_profiles` entry; HQ writes nothing.
 */
export function handoffData(
  result: NovamiraSetupResult,
): Record<string, unknown> {
  return {
    hosting_profile: result.hostingProfile,
    env: result.envId,
    url: result.siteUrl,
    plugin: {
      slug: result.plugin.slug,
      source: redactText(result.plugin.source),
      version: result.plugin.version,
      activated: result.plugin.activated,
      network_activated: result.plugin.networkActivated,
    },
    ai_abilities: {
      enabled: result.aiAbilities.enabled,
      domain: result.aiAbilities.domain,
    },
    compatibility: {
      status: result.compatibility.status,
      metadata_url: result.compatibility.metadataUrl,
      plugin_version: result.compatibility.pluginVersion,
      rest_api_version: result.compatibility.restApiVersion,
      wordpress_version: result.compatibility.wordpressVersion,
      minimum_wordpress_version: result.compatibility.minimumWordpressVersion,
      features: result.compatibility.features,
    },
    ready: result.ready,
    next_step: {
      tool: SITE_CLI_EXECUTABLE,
      command: [...result.handoff.command],
      command_line: result.handoff.commandLine,
    },
  };
}

/**
 * The human-mode stdout block.
 *
 * The migration plan illustrates the first line with a leading `✓`. The glyph
 * is deliberately dropped: nothing else in HQ's human output uses one
 * (`src/cli/print.ts` is entirely unstyled ASCII), the renderer has no
 * success-styling helper, and a non-ASCII glyph on a Windows console is a
 * needless failure mode. The two-line shape and the two-space indent are kept.
 */
export function handoffHuman(result: NovamiraSetupResult): string {
  const state = result.plugin.activated
    ? "installed and activated"
    : "installed";
  const version = result.compatibility.pluginVersion;
  const headline =
    version === null
      ? `Novamira ${state} on ${result.siteUrl}`
      : `Novamira ${version} ${state} on ${result.siteUrl}`;
  const lines = [headline];
  if (result.compatibility.status === "skipped")
    lines.push("  Compatibility not checked (--no-compat-check).");
  lines.push(`  Connect your agent:  ${result.handoff.commandLine}`);
  return lines.join("\n");
}
