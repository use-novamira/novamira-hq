// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import { collectSensitiveValues, redact } from "../../output/redact.js";
import type { ActionRequest, ReadRequest } from "../client.js";
import type { HttpClient } from "../http-client.js";
import type { HostingSite } from "../types.js";

// Agency UIDs must not collide with classic domain/installation IDs.
export const AGENCY_PREFIX = "agency:";
const PAGE_SIZE = 50;
const MAX_PAGES = 2_500;

function invalid(message: string): never {
  throw new CliError(
    "provider_error",
    `Hostinger Agency inventory: ${message}`,
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function domainOf(value: unknown): string {
  const record = asRecord(value);
  const candidate = text(record?.fqdn) || text(record?.domain) || text(value);
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(candidate)
    ? candidate
    : "";
}

function siteOf(value: unknown, includeEnvironments: boolean): HostingSite {
  const item = asRecord(value);
  const details = asRecord(item?.details);
  const id = text(item?.id);
  if (!item || !details || !id || !text(item.platform) || !text(item.state))
    invalid("invalid website record; listing is incomplete.");
  const domains = Array.isArray(details.domains) ? details.domains : [];
  const domain =
    domains.map(domainOf).find(Boolean) ??
    (domainOf(details.vhost) || domainOf(details.preview_domain));
  const identity = `${AGENCY_PREFIX}${id}`;
  const name = domain || text(details.title) || text(details.description) || id;
  return {
    id: identity,
    name,
    displayName: `${name} (Agency ${text(item.platform)})`,
    status: text(item.state),
    ...(domain ? { primaryDomain: domain } : {}),
    ...(includeEnvironments
      ? {
          environments: [
            {
              id: identity,
              name: "live",
              displayName: "Live (Agency; connect WordPress by URL)",
              isBlocked: item.state !== "active",
              isPremium: false,
              ...(domain ? { primaryDomain: domain } : {}),
            },
          ],
        }
      : {}),
  };
}

/**
 * Agency has a separate paginated inventory, including H5G, Builder and Horizons.
 * Use the shared HTTP client so bearer authentication, origin restrictions and
 * secret redaction remain identical to classic Hostinger requests. Do not turn
 * permission/server errors into an apparently complete, empty inventory.
 * See Hostinger's AgencyHostingWebsitesApi and WebsiteListItemResource models.
 */
export async function listAgencySites(
  http: HttpClient,
  includeEnvironments: boolean,
): Promise<HostingSite[]> {
  const sites: HostingSite[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | undefined;
  let expectedPageSize: number | undefined;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = await http.json({
      path: `${http.baseUrl.replace(/\/+$/, "")}/api/agency-hosting/v1/websites`,
      query: [
        ["page", String(page)],
        ["per_page", String(PAGE_SIZE)],
      ],
    });
    // Agency metadata may contain WordPress details. Scrub echoed credentials
    // before mapping free-form titles, then expose only the inventory fields.
    const response = asRecord(redact(payload, collectSensitiveValues(payload)));
    const meta = asRecord(response?.meta);
    if (
      !response ||
      !Array.isArray(response.data) ||
      meta?.current_page !== page ||
      !Number.isSafeInteger(meta.per_page) ||
      Number(meta.per_page) < 1 ||
      !Number.isSafeInteger(meta.total) ||
      Number(meta.total) < 0
    )
      invalid("invalid response or pagination; listing is incomplete.");
    const total = Number(meta.total);
    const perPage = Number(meta.per_page);
    expectedTotal ??= total;
    expectedPageSize ??= perPage;
    if (total !== expectedTotal || perPage !== expectedPageSize)
      invalid("pagination changed during listing; refresh the inventory.");
    for (const row of response.data) {
      const site = siteOf(row, includeEnvironments);
      if (seen.has(site.id)) invalid("duplicate website ID across pages.");
      seen.add(site.id);
      sites.push(site);
    }
    // A short/empty final page must not silently omit websites claimed by meta.
    if (sites.length !== Math.min(page * perPage, total))
      invalid("page length does not match pagination; listing is incomplete.");
    if (sites.length === total) return sites;
  }
  return invalid("pagination limit exceeded; listing is incomplete.");
}

export async function getAgencySite(
  http: HttpClient,
  id: string,
): Promise<HostingSite> {
  const site = (await listAgencySites(http, true)).find(
    (item) => item.id === id,
  );
  if (!site)
    throw new CliError(
      "not_found",
      `Hostinger Agency website "${id}" was not found.`,
    );
  return site;
}

export function rejectAgencyOperation(
  request: ReadRequest | ActionRequest,
): void {
  if (
    ("envId" in request && request.envId.startsWith(AGENCY_PREFIX)) ||
    ("siteId" in request && request.siteId.startsWith(AGENCY_PREFIX))
  )
    throw new CliError(
      "provider_unsupported",
      "Hostinger Agency hosting operations are not implemented. For WordPress sites, install and activate Novamira in WordPress, then connect by URL. Classic hosting operations cannot be used for this target.",
    );
}
