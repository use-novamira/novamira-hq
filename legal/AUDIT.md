# HQ legal inventory — 2026-09-16

## Status

The application-level inventory and bundled notice viewer are implemented.
**Desktop redistribution review is not complete.** Do not interpret a successful
application build or `legal:check` as legal clearance for a desktop release.
`bun run legal:desktop-check` deliberately fails while this remains unresolved.
This is an engineering inventory, not a legal opinion.

## What is covered

- `npm-inventory.json` records all 113 entries in the current Bun lock, including
  development-only packages, with versions and declared license identifiers.
  The declarations are MIT, Apache-2.0, Python-2.0, BSD-2-Clause, BSD-3-Clause,
  ISC and BlueOak-1.0.0. Development tools are not application runtime payload;
  their complete source/license audit is not substituted for the desktop review.
- The two production npm packages in `package.json`, checked against the installed
  manifests and `desktop/deno.lock`. Neither currently declares transitive runtime
  packages in that lock: commander 14.0.3 and Datastar SDK 1.0.0, both MIT.
- All seven JSR packages in `desktop/deno.lock`, with their MIT license texts.
- Datastar browser runtime 1.0.2, including the previously missing MIT notice.
- Montserrat and JetBrains Mono, with their original OFL-1.1 notices. Their exact
  vendored binaries are identified by SHA-256 because upstream version metadata
  was not recorded at import time.
- OpenAI/Claude SVG paths from Simple Icons 14.3.0; Cursor/OpenCode paths verified
  against Simple Icons commit 4ba19240849175ab4b855a732ab98c0f87cfb714. The original
  CC0 text is included. Brand rights remain separate.
- VS Code's official stable icon is attributed under Microsoft's brand terms,
  not incorrectly labelled MIT. See <https://code.visualstudio.com/brand>.
- webview_deno 0.9.0 and its upstream native webview submodule at
  c5b19403382ef089f9933ea5331c76aa35414589, with both MIT notices.
- The downloaded Claude Desktop MCP bundle now includes HQ's complete AGPL text,
  copyright attribution and the unminified launcher source. It does not embed
  Node/Deno or HQ's runtime dependencies; its README explains the distinction.

The `manifest.json` entries distinguish shipped application components from
**desktop runtime references**, which are not a verified binary dependency graph.

## Copyleft / source findings

- HQ itself is AGPL-3.0-or-later. When giving a binary to a colleague or customer,
  provide access to its matching Corresponding Source and build scripts. A link
  to a private GitHub repository is not useful to a recipient without access.
  Do not make the repository public automatically: give the recipient access or
  an appropriate source archive. See <https://www.gnu.org/licenses/agpl-3.0.html>.
- The conservative `denort` candidate closure contains seven MPL declarations:
  cooked-waker 5.0.0, cssparser 0.36.0, cssparser-macros 0.6.1, dtoa-short 0.3.5,
  smartstring 1.0.1, webpki-root-certs 0.26.6 and webpki-roots 0.26.1. Their
  published archive notices have been collected. The source scan did not find
  an "Incompatible With Secondary Licenses" marker outside license texts;
  that automated scan is evidence, not a final compatibility opinion.
- MPL is not automatically an incompatibility. If MPL-covered code is distributed
  in executable form, provide the covered source and tell recipients where to
  obtain it. See sections 3.1–3.2 and the official FAQ:
  <https://www.mozilla.org/MPL/2.0/> and <https://www.mozilla.org/MPL/2.0/FAQ/>.
- The two runtime npm packages and the locked JSR packages declare MIT. This
  finding does **not** establish that the complete native app is copyleft-free.

