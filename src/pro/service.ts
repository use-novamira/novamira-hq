// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { atomicWriteFile } from "../config/atomic-write.js";
import type { VerifiedFileSecurity } from "../config/file-security.js";
import { ProfileLockManager } from "../config/lock.js";
import { proLicenseMetadataPath, type PlatformPaths } from "../config/paths.js";
import type { CredentialStore } from "../credentials/store.js";
import type { SiteOperations } from "../integration/index.js";
import type { SiteProfileListing } from "../site-profiles.js";
import { asRecord } from "../json.js";
import { CliError } from "../errors.js";
import { readBoundedText } from "../provisioning/http.js";
import { PRO_PREFLIGHT, proInstallPhp, proConfigurePhp } from "./php.js";

const LICENSE_ID = createHash("sha256")
  .update("novamira-hq:novamira-pro:license:v1")
  .digest("hex");
const API = "https://updates.novamira.ai/api/novamira-pro";
const digest = (key: string) => createHash("sha256").update(key).digest("hex");

export interface ProReview {
  readonly id: string;
  readonly site: string;
  readonly siteUrl: string;
  readonly domain: string;
  readonly existing: boolean;
}
export interface ProView {
  readonly last4?: string;
  readonly site?: string;
  readonly review?: ProReview;
  readonly message?: string;
}
export interface ProService {
  view(site?: string): Promise<ProView>;
  save(key: string): Promise<void>;
  remove(): Promise<void>;
  plan(site: string): Promise<ProReview>;
  install(id: string): Promise<string>;
}

const PHP_ERRORS: Readonly<Record<string, string>> = {
  free_missing: "Install and activate Novamira Free first.",
  free_outdated: "Update Novamira Free to version 1.6.0 or later first.",
  permission_denied:
    "The connected WordPress user needs permission to install and activate plugins and manage site options.",
  multisite_unsupported:
    "Novamira Pro installation from this app is not available for WordPress multisite yet.",
  file_mods_disabled: "Plugin installation is disabled on this site.",
  site_changed: "The site's address changed. Review the destination again.",
  install_failed:
    "WordPress could not install the Pro ZIP. Check the site's plugin installation permissions and available space.",
  activation_failed:
    "The ZIP was installed but WordPress could not activate Novamira Pro.",
  configuration_unavailable:
    "Novamira Pro is installed but its license configuration is unavailable.",
  license_configuration_failed:
    "Novamira Pro is installed, but the plugin could not confirm its license. Check its license page in WordPress.",
};

