// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import { isSemver, compareSemverStrings } from "../../semver.js";
import { formBody, type HttpClient } from "../http-client.js";
import type { ActionResult } from "../types.js";
import { HOSTINGER_NOVAMIRA_SOURCE } from "./hostinger-setup.js";

// Official WP Manager API: https://developers.cloudways.com/api.yaml
// This is a bounded Novamira installer, not a command execution bridge.
export function cloudwaysSetupTarget(envId: string): [string, string] {
  if (!/^[1-9]\d*:[1-9]\d*$/.test(envId))
    throw new CliError(
      "usage_error",
      "Cloudways requires numeric server_id:app_id.",
    );
  const [server, app] = envId.split(":") as [string, string];
  return [server, app];
}

export function cloudwaysPlugins(value: unknown): Record<string, unknown>[] {
  const root = asRecord(value);
  if (root?.success !== true || !Array.isArray(root.data))
    throw new CliError(
      "provider_error",
      "Cloudways WP Manager plugin inventory could not be verified. Check WP Manager availability for this application.",
    );
  return root.data.map((value: unknown) => {
    const row = asRecord(value);
    if (
      !row ||
      typeof row.slug !== "string" ||
      typeof row.version !== "string" ||
      typeof row.status !== "string"
    )
      throw new CliError(
        "provider_error",
        "Cloudways returned an invalid plugin inventory.",
      );
    return { name: row.slug, version: row.version, status: row.status };
  });
}

function novamira(value: unknown): Record<string, unknown> | undefined {
  const rows = cloudwaysPlugins(value).filter((row) => row.name === "novamira");
  if (rows.length > 1)
    throw new CliError(
      "provider_error",
      "Cloudways returned ambiguous Novamira installations.",
    );
  const row = rows[0];
  if (
    row &&
    (typeof row.version !== "string" ||
      !isSemver(row.version) ||
      !["active", "inactive"].includes(String(row.status)))
  )
    throw new CliError(
      "server_unsupported",
      "The existing Novamira version or activation state cannot be verified. No overwrite is allowed.",
    );
  return row;
}

export async function setupCloudwaysNovamira(
  http: HttpClient,
  envId: string,
  parentSignal?: AbortSignal,
): Promise<ActionResult> {
  const [serverId, appId] = cloudwaysSetupTarget(envId);
  const deadline = AbortSignal.timeout(300_000);
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, deadline])
    : deadline;
  signal.throwIfAborted();
  const get = (path: string) => http.json({ path, signal });
  const inventoryPath = `/plugins/${serverId}/${appId}`;
  // Resolve the exact application in the exact server before any mutation.
  const inventory = asRecord(await get("/server"));
  const servers = inventory?.servers ?? asRecord(inventory?.data)?.servers;
  const server = Array.isArray(servers)
    ? servers.map(asRecord).find((row) => String(row?.id) === serverId)
    : undefined;
  const apps = server?.apps;
  const matches = Array.isArray(apps)
    ? apps.map(asRecord).filter((row) => String(row?.id) === appId)
    : [];
  const app = matches[0];
  if (matches.length !== 1 || !app)
    throw new CliError(
      "not_found",
      "Cloudways application was not found in the specified server.",
    );
  const domain = [
    app.cname,
    app.c_name,
    app.primary_domain,
    app.app_fqdn,
    app.fqdn,
    app.url,
  ].find((value) => typeof value === "string" && value !== "");
  if (typeof domain !== "string" || !domain)
    throw new CliError(
      "provider_error",
      "Cloudways did not report a site domain.",
    );
  let site: URL;
  try {
    site = new URL(domain.includes("://") ? domain : `https://${domain}`);
  } catch {
    throw new CliError(
      "provider_error",
      "Cloudways returned an invalid site domain.",
    );
  }
  if (
    site.protocol !== "https:" ||
    site.username ||
    site.password ||
    site.search ||
    site.hash ||
    site.pathname !== "/"
  )
    throw new CliError(
      "server_unsupported",
      "Cloudways setup requires an HTTPS root-domain WordPress installation.",
    );
  const settings = asRecord(
    await http.json({
      path: "/server/manage/settings",
      query: [["server_id", serverId]],
      signal,
    }),
  );
  const php = asRecord(asRecord(settings?.settings)?.package_versions)?.php;
  const core = asRecord(await get(`/wpsite/coreinfo/${serverId}/${appId}`));
  const wp = asRecord(core?.data)?.core_version;
  if (
    typeof php !== "string" ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(php) ||
    Number(php.split(".")[0]) < 8
  )
    throw new CliError(
      "server_unsupported",
      "Cloudways must report PHP 8.0 or newer before Novamira can be installed.",
    );
  const coreVersion = typeof wp === "string" ? wp.split("-", 1)[0] : undefined;
  const wpVersion =
    typeof coreVersion === "string" && /^\d+\.\d+$/.test(coreVersion)
      ? `${coreVersion}.0`
      : coreVersion;
  if (
    core?.success !== true ||
    typeof wpVersion !== "string" ||
    !isSemver(wpVersion) ||
    compareSemverStrings(wpVersion, "6.9.0") < 0
  )
    throw new CliError(
      "server_unsupported",
      "Cloudways must report WordPress 6.9 or newer before Novamira can be installed.",
    );

  const post = async (path: string, fields: Record<string, string>) => {
    const result = asRecord(
      await http.json({
        path,
        method: "POST",
        body: formBody({ server_id: serverId, app_id: appId, ...fields }),
        signal,
      }),
    );
    if (!result || result.success === false || result.status === false)
      throw new CliError(
        "provider_error",
        "Cloudways did not accept the plugin operation. Verify the application before retrying.",
      );
  };
  const wait = async (active: boolean) => {
    const response = await http.poll(
      { path: inventoryPath, signal },
      {
        signal,
        deadlineMs: 300_000,
        initialIntervalMs: 2_000,
        maxIntervalMs: 5_000,
        isComplete: (response) => {
          const plugin = novamira(response.data);
          return (
            plugin !== undefined && (!active || plugin.status === "active")
          );
        },
      },
    );
    const plugin = novamira(response.data);
    if (!plugin)
      throw new CliError(
        "provider_error",
        "Cloudways plugin completion could not be verified.",
      );
    return plugin;
  };
  let plugin = novamira(await get(inventoryPath));
  if (!plugin) {
    await post("/plugins/upload", {
      plugin_file_url: HOSTINGER_NOVAMIRA_SOURCE,
      plugin_file_name: "novamira.zip",
      update_type: "quickupdate",
    });
    plugin = await wait(false);
  }
  // Never replace an existing plugin, even if too old or partially installed.
  if (compareSemverStrings(String(plugin.version), "1.11.1") < 0)
    throw new CliError(
      "server_unsupported",
      "Update the existing Novamira plugin before running setup. HQ will not overwrite it.",
    );
  if (plugin.status !== "active") {
    await post("/plugins/activate", {
      filename: "novamira/novamira.php",
      update_type: "quickupdate",
    });
    plugin = await wait(true);
  }
  return {
    provider: "cloudways",
    action: "novamira.setup",
    status: 200,
    raw: {
      siteUrl: site.origin,
      version: plugin.version,
      aiEnabled: null,
      warnings: [],
    },
  };
}
