// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import { compareSemverStrings, isSemver } from "../../semver.js";
import type { ActionRequest } from "../client.js";
import { jsonBody, type HttpClient } from "../http-client.js";
import type { ActionResult } from "../types.js";
import { hostingerInstaller } from "./hostinger-installer.js";

export const HOSTINGER_NOVAMIRA_SOURCE =
  "https://license.dynamic.ooo/api/novamira/download";
const MINIMUM_VERSION = "1.11.1";
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
type SetupRequest = Extract<ActionRequest, { kind: "setup-novamira" }>;

export async function hostingerPluginInventory(
  http: HttpClient,
  envId: string,
): Promise<unknown> {
  const all = rows(
    await http.json({
      path:
        http.baseUrl.replace(/\/$/, "") +
        "/api/hosting/v1/wordpress/installations",
    }),
  );
  const matches = all.filter(
    (entry) =>
      String(entry.id) === envId ||
      `${String(entry.username)}:${String(entry.domain)}` === envId ||
      entry.domain === envId,
  );
  const entry = matches[0];
  if (
    matches.length !== 1 ||
    typeof entry?.username !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(entry.username) ||
    !/^\d+$/.test(String(entry.id)) ||
    entry.is_valid !== true
  )
    fail("Hostinger WordPress target is missing or ambiguous.");
  return http.json({
    path:
      http.baseUrl.replace(/\/$/, "") +
      `/api/hosting/v1/accounts/${encodeURIComponent(entry.username)}/wordpress/${String(entry.id)}/plugins`,
  });
}

function fail(message: string): never {
  throw new CliError("provider_error", message);
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((row) => !asRecord(row)))
    fail("Hostinger returned an invalid inventory; setup stopped.");
  return value as Record<string, unknown>[];
}

function unwrap(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const data = asRecord(record?.data);
  if (!record) fail("Hostinger returned an invalid setup response.");
  return data ?? record;
}

function items(value: unknown): Record<string, unknown>[] {
  const result = unwrap(value);
  const entries = rows(result.items);
  if (
    typeof result.total_items !== "number" ||
    result.total_items !== entries.length
  )
    fail(
      "Hostinger file listing is incomplete; setup stopped without overwriting files.",
    );
  return entries;
}

async function transfer(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  allowDownloadRedirect = false,
): Promise<Response> {
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: allowDownloadRedirect ? "manual" : "error",
    });
    if (
      allowDownloadRedirect &&
      [301, 302, 303, 307, 308].includes(response.status)
    )
      return response;
    if (!response.ok) {
      await response.body?.cancel();
      fail(
        `Hostinger setup transfer failed (HTTP ${String(response.status)}). No automatic retry was made.`,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof CliError) throw error;
    // Fetch errors may embed opaque upload URLs or header values.
    fail(
      "Hostinger setup transfer failed or timed out. Verify the site before retrying.",
    );
  }
}