- **V8 includes forked glibc math sources under LGPL-2.1-or-later.** This is
  not just the Linux operating system's shared glibc. V8's `README.v8` marks the
  component as shipped, and the `s_sin.c` header grants version 2.1 or later.
  The inspected V8 GN default enables `v8_use_libm_trig_functions` for Clang;
  Rusty V8 normally uses Clang. Actual target artifacts and build arguments
  still need verification. The complete LGPL text is preserved in
  `v8-source-notices.json`. Before redistribution, establish the applicable
  license route, corresponding covered source and any relinking requirements;
  a top-level MIT notice or a bare repository link is not a substitute.
  Source evidence at V8 revision `ac1e23989121713ca642f6650b34deff7b686896`:
  [component notice](https://github.com/denoland/v8/blob/ac1e23989121713ca642f6650b34deff7b686896/third_party/glibc/README.v8),
  [source header](https://github.com/denoland/v8/blob/ac1e23989121713ca642f6650b34deff7b686896/third_party/glibc/src/sysdeps/ieee754/dbl-64/s_sin.c),
  [build default](https://github.com/denoland/v8/blob/ac1e23989121713ca642f6650b34deff7b686896/gni/v8.gni).
- `r-efi` offers MIT OR Apache-2.0 OR LGPL-2.1-or-later: the LGPL branch is not
  mandatory. V8's optional VTune notice offers BSD OR GPLv2, not GPLv2-only.
  Alternative licenses must not be reported as mandatory copyleft.
- `libuv-sys-lite`'s registry label "non-standard" resolves to a source notice
  containing MIT plus BSD/ISC third-party references. Those nested references
  need review; the label alone does not establish incompatibility.

## Runtime source evidence collected

`denort-inventory.json` contains 900 candidate records: 56 Deno workspace
packages and 844 registry packages. Unlike a raw workspace lock dump, traversal
starts at the embedded `denort` runtime and excludes workspace-only development
and build edges. Registry optional, build and target-alternative edges remain
conservative: **this is not a binary SBOM**.

All 844 registry archives were downloaded and checked against Cargo.lock SHA-256
values, without running their build scripts. Standalone or pinned workspace-root
notice files were recovered for 793 of them; 51 still lack collected standalone
texts. Root fallback texts require per-directory review, especially where Cargo
records a dirty working tree. Failed/missing sources are never replaced with a
moving branch's license or an invented copyright attribution.

`denort-license-texts.json` preserves 538 distinct original texts, deduplicated by
SHA-256; every notice reference is verified during offline builds. Seventeen V8
source-tree notices are also preserved, including LGPL, permissive alternatives
and optional components. Additional Rusty V8 submodules (including ICU and LLVM
runtime pieces), compiler/runtime notices and Windows payloads remain unclosed.
About's downloadable notices include this evidence with explicit scope warnings.

## Still required for desktop release clearance

1. Establish the exact Deno version and target-specific embedded dependency graph
   for each release. As of 2026-09-18, all CI workflows pin Deno `v2.9.6`, matching
   the locally inspected reference (V8 15.0.245.2-rusty, TypeScript 6.0.3).
   This pin does not complete the runtime notice or LGPL review. The upstream Deno workspace Cargo.lock has
   1,128 entries, including build/test dependencies; copying it is not a binary SBOM.
2. Collect the applicable notices for the embedded Rust crates and V8's own
   third-party libraries. Deno's MIT license and V8's top-level BSD license are
   explicitly not substitutes for those notices.
3. Verify any redistributed WebView2 loader/runtime on Windows and distinguish
   it from engines provided by the operating system (macOS WebKit, Linux WebKitGTK).
4. Verify that every final archive includes notices and recipients can obtain
   matching HQ source and any covered third-party source. No desktop app was
   rebuilt during this inventory change, so existing test apps are unchanged.

## Maintenance

`legal/manifest.json` records versions, scope, sources and license text files.
The build runs `scripts/legal-notices.mjs` offline, checks dependency versions and
asset digests, and embeds a single readable text at
`dist/web/static/third-party-notices.txt`. About links to this allowlisted asset.
The npm package also ships `legal/`; desktop builds already embed `dist/`.
The generator never fetches licenses or installs packages. Preserve upstream
copyright and license text verbatim; do not add HQ's SPDX header to those texts.

When updating a dependency, review its new license, source provenance and
transitive dependencies before changing the inventory. The desktop completeness
flag must not be flipped merely to make a build pass.

To reproduce the source evidence, run the explicit audit tools with a separate
temporary output directory (the first three access public upstream sources):

```sh
bun scripts/audit-deno-licenses.mjs 2.9.6 /private/tmp/hq-deno-license-audit-2.9.6
bun scripts/audit-crate-texts.mjs /private/tmp/hq-deno-license-audit-2.9.6
bun scripts/audit-upstream-notices.mjs /private/tmp/hq-deno-license-audit-2.9.6
node scripts/import-runtime-legal.mjs /private/tmp/hq-deno-license-audit-2.9.6
```

The importer writes only the two generated denort JSON inventories and retains
incomplete status. Review the diff and remaining findings before committing.
The V8 source notices were collected separately at the exact recorded revision;
they are not regenerated by the Rust archive tools.
