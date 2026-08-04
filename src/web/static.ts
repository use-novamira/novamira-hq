// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The nine static assets, and the handler that serves them.
 *
 * **Provenance.** The files under `src/web/static/` are copied verbatim from
 * `internal/dashboard/static/` in the Go program; plan §5.4 carries them over
 * unchanged, and they are not reformatted, re-minified or re-indented here.
 * Three of them are not ours and their licences travel with them:
 *
 * - `datastar.js` — Datastar v1.0.2, MIT. It is **not** shipped by
 *   `@starfederation/datastar-sdk@1.0.0`, which contains only the server-side
 *   SSE generators (`esm/node`, `esm/web`) and no browser runtime, so vendoring
 *   the client bundle is required rather than lazy.
 * - `fonts/montserrat-var.woff2` and `fonts/jetbrains-mono-var.woff2` — SIL Open
 *   Font License 1.1. `fonts/montserrat-OFL.txt` and
 *   `fonts/jetbrains-mono-OFL.txt` ship with them because the OFL requires the
 *   licence text to be distributed alongside the fonts. They are assets, not
 *   documentation: dropping them would be a licence violation.
 *
 * `scripts/add-spdx-headers.mjs` skips the whole directory: rewriting a vendored
 * MIT bundle or an OFL text would be wrong, and our own two browser scripts are
 * skipped with them so the rule stays one sentence. This comment is where the
 * provenance lives instead.
 *
 * **What the Go did.** `//go:embed static/*` plus
 * `http.StripPrefix("/assets/", http.FileServer(http.FS(assets)))`. That serves
 * whatever happens to be in the directory, generates directory listings for
 * paths that end in `/`, and answers `If-Modified-Since` from an embedded
 * zero timestamp.
 *
 * **What HQ does instead: an allowlist, not a file server.** The nine relative
 * paths are a frozen constant with their content types. A path that is not in
 * the constant is a 404 *before any filesystem call*, so the interesting half of
 * the traversal attack surface never opens. The traversal guard stays anyway, as
 * defence in depth and because the allowlist is data that a future edit could
 * widen: the path is decoded once in `request.ts`, then rejected here for a NUL,
 * a backslash, an empty segment, a `.`/`..` segment, or any segment starting
 * with a dot, and the resolved absolute path is asserted to be inside the root.
 *
 * The root is resolved from `import.meta.url`, never from `process.cwd()`: the
 * dashboard must serve its own bundle whatever directory the operator started it
 * from.
 *
 * **Caching.** Bytes are read once per file and held for the process lifetime —
 * nine files, ~143 KB — with a strong ETag over the content. `Cache-Control` is
 * `no-cache` for all nine: the URLs are not content-hashed, so a long `max-age`
 * would let an upgraded HQ serve a stale `app.css` against a new document. An
 * `If-None-Match` hit answers 304 with no body.
 *
 * **Selector contracts our own shipped JS depends on**, load-bearing for 6b and
 * not to be renamed: `sites-filter.js` queries
 * `input[data-bind="sites.search"]`, `#sites-result .site-group`,
 * `#sites-result .provider-sites`, `.site-row`, `.site-grid`,
 * `.site-row[data-nm-state]`, `[data-sf-count="with"|"without"]` and
 * `.seg-btn[data-sf-status]`, and observes `#sites-result`;
 * `relative-time.js` queries `[data-checked-at]` and expects unix
 * **milliseconds**. `app.css` references exactly two asset URLs, both absolute
 * (`/assets/fonts/montserrat-var.woff2` and
 * `/assets/fonts/jetbrains-mono-var.woff2`), which is why `fonts/` must be
 * served under the same prefix.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError } from "../errors.js";
import { ASSET_CACHE_CONTROL, type DashboardResponse } from "./responses.js";

/** The URL prefix every asset is served under. `app.css` hard-codes it. */
export const ASSET_PREFIX = "/assets/";

export interface StaticAsset {
  /** Path relative to the static root, always with `/` separators. */
  readonly path: string;
  readonly contentType: string;
}

/**
 * The complete allowlist. A tenth asset means a line here plus a line in
 * `scripts/copy-static.mjs`'s verification pass; there is no third place.
 */
