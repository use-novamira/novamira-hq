// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write.js";
import type { VerifiedFileSecurity } from "../config/file-security.js";
import { ProfileLockManager } from "../config/lock.js";
import { CliError } from "../errors.js";
import { compareSemverStrings, isSemver, parseSemver } from "../semver.js";

const RELEASES =
  "https://api.github.com/repos/use-novamira/novamira-hq/releases?per_page=100";
const REPOSITORY = "https://github.com/use-novamira/novamira-hq";
const INTERVAL = 24 * 60 * 60 * 1000;

export interface DesktopUpdateStatus {
  readonly current: string;
  readonly latest: string;
  readonly updateAvailable: boolean;
  readonly checkedAt: string;
  readonly releaseUrl?: string;
  readonly downloadUrl?: string;
}

export function desktopAsset(
  platform: string,
  arch: string,
): string | undefined {
  const cpu =
    arch === "x64" ? "x86_64" : arch === "arm64" ? "arm64" : undefined;
  if (!cpu) return undefined;
  if (platform === "darwin") return `novamira-hq-desktop-macos-${cpu}.dmg`;
  if (platform === "linux" && arch === "x64")
    return "novamira-hq-desktop-linux-x86_64.tar.gz";
  if (platform === "win32" && arch === "x64")
    return "novamira-hq-desktop-windows-x86_64.exe";
  return undefined;
}

/** Select only published releases with an uploaded artifact for this machine. */
export function selectDesktopRelease(
  value: unknown,
  current: string,
  asset: string,
): { latest: string; releaseUrl: string; downloadUrl: string } {
  if (!Array.isArray(value) || !isSemver(current))
    throw new CliError(
      "network_error",
      "The desktop release catalog is invalid.",
    );
  const preview = parseSemver(current)?.prerelease !== undefined;
  const candidates = value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const release = item as Record<string, unknown>;
    if (
      release.draft !== false ||
      typeof release.tag_name !== "string" ||
      !Array.isArray(release.assets)
    )
      return [];
    const latest = release.tag_name.replace(/^v/, "");
    if (
      !isSemver(latest) ||
      (!preview &&
        (release.prerelease !== false ||
          parseSemver(latest)?.prerelease !== undefined))
    )
      return [];
    const releaseUrl = `${REPOSITORY}/releases/tag/${encodeURIComponent(release.tag_name)}`;
    const downloadUrl = `${REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/${asset}`;
    if (
      !release.assets.some((entry: unknown) => {
        if (!entry || typeof entry !== "object") return false;
        const file = entry as Record<string, unknown>;
        return (
          file.name === asset &&
          file.state === "uploaded" &&
          typeof file.size === "number" &&
          file.size > 0 &&
          file.browser_download_url === downloadUrl
        );
      })
    )
      return [];
    return [{ latest, releaseUrl, downloadUrl }];
  });
  candidates.sort((a, b) => compareSemverStrings(b.latest, a.latest));
  const selected = candidates[0];
  if (!selected)
    throw new CliError(
      "network_error",
      "No published desktop release is available for this platform and release channel.",
    );
  return selected;
}

interface Options {
  readonly current: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Separate, private cache; failed automatic attempts are throttled too. */
export class DesktopUpdateChecker {
  private readonly path: string;
  private readonly locks: ProfileLockManager;
  private readonly asset: string | undefined;
  private readonly now: () => number;
  private pending: Promise<DesktopUpdateStatus | undefined> | undefined;

  constructor(
    stateDir: string,
    private readonly security: VerifiedFileSecurity,
    private readonly options: Options,
  ) {
    this.path = join(stateDir, "desktop-update-check.json");
    this.locks = new ProfileLockManager(stateDir, security);
    this.asset = desktopAsset(
      options.platform ?? process.platform,
      options.arch ?? process.arch,
    );
    this.now = options.now ?? Date.now;
  }

  check(force = false): Promise<DesktopUpdateStatus | undefined> {
    if (this.pending) return this.pending;
    this.pending = this.run(force).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async run(force: boolean): Promise<DesktopUpdateStatus | undefined> {
    if (!this.asset)
      throw new CliError(
        "provider_unsupported",
        "Desktop updates are not available for this platform.",
      );
    const asset = this.asset;
    const identity = `${this.options.current}/${asset}`;
    return this.locks.withLock("__desktop_update_check__", async () => {
      if (!force) {
        try {
          if (await this.security.verifyFile(this.path)) {
            const record = JSON.parse(
              await readFile(this.path, "utf8"),
            ) as Record<string, unknown>;
            const age = this.now() - Date.parse(String(record.checkedAt));
            if (record.identity === identity && age >= 0 && age < INTERVAL) {
              if (record.releases === null) return undefined;
              return this.status(
                record.releases,
                asset,
                String(record.checkedAt),
              );
            }
          }
        } catch {
          /* Missing or invalid cache: fetch a fresh catalog. */
        }
      }
      const checkedAt = new Date(this.now()).toISOString();
      let releases: unknown = null;
      try {
        const response = await (this.options.fetch ?? fetch)(RELEASES, {
          headers: { Accept: "application/vnd.github+json" },
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok || !response.body)
          throw new Error("release request failed");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 2 * 1024 * 1024)
              throw new Error("release catalog too large");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        releases = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as unknown;
        const status = this.status(releases, asset, checkedAt);
        await this.write(identity, checkedAt, releases);
        return status;
      } catch {
        await this.write(identity, checkedAt, null).catch(() => undefined);
        if (force)
          throw new CliError(
            "network_error",
            "Desktop update check failed. Try again later.",
          );
        return undefined;
      }
    });
  }

  private status(
    releases: unknown,
    asset: string,
    checkedAt: string,
  ): DesktopUpdateStatus {
    const selected = selectDesktopRelease(
      releases,
      this.options.current,
      asset,
    );
    return {
      ...selected,
      current: this.options.current,
      checkedAt,
      updateAvailable:
        compareSemverStrings(selected.latest, this.options.current) > 0,
    };
  }

  private write(
    identity: string,
    checkedAt: string,
    releases: unknown,
  ): Promise<void> {
    return atomicWriteFile(
      this.path,
      `${JSON.stringify({ identity, checkedAt, releases })}\n`,
      this.security,
    );
  }
}
