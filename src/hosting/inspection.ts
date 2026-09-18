// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ProviderKind } from "../config/schema.js";
import { CliError } from "../errors.js";
import { asRecord } from "../json.js";
import { redact } from "../output/redact.js";
import { applyHqCapabilityPolicy } from "./capabilities.js";
import type { ProviderClient, ReadRequest } from "./client.js";
import { sendGuardedAction } from "./verified-action.js";

export interface HostingInspectionOption {
  readonly id: string;
  readonly label: string;
  readonly capability: string;
  readonly section:
    "Cache" | "Logs" | "Statistics" | "Provider activity" | "Backups";
}

/** Explicit surface: never accepts provider paths, raw bodies or arbitrary queries. */
export function hostingInspectionOptions(
  provider: ProviderKind,
): HostingInspectionOption[] {
  const options: HostingInspectionOption[] = [];
  const add = (
    id: string,
    label: string,
    capability: string,
    section: HostingInspectionOption["section"],
  ) => options.push({ id, label, capability, section });
  if (
    [
      "kinsta",
      "pressable",
      "rocketnet",
      "pantheon",
      "wpengine",
      "cloudways",
    ].includes(provider)
  ) {
    add(
      "cache:site",
      provider === "pressable"
        ? "Clear object cache"
        : provider === "cloudways"
          ? "Clear Varnish cache"
          : "Clear site cache",
      "cache.clear",
      "Cache",
    );
  }
  if (provider === "kinsta")
    add("cache:edge", "Clear edge cache", "cache.clear", "Cache");
  if (provider === "wpengine")
    add("cache:cdn", "Clear CDN cache", "cache.clear", "Cache");
  if (provider === "cloudways")
    add(
      "activity",
      "Staging deployment activity",
      "activity.list",
      "Provider activity",
    );
  if (["kinsta", "pressable", "rocketnet"].includes(provider)) {
    add("logs:access", "Access log", "logs.get", "Logs");
    if (provider !== "rocketnet")
      add("logs:error", "PHP / error log", "logs.get", "Logs");
    add(
      "activity",
      provider === "kinsta" ? "Account activity (all sites)" : "Site activity",
      "activity.list",
      "Provider activity",
    );
  }
  if (provider === "kinsta") {
    for (const metric of ["visits", "bandwidth", "cdn-bandwidth"])
      add(
        `usage:${metric}`,
        `Site ${metric} this month`,
        "analytics.usage",
        "Statistics",
      );
    for (const metric of [
      "visits",
      "bandwidth",
      "cdn-bandwidth",
      "diskspace",
      "top-countries",
      "top-cities",
      "top-client-ips",
      "visits-dispersion",
      "response-codes",
    ])
      add(
        `analytics:${metric}`,
        `Environment ${metric}`,
        "analytics.env",
        "Statistics",
      );
  }
  if (["pressable", "rocketnet", "cloudways"].includes(provider))
    add("usage:usage", "Site usage", "analytics.usage", "Statistics");
  if (provider === "rocketnet")
    for (const metric of [
      "bandwidth",
      "bandwidth-usage",
      "requests",
      "cdn-requests",
    ])
      add(`analytics:${metric}`, metric, "analytics.env", "Statistics");
  if (provider === "pantheon")
    add(
      "analytics:metrics",
      "Environment metrics",
      "analytics.env",
      "Statistics",
    );
  if (
    [
      "kinsta",
      "pressable",
      "rocketnet",
      "pantheon",
      "wpengine",
      "instawp",
    ].includes(provider)
  )
    add(
      "backups",
      provider === "instawp" ? "List site versions" : "List backups",
      "backups.list",
      "Backups",
    );
  return options;
}

export interface HostingInspectionSelection {
  readonly siteId: string;
  readonly environmentId: string;
  readonly option: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly start?: string;
  readonly end?: string;
}