export const STATIC_ASSETS: readonly StaticAsset[] = Object.freeze([
  { path: "app.css", contentType: "text/css; charset=utf-8" },
  { path: "datastar.js", contentType: "text/javascript; charset=utf-8" },
  { path: "relative-time.js", contentType: "text/javascript; charset=utf-8" },
  { path: "sites-filter.js", contentType: "text/javascript; charset=utf-8" },
  { path: "novamira-hq-logo-white.svg", contentType: "image/svg+xml" },
  { path: "fonts/montserrat-var.woff2", contentType: "font/woff2" },
  {
    path: "fonts/montserrat-OFL.txt",
    contentType: "text/plain; charset=utf-8",
  },
  { path: "fonts/jetbrains-mono-var.woff2", contentType: "font/woff2" },
  {
    path: "fonts/jetbrains-mono-OFL.txt",
    contentType: "text/plain; charset=utf-8",
  },
] as const satisfies readonly StaticAsset[]);

const ASSETS_BY_PATH = new Map(
  STATIC_ASSETS.map((asset) => [asset.path, asset] as const),
);

/** The directory the nine files live in, next to this module's compiled form. */
export const STATIC_ROOT = fileURLToPath(new URL("./static/", import.meta.url));

interface CachedAsset {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly contentType: string;
}

const CACHE = new Map<string, CachedAsset>();

/**
 * Reject the shapes a path must not have before it is joined to anything.
 *
 * `request.ts` has already decoded the path once, so `..%2f..%2f` and
 * `%2e%2e/` arrive here as the `..` segments they are.
 */
function safeRelativePath(candidate: string): string | undefined {
  if (
    candidate === "" ||
    candidate.includes("\0") ||
    candidate.includes("\\")
  ) {
    return undefined;
  }
  const segments = candidate.split("/");
  for (const segment of segments) {
    if (segment === "" || segment.startsWith(".")) {
      return undefined;
    }
  }
  return segments.join("/");
}

async function loadAsset(asset: StaticAsset): Promise<CachedAsset> {
  const cached = CACHE.get(asset.path);
  if (cached !== undefined) {
    return cached;
  }
  const absolute = resolve(STATIC_ROOT, ...asset.path.split("/"));
  // Defence in depth: the allowlist already fixed the path, so a failure here
  // would mean the constant itself had been edited into something that escapes.
  if (!isInsideRoot(absolute)) {
    throw new CliError(
      "internal_error",
      "A dashboard asset resolved outside the static root.",
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch (cause) {
    throw new CliError(
      "internal_error",
      `The dashboard asset ${asset.path} is missing from the installed build.`,
      { cause },
    );
  }
  const entry: CachedAsset = {
    bytes,
    etag: `"${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}"`,
    contentType: asset.contentType,
  };
  CACHE.set(asset.path, entry);
  return entry;
}

function isInsideRoot(absolute: string): boolean {
  const root = STATIC_ROOT.endsWith(sep) ? STATIC_ROOT : `${STATIC_ROOT}${sep}`;
  return isAbsolute(absolute) && absolute.startsWith(root);
}

/**
 * Serve one asset, or report that there is no such asset.
 *
 * `undefined` means "not an asset" and the caller answers 404 with the usual
 * failure envelope — the handler deliberately does not build that response
 * itself, so there is exactly one 404 shape in the dashboard.
 */
export async function serveAsset(
  urlPath: string,
  method: string,
  ifNoneMatch: string | undefined,
): Promise<DashboardResponse | undefined> {
  if (!urlPath.startsWith(ASSET_PREFIX)) {
    return undefined;
  }
  const relative = safeRelativePath(urlPath.slice(ASSET_PREFIX.length));
  if (relative === undefined) {
    return undefined;
  }
  const asset = ASSETS_BY_PATH.get(relative);
  if (asset === undefined) {
    return undefined;
  }
  const loaded = await loadAsset(asset);
  const contentLength = loaded.bytes.byteLength;
  if (matchesEtag(ifNoneMatch, loaded.etag)) {
    return {
      kind: "asset",
      status: 304,
      contentType: loaded.contentType,
      cacheControl: ASSET_CACHE_CONTROL,
      etag: loaded.etag,
      body: undefined,
      contentLength,
    };
  }
  return {
    kind: "asset",
    status: 200,
    contentType: loaded.contentType,
    cacheControl: ASSET_CACHE_CONTROL,
    etag: loaded.etag,
    // HEAD gets identical headers, `Content-Length` included, and no body.
    body: method === "HEAD" ? undefined : loaded.bytes,
    contentLength,
  };
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  const candidates = header.split(",").map((value) => value.trim());
  return candidates.some(
    (candidate) =>
      candidate === "*" ||
      candidate === etag ||
      candidate === `W/${etag}` ||
      candidate.replace(/^W\//, "") === etag,
  );
}