async function download(
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let response = await transfer(
    fetcher,
    HOSTINGER_NOVAMIRA_SOURCE,
    {
      signal,
      headers: { Accept: "application/zip" },
    },
    true,
  );
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    let target: URL;
    try {
      target = new URL(location ?? "", HOSTINGER_NOVAMIRA_SOURCE);
    } catch {
      fail("The official Novamira download returned an invalid redirect.");
    }
    if (
      target.origin !== "https://nbg1.your-objectstorage.com" ||
      !/^\/ooo-zips-free\/novamira\/versions\/novamira-[a-zA-Z0-9._-]+\.zip$/.test(
        target.pathname,
      ) ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    )
      fail(
        "The official Novamira download redirected outside its trusted archive location.",
      );
    response = await transfer(fetcher, target.href, {
      signal,
      headers: { Accept: "application/zip" },
    });
  }
  if (Number(response.headers.get("content-length")) > MAX_ZIP_BYTES) {
    await response.body?.cancel();
    fail("The Novamira archive exceeds the setup size limit.");
  }
  if (!response.body) fail("The Novamira archive is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_ZIP_BYTES) {
        await reader.cancel();
        fail("The Novamira archive exceeds the setup size limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
    fail("The Novamira download is not a ZIP archive.");
  return bytes;
}

/** No generic upload or PHP execution surface: only the fixed Novamira setup. */
export async function setupHostingerNovamira(
  http: HttpClient,
  fetcher: typeof fetch,
  request: SetupRequest,
): Promise<ActionResult> {
  const signal = request.signal
    ? AbortSignal.any([request.signal, AbortSignal.timeout(300_000)])
    : AbortSignal.timeout(300_000);
  const api = (
    path: string,
    body?: unknown,
    overrideSignal = signal,
  ): Promise<unknown> =>
    http.json({
      path: http.baseUrl.replace(/\/$/, "") + path,
      signal: overrideSignal,
      ...(body === undefined
        ? {}
        : { method: "POST", body: jsonBody(body), retry: { maxAttempts: 1 } }),
    });
  const all = rows(await api("/api/hosting/v1/wordpress/installations"));
  const matches = all.filter(
    (entry) =>
      String(entry.id) === request.envId ||
      `${String(entry.username)}:${String(entry.domain)}` === request.envId ||
      entry.domain === request.envId,
  );
  if (matches.length !== 1)
    fail(
      "Select one verified Hostinger WordPress installation; the target is missing or ambiguous.",
    );
  const installation = matches[0];
  if (!installation) fail("Hostinger installation is missing.");
  const username = installation.username,
    domain = installation.domain;
  const id = String(installation.id);
  if (
    typeof username !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(username) ||
    typeof domain !== "string" ||
    !/^[a-zA-Z0-9.-]+$/.test(domain) ||
    !/^\d+$/.test(id) ||
    installation.is_valid !== true
  )
    fail("Hostinger installation identity could not be verified.");
  let site: URL;
  try {
    site = new URL(String(installation.url));
  } catch {
    fail("Hostinger did not provide a valid site URL.");
  }
  if (
    site.protocol !== "https:" ||
    site.hostname !== domain ||
    site.port ||
    site.username ||
    site.password ||
    site.search ||
    site.hash ||
    site.pathname !== "/"
  )
    throw new CliError(
      "provider_unsupported",
      "Hostinger setup currently requires a root-domain HTTPS WordPress installation.",
    );
  const account = `/api/hosting/v1/accounts/${encodeURIComponent(username)}`;
  const pluginsPath = `${account}/wordpress/${id}/plugins`;
  const files = (directory: string, overrideSignal = signal) =>
    api(
      `${account}/domains/${encodeURIComponent(domain)}/files?directory=${encodeURIComponent(directory)}&max_depth=1`,
      undefined,
      overrideSignal,
    );
  const php = unwrap(
    await api(`${account}/websites/${encodeURIComponent(domain)}/php/details`),
  );
  const phpVersion = php.php_version_full ?? php.php_version;
  if (
    typeof phpVersion !== "string" ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(phpVersion) ||
    Number(phpVersion.split(".")[0]) < 8
  )
    throw new CliError(
      "server_unsupported",
      "Hostinger setup requires a verified PHP version of at least 8.0.",
    );
  const catalog = rows(await api(pluginsPath));
  const existing = catalog.find((plugin) => plugin.name === "novamira");
  if (
    existing &&
    (typeof existing.version !== "string" ||
      !isSemver(existing.version) ||
      compareSemverStrings(existing.version, MINIMUM_VERSION) < 0 ||
      !["active", "inactive"].includes(String(existing.status)))
  )
    throw new CliError(
      "server_unsupported",
      "Update or verify the existing Novamira installation before setup; no changes were made.",
    );
  const before = items(await files("wp-content/plugins"));
  if (!existing && before.some((entry) => entry.name === "novamira"))
    fail(
      "A Novamira directory already exists but is not in the plugin inventory. Resolve it manually; setup will not overwrite it.",
    );
  const enableAi = request.enableAiAbilities ?? !existing;
  // Preserved, already-active installs need no helper and no writes.
  if (existing?.status === "active" && !enableAi)
    return result(site.href, String(existing.version), null, []);
  const archive = existing ? undefined : await download(fetcher, signal);
  const slug = `novamira-hq-setup-${randomUUID()}`;
  const remoteDirectory = `wp-content/plugins/${slug}`;
  const digest = archive
    ? createHash("sha256").update(archive).digest("hex")
    : null;
  const helper = Buffer.from(
    hostingerInstaller({
      domain,
      digest,
      enableAi,
      minimumVersion: MINIMUM_VERSION,
      expires: Math.floor(Date.now() / 1000) + 600,
    }),
  );
  const upload = unwrap(
    await api("/api/hosting/v1/files/upload-urls", { username, domain }),
  );
  let base: URL;
  try {
    base = new URL(String(upload.url));
  } catch {
    fail("Hostinger returned an invalid upload origin.");
  }
  if (
    base.protocol !== "https:" ||
    !/^srv\d+-files\.hstgr\.io$/.test(base.hostname) ||
    base.port ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    fail("Hostinger returned an untrusted upload origin.");
  if (
    typeof upload.auth_key !== "string" ||
    typeof upload.rest_auth_key !== "string" ||
    !upload.auth_key ||
    !upload.rest_auth_key ||
    /[\r\n]/.test(upload.auth_key + upload.rest_auth_key)
  )
    fail("Hostinger upload authorization is invalid.");
  const headers = {
    "X-Auth": upload.auth_key,
    "X-Auth-Rest": upload.rest_auth_key,
    "Tus-Resumable": "1.0.0",
  };
  async function put(name: string, bytes: Uint8Array): Promise<void> {
    const url = `${base.href.replace(/\/$/, "")}/${remoteDirectory}/${name}?override=false`;
    const created = await transfer(fetcher, url, {
      method: "POST",
      signal,
      headers: {
        ...headers,
        "Upload-Length": String(bytes.length),
        "Upload-Offset": "0",
      },
    });
    await created.body?.cancel();
    if (created.status !== 201)
      fail("Hostinger did not create the setup upload.");
    // TUS PATCH goes to the SAME URL, not the untrusted Location header.
    const written = await transfer(fetcher, url, {
      method: "PATCH",
      signal,
      headers: {
        ...headers,
        "Upload-Offset": "0",
        "Content-Type": "application/offset+octet-stream",
      },
      body: new Uint8Array(bytes),
    });
    await written.body?.cancel();
    if (
      written.status !== 204 ||
      Number(written.headers.get("Upload-Offset")) !== bytes.length
    )
      fail("Hostinger setup upload is incomplete.");
  }
  const warnings: string[] = [];
  let activationAttempted = false;
  let completed = false;
  let version = existing ? String(existing.version) : "";
  try {
    if (archive) await put("novamira.zip", archive);
    await put(`${slug}.php`, helper);
    const uploaded = items(await files(remoteDirectory));
    if (
      !uploaded.some(
        (entry) =>
          entry.name === `${slug}.php` && entry.size_bytes === helper.length,
      ) ||
      (archive &&
        !uploaded.some(
          (entry) =>
            entry.name === "novamira.zip" &&
            entry.size_bytes === archive.length,
        ))
    )
      fail("Hostinger setup files failed size verification.");
    activationAttempted = true;
    await api(`${pluginsPath}/activate`, { plugin: slug });
    // Hostinger can queue activation; require the receipt AND Novamira active.
    for (let attempt = 0; attempt < 15; attempt++) {
      const current = rows(await api(pluginsPath));
      const receipt = current.find((entry) => entry.name === slug);
      const plugin = current.find((entry) => entry.name === "novamira");
      if (
        receipt?.status === "active" &&
        receipt.version === "1.0.0" &&
        plugin?.status === "active" &&
        typeof plugin.version === "string" &&
        isSemver(plugin.version) &&
        compareSemverStrings(plugin.version, MINIMUM_VERSION) >= 0
      ) {
        version = plugin.version;
        completed = true;
        break;
      }
      await delay(1000, undefined, { signal });
    }
    if (!completed)
      fail(
        "Hostinger accepted setup but completion could not be verified. Check the site before retrying.",
      );
  } catch (error) {
    throw new CliError(
      "provider_error",
      `Hostinger Novamira setup did not complete. The plugin or AI settings may have changed; verify the site and temporary directory ${remoteDirectory} before retrying.`,
      {
        details: {
          temporaryDirectory: remoteDirectory,
          cleanupRequired: true,
          reason:
            error instanceof CliError
              ? error.message
              : "Transfer or operation interrupted.",
        },
      },
    );
  } finally {
    if (activationAttempted) {
      try {
        // Independent bounded cleanup even if the dashboard request was aborted.
        const cleanupSignal = AbortSignal.timeout(30_000);
        await api(`${pluginsPath}/deactivate`, { plugin: slug }, cleanupSignal);
        const current = rows(await api(pluginsPath, undefined, cleanupSignal));
        if (
          current.some(
            (entry) => entry.name === slug && entry.status === "active",
          )
        )
          warnings.push(
            `Temporary setup plugin is still active. Check ${remoteDirectory} before retrying.`,
          );
        let remaining = items(await files("wp-content/plugins", cleanupSignal));
        if (
          remaining.some((entry) => entry.name === slug) &&
          !current.some(
            (entry) => entry.name === slug && entry.status === "active",
          )
        ) {
          // Provider deactivation may skip PHP hooks. Remove only this run's
          // generated helper, never the Novamira plugin or any other directory.
          await api(
            `${pluginsPath}/uninstall`,
            { plugins: [slug] },
            cleanupSignal,
          );
          for (let attempt = 0; attempt < 10; attempt++) {
            remaining = items(await files("wp-content/plugins", cleanupSignal));
            if (!remaining.some((entry) => entry.name === slug)) break;
            await delay(1000, undefined, { signal: cleanupSignal });
          }
        }
        if (remaining.some((entry) => entry.name === slug))
          warnings.push(
            `Remove the inactive temporary setup directory ${remoteDirectory} from the hosting file manager.`,
          );
      } catch {
        warnings.push(
          `Temporary setup cleanup could not be verified. Check ${remoteDirectory} in the hosting file manager.`,
        );
      }
    }
  }
  return result(site.href, version, enableAi ? true : null, warnings);
}

function result(
  siteUrl: string,
  version: string,
  aiEnabled: true | null,
  warnings: readonly string[],
): ActionResult {
  return {
    provider: "hostinger",
    action: "novamira.setup",
    status: 200,
    raw: { siteUrl, version, aiEnabled, warnings },
  };
}
