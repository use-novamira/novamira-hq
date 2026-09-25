// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../errors.js";
import { asRecord } from "../json.js";
import { HOSTINGER_NOVAMIRA_SOURCE } from "../hosting/providers/hostinger-setup.js";
import { checkSiteCompatibility, metadataUrl } from "./compatibility.js";
import { connectHandoff } from "./handoff.js";
import { normalizeSiteUrl } from "./site-url.js";
import type {
  CompatibilityReport,
  NovamiraSetupDependencies,
  NovamiraSetupRequest,
  NovamiraSetupResult,
} from "./setup.js";
import type { InvocationWarning } from "../output/render.js";

/** Provider API provisioning, not a fabricated provider WP-CLI implementation. */
export async function provisionProviderApi(
  dependencies: NovamiraSetupDependencies,
  request: NovamiraSetupRequest,
): Promise<NovamiraSetupResult> {
  const cloudways = dependencies.client.provider === "cloudways";
  const plesk = dependencies.client.provider === "plesk";
  const label = cloudways ? "Cloudways" : plesk ? "Plesk" : "Hostinger";
  if (
    request.force ||
    request.activate === false ||
    request.activateNetwork ||
    request.ignoreRequirements ||
    request.pluginVersion ||
    request.wait === false ||
    (request.timeoutSeconds !== undefined && request.timeoutSeconds !== 300) ||
    request.url ||
    (request.source !== undefined &&
      request.source !== "novamira-latest" &&
      request.source !== HOSTINGER_NOVAMIRA_SOURCE)
  )
    throw new CliError(
      "usage_error",
      `${label} setup supports the official latest Novamira package on a root-domain installation with a five-minute timeout only; custom sources, URL overrides, versions, force, network activation and skipped activation/wait are not supported.`,
    );
  dependencies.report?.(
    "info",
    cloudways
      ? "Installing and activating Novamira through Cloudways WP Manager. Existing installations are never overwritten. AI Abilities settings cannot be changed through this API; readiness will be checked afterwards."
      : plesk
        ? "Installing Novamira through Plesk WP Toolkit on the selected WordPress installation. Existing installations are never overwritten."
        : "Preparing Novamira through Hostinger: verified ZIP upload and temporary installer. Existing installations are never overwritten.",
  );
  const action = await dependencies.client.action({
    kind: "setup-novamira",
    envId: request.envId,
    ...(request.aiAbilities === undefined
      ? {}
      : { enableAiAbilities: request.aiAbilities }),
    ...(dependencies.signal === undefined
      ? {}
      : { signal: dependencies.signal }),
  });
  const raw = asRecord(action.raw);
  if (
    action.status !== 200 ||
    typeof raw?.siteUrl !== "string" ||
    typeof raw.version !== "string" ||
    (raw.aiEnabled !== true && raw.aiEnabled !== null) ||
    !Array.isArray(raw.warnings) ||
    raw.warnings.some((entry) => typeof entry !== "string")
  )
    throw new CliError(
      "provider_error",
      `${label} setup returned an unverifiable result.`,
    );
  const site = normalizeSiteUrl(raw.siteUrl, dependencies.environment, "--url");
  const warnings: InvocationWarning[] = (raw.warnings as string[]).map(
    (message) => ({ code: "setup_cleanup_required", message }),
  );
  dependencies.report?.(
    "ok",
    `Novamira ${raw.version} is active. ${raw.aiEnabled ? "AI Abilities enabled." : "Existing AI Abilities settings preserved."}`,
  );
  let compatibility: CompatibilityReport = {
    status: "skipped",
    metadataUrl: null,
    pluginVersion: null,
    restApiVersion: null,
    wordpressVersion: null,
    minimumWordpressVersion: null,
    features: null,
  };
  let ready: true | null = null;
  if (request.compatCheck ?? true) {
    dependencies.report?.("info", "Verifying public OAuth compatibility.");
    try {
      const block = await checkSiteCompatibility(site, {
        fetch: dependencies.fetch,
        ...(dependencies.signal === undefined
          ? {}
          : { signal: dependencies.signal }),
        ...(dependencies.metadataTimeoutMs === undefined
          ? {}
          : { timeoutMs: dependencies.metadataTimeoutMs }),
      });
      compatibility = {
        status: "supported",
        metadataUrl: metadataUrl(site.siteUrl),
        pluginVersion: block.plugin_version,
        restApiVersion: block.rest_api_version,
        wordpressVersion: block.wordpress_version,
        minimumWordpressVersion: block.minimum_wordpress_version,
        features: block.features,
      };
      ready = true;
    } catch (error) {
      throw new CliError(
        "server_unsupported",
        cloudways
          ? "Novamira is installed and active, but the site is not ready to connect. Open Novamira settings in WordPress, enable AI Abilities for this domain, then reconnect. If already enabled, check plugin compatibility and the site cache. Cloudways API cannot change these settings."
          : plesk
            ? "Novamira is active, but public OAuth readiness could not be verified. Check AI Abilities settings and the site cache before reconnecting."
            : "Novamira is active, but public OAuth readiness could not be verified. If LiteSpeed is serving an old 404, purge its cache and retry verification. Setup is not a completed site connection.",
        {
          details: {
            siteUrl: site.siteUrl,
            pluginVersion: raw.version,
            aiAbilitiesEnabled: raw.aiEnabled,
            warnings,
            check: error instanceof CliError ? error.code : "metadata",
          },
        },
      );
    }
  } else {
    warnings.push({
      code: "compatibility_not_checked",
      message: "Site compatibility was not checked; OAuth connection may fail.",
    });
    if (raw.aiEnabled === null)
      warnings.push({
        code: "ai_abilities_not_checked",
        message: cloudways
          ? "Cloudways cannot enable AI Abilities through its API. Enable them in Novamira settings in WordPress before connecting; readiness has not been verified."
          : "Existing AI Abilities settings were preserved and could not be verified through provider inventory.",
      });
  }
  return {
    hostingProfile: dependencies.hostingProfile,
    envId: request.envId,
    siteUrl: site.siteUrl,
    plugin: {
      slug: "novamira",
      source: HOSTINGER_NOVAMIRA_SOURCE,
      version: raw.version,
      activated: true,
      networkActivated: false,
    },
    aiAbilities: {
      enabled: raw.aiEnabled === true || ready === true,
      domain: raw.aiEnabled === true || ready === true ? site.host : null,
    },
    compatibility,
    ready,
    handoff: connectHandoff(site.siteUrl),
    warnings,
  };
}
