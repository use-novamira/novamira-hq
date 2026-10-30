// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../errors.js";
import type { ProviderClient } from "../hosting/client.js";
import type { OperationStatus } from "../hosting/types.js";
import { asRecord } from "../json.js";
import { compareSemverStrings, isSemver } from "../semver.js";
import { MINIMUM_NOVAMIRA_VERSION } from "./compatibility.js";
import { NOVAMIRA_PLUGIN_SLUG, pluginIsInstalledCommand } from "./plugin.js";
import {
  contextualize,
  runWpCli,
  runWpCliForOutput,
  type PollBudget,
} from "./wp-cli.js";

export const EXISTING_NOVAMIRA_COMMAND =
  "wp plugin list --name=novamira --format=json";
export const EXISTING_AI_COMMAND =
  "wp option list --search=novamira_ai_abilities_enabled --format=json";
export const EXISTING_AI_DOMAIN_COMMAND =
  "wp option list --search=novamira_ai_abilities_domain --format=json";

export interface ExistingNovamira {
  readonly version: string;
  readonly active: boolean;
  readonly networkActive: boolean;
  readonly aiEnabled: boolean;
  readonly aiDomain: string | null;
}

function rows(output: string): readonly unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    value = undefined;
  }
  if (!Array.isArray(value))
    throw new CliError(
      "provider_error",
      "Cannot safely inspect the existing Novamira installation. No installation or option changes were made.",
    );
  return value as unknown[];
}

/**
 * The one inspection that survives a provider keeping only WP-CLI's exit status
 * (Kinsta): `wp plugin is-installed` writes nothing and answers through that
 * status alone. The version and the AI Abilities options stay unread, so the
 * public compatibility read after setup is what verifies them.
 *
 * A failed probe means "absent". If it failed for another reason, the install
 * that follows refuses the existing directory and reports the already-installed
 * hint, so the worst outcome is a failed run that changed nothing.
 */
export async function novamiraInstalledByExitStatus(
  client: ProviderClient,
  envId: string,
  budget: PollBudget,
): Promise<boolean> {
  let status: OperationStatus | undefined;
  try {
    status = await runWpCli(
      client,
      envId,
      pluginIsInstalledCommand(NOVAMIRA_PLUGIN_SLUG),
      budget,
    );
  } catch (error) {
    throw contextualize(
      error,
      "Failed to check for an existing Novamira installation",
    );
  }
  // A synchronous answer carries no exit status to read.
  if (status === undefined)
    throw new CliError(
      "provider_error",
      "Cannot safely inspect the existing Novamira installation. No installation or option changes were made.",
    );
  return !status.failed;
}

/** Read-only provider WP-CLI inspection; no site REST or site credential. */
export async function inspectExistingNovamira(
  client: ProviderClient,
  envId: string,
  budget: PollBudget,
): Promise<ExistingNovamira | undefined> {
  const plugins =
    client.provider === "hostinger" ||
    client.provider === "cloudways" ||
    client.provider === "plesk"
      ? rows(
          JSON.stringify(await client.read({ kind: "plugins", envId })),
        ).filter((entry) => asRecord(entry)?.name === "novamira")
      : rows(
          await runWpCliForOutput(
            client,
            envId,
            EXISTING_NOVAMIRA_COMMAND,
            budget,
          ),
        );
  if (plugins.length === 0) return undefined;
  const plugin = asRecord(plugins[0]);
  if (
    plugins.length !== 1 ||
    plugin?.name !== "novamira" ||
    typeof plugin.version !== "string" ||
    !isSemver(plugin.version) ||
    !(["active", "active-network", "inactive"] as readonly unknown[]).includes(
      plugin.status,
    )
  )
    throw new CliError(
      "server_unsupported",
      "The existing Novamira version or activation state cannot be verified. No plugin changes were made.",
    );
  if (compareSemverStrings(plugin.version, MINIMUM_NOVAMIRA_VERSION) < 0)
    throw new CliError(
      "server_unsupported",
      `Novamira ${MINIMUM_NOVAMIRA_VERSION} or newer is required. Update the existing plugin explicitly, then run setup again.`,
      {
        details: {
          check: "plugin_version",
          minimumVersion: MINIMUM_NOVAMIRA_VERSION,
          installedVersion: plugin.version,
        },
      },
    );
  let enabled = false;
  let domain: string | null = null;
  if (
    client.provider === "hostinger" ||
    client.provider === "cloudways" ||
    client.provider === "plesk"
  )
    return {
      version: plugin.version,
      active: plugin.status === "active",
      networkActive: false,
      aiEnabled: false,
      aiDomain: null,
    };
  // Kinsta refuses commas and wildcards, even inside quoted arguments. Read
  // only the two exact option names; missing options yield an empty list.
  const options = [];
  for (const command of [EXISTING_AI_COMMAND, EXISTING_AI_DOMAIN_COMMAND]) {
    options.push(
      ...rows(await runWpCliForOutput(client, envId, command, budget)),
    );
  }
  for (const value of options) {
    const option = asRecord(value);
    if (option?.option_name === "novamira_ai_abilities_enabled") {
      if (
        !(["0", "1", "", 0, 1, false, true] as readonly unknown[]).includes(
          option.option_value,
        )
      )
        throw new CliError(
          "provider_error",
          "Cannot verify the existing AI Abilities setting.",
        );
      enabled =
        option.option_value === "1" ||
        option.option_value === 1 ||
        option.option_value === true;
    }
    if (option?.option_name === "novamira_ai_abilities_domain") {
      if (typeof option.option_value !== "string")
        throw new CliError(
          "provider_error",
          "Cannot verify the existing AI Abilities domain setting.",
        );
      domain = option.option_value || null;
    }
  }
  return {
    version: plugin.version,
    active: plugin.status !== "inactive",
    networkActive: plugin.status === "active-network",
    aiEnabled: enabled,
    aiDomain: domain,
  };
}
