// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../errors.js";
import { normalizeSiteUrl } from "../provisioning/site-url.js";

export type OnboardingRequest =
  | { readonly kind: "hosting" }
  | { readonly kind: "site"; readonly url: string };
export interface McpOnboarding {
  open(request: OnboardingRequest): Promise<{
    readonly status: "awaiting_user_action";
    readonly browserOpened: boolean;
    readonly url: string;
  }>;
}

/** No credentials, OAuth authorization URLs, callback parameters or child output. */
export function onboardingSiteUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048)
    throw new CliError(
      "usage_error",
      "Provide only the public WordPress site URL, without credentials or authorization parameters.",
    );
  try {
    return normalizeSiteUrl(value, {}, "--url").siteUrl;
  } catch {
    // Do not reflect rejected input: it might be an API key or an OAuth URL.
    throw new CliError(
      "usage_error",
      "Provide only the public WordPress site URL, without credentials or authorization parameters.",
    );
  }
}

/** Lazy, session-owned dashboard. The existing browser forms own all mutations. */
export function createMcpOnboarding(options: {
  start(): Promise<string>;
  openBrowser(url: string): Promise<void>;
}): McpOnboarding {
  let dashboard: Promise<string> | undefined;
  return {
    async open(request) {
      const site =
        request.kind === "site" ? onboardingSiteUrl(request.url) : undefined;
      dashboard ??= options.start().catch(() => {
        dashboard = undefined;
        throw new CliError(
          "internal_error",
          "The local HQ connection form could not be started. Open Novamira HQ and try again.",
        );
      });
      const base = new URL(await dashboard);
      if (
        base.protocol !== "http:" ||
        base.hostname !== "127.0.0.1" ||
        !base.port ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.pathname !== "/"
      )
        throw new CliError(
          "internal_error",
          "HQ did not return a valid local dashboard address.",
        );
      base.pathname = request.kind === "site" ? "/sites" : "/providers";
      base.searchParams.set("new", request.kind === "site" ? "cli" : "host");
      if (site !== undefined) base.searchParams.set("site_url", site);
      let browserOpened = true;
      try {
        await options.openBrowser(base.href);
      } catch {
        browserOpened = false;
      }
      return { status: "awaiting_user_action", browserOpened, url: base.href };
    },
  };
}