export function createProService(options: {
  paths: PlatformPaths;
  security: VerifiedFileSecurity;
  credentials: () => Promise<CredentialStore>;
  operations: SiteOperations;
  profiles: () => Promise<SiteProfileListing>;
  fetch: typeof fetch;
  now?: () => number;
}): ProService {
  const now = options.now ?? Date.now;
  const file = proLicenseMetadataPath(options.paths);
  const locks = new ProfileLockManager(
    options.paths.stateDir,
    options.security,
  );
  const plans = new Map<
    string,
    ProReview & { expires: number; fingerprint: string }
  >();
  const busy = new Set<string>();
  async function php(
    site: string,
    code: string,
  ): Promise<Record<string, unknown>> {
    const result = asRecord(
      await options.operations.execute({
        kind: "run",
        site,
        ability: "novamira/execute-php",
        input: { code },
        approveDestructive: true,
      }),
    );
    const data = asRecord(result?.data);
    const value = asRecord(data?.return_value);
    if (data?.success !== true || !value || typeof value.code !== "string")
      throw new CliError(
        "provider_error",
        "The site did not confirm the operation. Check WordPress before retrying.",
      );
    const message = PHP_ERRORS[value.code];
    if (message) throw new CliError("provider_error", message);
    return value;
  }
  async function target(site: string) {
    const listing = await options.profiles();
    const profile = listing.profiles.find((item) => item.name === site);
    if (!listing.cliAvailable || profile?.state !== "connected")
      throw new CliError(
        "usage_error",
        "Connect this site to Novamira before installing Pro.",
      );
    const result = await php(site, PRO_PREFLIGHT);
    if (
      result.code !== "ready" ||
      typeof result.url !== "string" ||
      typeof result.existing !== "boolean"
    )
      throw new CliError(
        "provider_error",
        "The site did not confirm it is ready for Pro.",
      );
    const canonical = new URL(result.url);
    const selected = new URL(profile.siteUrl);
    if (
      !["https:", "http:"].includes(canonical.protocol) ||
      canonical.origin !== selected.origin ||
      canonical.pathname.replace(/\/$/, "") !==
        selected.pathname.replace(/\/$/, "") ||
      canonical.username ||
      canonical.password ||
      canonical.search ||
      canonical.hash
    )
      throw new CliError(
        "conflict",
        "The site's reported address does not match the selected destination.",
      );
    return {
      site,
      siteUrl: profile.siteUrl,
      domain: result.url.replace(/^https?:\/\//, ""),
      existing: result.existing,
    };
  }
  async function key() {
    return (await (await options.credentials()).require(LICENSE_ID)).reveal();
  }
  async function request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await options.fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new CliError(
        "provider_error",
        "The Novamira license service could not be reached. The last request may have taken effect; check before retrying.",
      );
    }
  }
  return {
    async view(site) {
      let last4: string | undefined;
      try {
        const stat = await lstat(file);
        if (
          !stat.isFile() ||
          stat.size > 1024 ||
          !(await options.security.verifyFile(file))
        )
          throw new Error("unsafe");
        const handle = await open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        let metadata: Record<string, unknown> | undefined;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.size > 1024 || opened.ino !== stat.ino)
            throw new Error("unsafe");
          metadata = asRecord(
            JSON.parse(await handle.readFile("utf8")) as unknown,
          );
        } finally {
          await handle.close();
        }
        if (
          metadata?.last4 !== null &&
          (typeof metadata?.last4 !== "string" ||
            !/^[a-z0-9._-]{4}$/.test(metadata.last4))
        )
          throw new Error("invalid");
        if (typeof metadata.last4 === "string") last4 = metadata.last4;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new CliError(
            "config_error",
            "The saved license information could not be read safely.",
          );
      }
      return { ...(last4 ? { last4 } : {}), ...(site ? { site } : {}) };
    },
    async save(input) {
      const value = input.trim().toLowerCase();
      if (!/^[a-z0-9._-]{8,200}$/.test(value))
        throw new CliError(
          "usage_error",
          "Enter a valid Novamira Pro license key.",
        );
      await locks.withLock("novamira-pro-license", async () => {
        const credentials = await options.credentials();
        const prior = await credentials.replace(LICENSE_ID, value);
        try {
          await atomicWriteFile(
            file,
            JSON.stringify({ last4: value.slice(-4) }),
            options.security,
          );
        } catch (error) {
          await credentials.restore(prior);
          throw error;
        }
      });
      plans.clear();
    },
    async remove() {
      await locks.withLock("novamira-pro-license", async () => {
        const credentials = await options.credentials();
        const prior = await credentials.delete(LICENSE_ID);
        try {
          await atomicWriteFile(
            file,
            JSON.stringify({ last4: null }),
            options.security,
          );
        } catch (error) {
          await credentials.restore(prior);
          throw error;
        }
      });
      plans.clear();
    },
    async plan(site) {
      for (const [id, item] of plans)
        if (item.expires <= now()) plans.delete(id);
      if (plans.size >= 32)
        throw new CliError(
          "conflict",
          "Too many pending installations. Wait a few minutes.",
        );
      const value = await key();
      const selected = await target(site);
      const review = { ...selected, id: randomUUID() };
      plans.set(review.id, {
        ...review,
        fingerprint: digest(value),
        expires: now() + 300_000,
      });
      return review;
    },
    async install(id) {
      const review = plans.get(id);
      plans.delete(id);
      if (!review || review.expires <= now())
        throw new CliError(
          "confirmation_required",
          "Review the installation again. This confirmation expired or was already used.",
        );
      if (busy.has(review.site))
        throw new CliError(
          "conflict",
          "An installation is already running for this site.",
        );
      busy.add(review.site);
      let activated = false;
      try {
        const value = await key();
        if (digest(value) !== review.fingerprint)
          throw new CliError(
            "conflict",
            "The saved license changed. Review the installation again.",
          );
        const current = await target(review.site);
        if (
          current.siteUrl !== review.siteUrl ||
          current.domain !== review.domain
        )
          throw new CliError(
            "conflict",
            "The destination changed. Review the installation again.",
          );
        const response = await request(`${API}/check`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            woo_sl_action: "activate",
            licence_key: value,
            product_unique_id: "WP-NVP-1",
            domain: review.domain,
            api_version: "1.1",
          }),
        });
        const text = await readBoundedText(response, 32768);
        let result: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = JSON.parse(text ?? "");
          result =
            Array.isArray(parsed) && parsed.length === 1
              ? asRecord(parsed[0])
              : undefined;
        } catch {
          /* Not a license result. */
        }
        const code = result?.status_code;
        if (!response.ok || (code !== "s100" && code !== "s101")) {
          const safeCode =
            typeof code === "string" && /^[es][0-9]{3}$/.test(code)
              ? code
              : "invalid_response";
          // Never reflect raw server messages: they may contain the key or request URL.
          throw new CliError(
            "provider_error",
            safeCode === "e112"
              ? "No license slots are available for this domain (e112)."
              : `License activation was not accepted (${safeCode}). Check your license account.`,
          );
        }
        activated = true;
        const download = new URL(`${API}/download`);
        download.search = new URLSearchParams({
          license: value,
          domain: review.domain,
        }).toString();
        const zip = await request(download.href, { method: "GET" });
        await zip.body?.cancel();
        const location = zip.headers.get("location");
        if (![302, 303, 307, 308].includes(zip.status) || !location)
          throw new CliError(
            "provider_error",
            `The Pro download was not authorized (HTTP ${String(zip.status)}).`,
          );
        const signed = new URL(location);
        if (
          signed.protocol !== "https:" ||
          signed.username ||
          signed.password ||
          signed.href.includes(value) ||
          !signed.pathname.endsWith(".zip")
        )
          throw new CliError(
            "provider_error",
            "The download service returned an invalid ZIP link.",
          );
        const installed = await php(
          review.site,
          proInstallPhp(review.domain, signed.href),
        );
        if (installed.code !== "installed")
          throw new CliError(
            "provider_error",
            "The site did not confirm Pro installation.",
          );
        const configured = await php(
          review.site,
          proConfigurePhp(review.domain, value),
        );
        if (configured.code !== "configured")
          throw new CliError(
            "provider_error",
            "The site did not confirm its Pro license configuration.",
          );
        return "Novamira Pro is installed, active and licensed on this site.";
      } catch (error) {
        const message =
          error instanceof CliError
            ? error.message
            : "The installation could not be confirmed. Check the site before trying again.";
        throw new CliError(
          "provider_error",
          `${message}${activated ? " The license is already activated on this domain; installation or configuration is not confirmed. No automatic retry was made." : ""}`,
        );
      } finally {
        busy.delete(review.site);
      }
    },
  };
}