function resourceId(value: string): string {
  if (
    !value ||
    value.length > 512 ||
    !/^[a-zA-Z0-9_.:-]+$/u.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new CliError(
      "usage_error",
      "A valid hosting resource ID is required.",
    );
  return value;
}

export async function inspectHosting(
  client: ProviderClient,
  selection: HostingInspectionSelection,
  now = Date.now(),
): Promise<unknown> {
  const siteId = resourceId(selection.siteId);
  const envId = resourceId(selection.environmentId);
  const option = hostingInspectionOptions(client.provider).find(
    (entry) => entry.id === selection.option,
  );
  if (!option)
    throw new CliError(
      "provider_unsupported",
      "This hosting operation is not supported by HQ for this provider.",
    );
  const limit = selection.limit ?? 100;
  const offset = selection.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100000
  )
    throw new CliError(
      "usage_error",
      "Limit must be 1–1000 and offset 0–100000.",
    );
  const start =
    selection.start ?? new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const end = selection.end ?? new Date(now).toISOString();
  if (
    ![start, end].every(
      (date) =>
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(date) &&
        Number.isFinite(Date.parse(date)),
    ) ||
    Date.parse(start) >= Date.parse(end) ||
    Date.parse(end) - Date.parse(start) > 31 * 86400000
  )
    throw new CliError(
      "usage_error",
      "Use UTC ISO dates with a positive range of at most 31 days.",
    );
  const caps = applyHqCapabilityPolicy(
    await client.read({ kind: "capabilities" }),
  );
  if (
    !Array.isArray(caps) ||
    !caps.some(
      (entry: unknown) =>
        asRecord(entry)?.name === option.capability &&
        asRecord(entry)?.supported === true,
    )
  )
    throw new CliError(
      "provider_unsupported",
      "The provider does not advertise support for this operation.",
    );
  const environments = await client.listEnvironments(siteId);
  if (!environments.some((env) => env.id === envId))
    throw new CliError(
      "not_found",
      "The environment does not belong to the selected hosting site.",
    );
  if (option.section === "Cache") {
    const cache =
      option.id === "cache:edge"
        ? "edge"
        : option.id === "cache:cdn"
          ? "cdn"
          : "site";
    const result = await sendGuardedAction(client, {
      kind: "clear-cache",
      cache,
      body: { environment_id: envId },
    });
    if (
      result.provider !== client.provider ||
      !Number.isInteger(result.status) ||
      result.status < 200 ||
      result.status >= 300
    )
      throw new CliError(
        "provider_error",
        "The provider did not confirm acceptance of the cache purge. Verify the target before retrying.",
        { retryable: false },
      );
    return redact({
      operation: option.id,
      message:
        "Cache purge request sent. Acceptance is not proof of completion; check the provider operation when an operation ID is returned.",
      result,
    });
  }
  let request: ReadRequest;
  if (option.id === "backups") request = { kind: "backups", envId };
  else if (option.id === "activity")
    request = {
      kind: "activity",
      query: [
        ["limit", String(limit)],
        ["offset", String(offset)],
        ...(client.provider === "kinsta" ? [] : [["site_id", siteId] as const]),
      ],
    };
  else if (option.section === "Logs")
    request = {
      kind: "logs",
      envId,
      fileName: option.id.slice(5),
      lines: limit,
    };
  else if (option.id.startsWith("usage:"))
    request = {
      kind: "analytics-usage",
      siteId,
      metric: client.provider === "cloudways" ? "" : option.id.slice(6),
    };
  else
    request = {
      kind: "analytics-env",
      envId,
      metric: option.id.slice(10),
      query:
        client.provider === "kinsta"
          ? [
              ["time_span", "24_hours"],
              ["from", start],
              ["to", end],
              ...(option.id === "analytics:diskspace"
                ? [["time_zone", "00:00"] as const]
                : []),
            ]
          : [],
    };
  const data = redact(await client.read(request));
  const serialized = JSON.stringify(data === undefined ? null : data);
  const truncated = serialized.length > 200000;
  return {
    operation: option.id,
    scope:
      option.id === "activity" && client.provider === "kinsta"
        ? "hosting account (all sites)"
        : "selected site/environment",
    ...(option.id.startsWith("analytics:") && client.provider === "kinsta"
      ? { start, end }
      : {}),
    ...(option.section === "Logs"
      ? {
          note:
            client.provider === "rocketnet"
              ? "Access logs for the last hour."
              : client.provider === "pressable"
                ? "The provider does not support a line limit."
                : "Requested tail of the selected log.",
        }
      : {}),
    truncated,
    data: truncated ? serialized.slice(0, 200000) : data,
  };
}
