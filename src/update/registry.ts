// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Is a newer `@novamira/hq` published?" — one anonymous GET of one dist-tag.
 *
 * **What the Go did, and why none of it is here.** `internal/update/update.go`
 * (579 lines) asked GitHub. `fetchLatest` read
 * `https://api.github.com/repos/use-novamira/novamira/releases/latest`
 * (update.go:28), `selectArchiveAsset` picked a `.tar.gz` or `.zip` for the
 * running `GOOS`/`GOARCH`, `selectChecksumAsset` found `checksums.txt`,
 * `downloadFile` streamed both, `verifyChecksum` hashed the archive with
 * `crypto/sha256`, `extractBinary*` unpacked it with `archive/tar` +
 * `compress/gzip` or `archive/zip`, and `replaceCurrentExecutable` renamed the
 * result over the running binary (update.go:396-520). Under npm-only
 * distribution every premise of that machinery is gone: there is no release
 * archive, no checksums file, no single-file binary, and exactly one install
 * method. The npm updater does not query GitHub. Desktop release discovery
 * lives separately in `desktop.ts` and does not replace executables in place.
 *
 * **What HQ does instead.** It mirrors `@novamira/cli`'s `src/update/registry.ts`
 * so that an operator's two Novamira tools update the same way and the two
 * files can be diffed line for line. The only differences are the package name,
 * the environment variable that opts into plain HTTP, and this header.
 *
 * **The request carries nothing.** No cookie, no `Authorization`, no npm token,
 * no profile, no credential, no telemetry, no user identity — the URL and an
 * `Accept` header, and that is the whole request. `redirect: "error"` because a
 * registry that redirects a dist-tag read is not a registry HQ will follow to an
 * unknown origin, and a bounded incremental read because a chunked or
 * compression-bombed body must be abandoned rather than buffered.
 *
 * **HTTPS is mandatory.** The one exception is a **loopback** host over plain
 * HTTP, and only when the caller passes `allowInsecureHttp` — which
 * `src/main.ts` sets from `NOVAMIRA_HQ_ALLOW_INSECURE_HTTP=1`, the same variable
 * `src/provisioning/site-url.ts` already reads. HQ has one insecure-HTTP opt-in,
 * not two, and it exists so a contract test can point at a local mock registry.
 * A registry URL carrying credentials is refused outright: a `usage_error`, not
 * a stripped-and-continued request, because silently dropping the operator's
 * intent is worse than telling them it is unsupported.
 *
 * **This module may not import `src/cli/`, `src/web/` or `src/doctor/`.**
 * `src/doctor/` imports `src/update/`, never the reverse.
 */

import { Buffer } from "node:buffer";

import { CliError } from "../errors.js";
import { isSemver } from "../semver.js";

export const PACKAGE_NAME = "@novamira/hq";
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const MAX_REGISTRY_RESPONSE_BYTES = 64 * 1024;

export interface RegistryOptions {
  /** Injected in every test; production passes global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly registry?: string;
  readonly timeoutMs?: number;
  /** Set only by `NOVAMIRA_HQ_ALLOW_INSECURE_HTTP=1`, for a loopback registry. */
  readonly allowInsecureHttp?: boolean;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * `<registry>/-/package/@novamira%2Fhq/dist-tags`.
 *
 * The scope separator is percent-encoded by `encodeURIComponent`, which is what
 * the registry's route expects; writing `@novamira/hq` unencoded would address a
 * different path entirely.
 */
export function distTagsUrl(
  registry: string = DEFAULT_REGISTRY,
  allowInsecureHttp = false,
): URL {
  const base = new URL(registry.endsWith("/") ? registry : `${registry}/`);
  if (
    base.protocol !== "https:" &&
    !(
      base.protocol === "http:" &&
      allowInsecureHttp &&
      isLoopback(base.hostname)
    )
  ) {
    throw new CliError("usage_error", "The package registry must use HTTPS.");
  }
  if (base.username !== "" || base.password !== "") {
    throw new CliError(
      "usage_error",
      "The package registry URL must not contain credentials.",
    );
  }
  return new URL(
    `-/package/${encodeURIComponent(PACKAGE_NAME)}/dist-tags`,
    base,
  );
}

/**
 * Read the `latest` dist-tag of the published package. The request is
 * anonymous, sends no local state, and never follows a redirect.
 */
export async function fetchLatestVersion(
  options: RegistryOptions = {},
): Promise<string> {
  const fetchImplementation = options.fetch ?? fetch;
  const url = distTagsUrl(
    options.registry ?? DEFAULT_REGISTRY,
    options.allowInsecureHttp === true,
  );
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch (error) {
    throw new CliError(
      "network_error",
      "The package registry could not be reached.",
      { retryable: true, cause: error },
    );
  }
  if (!response.ok) {
    throw new CliError(
      "network_error",
      `The package registry answered with status ${String(response.status)}.`,
      // A 4xx is the registry telling us the answer; only a 5xx is worth
      // another attempt.
      { retryable: response.status >= 500 },
    );
  }
  const body = await readBounded(response);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new CliError(
      "network_error",
      "The package registry returned an unreadable response.",
      { cause: error },
    );
  }
  const latest =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>).latest
      : undefined;
  if (!isSemver(latest)) {
    throw new CliError(
      "network_error",
      "The package registry did not advertise a valid latest version.",
    );
  }
  return latest;
}

/**
 * Read at most 64 KiB, incrementally.
 *
 * The declared `Content-Length` is checked first, but it is only a hint — a
 * chunked or compressed body may declare nothing and still be unbounded — so the
 * stream is read chunk by chunk and cancelled the moment the running total
 * crosses the limit. Nothing over the limit is ever buffered.
 */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REGISTRY_RESPONSE_BYTES) {
    throw new CliError(
      "network_error",
      "The package registry response exceeded the allowed size.",
    );
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REGISTRY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CliError(
          "network_error",
          "The package registry response exceeded the allowed size.",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "network_error",
      "The package registry response could not be read.",
      { retryable: true, cause: error },
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}
