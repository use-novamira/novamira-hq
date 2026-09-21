# Building Novamira HQ and its embedded runtime from source

## Status and scope

This guide accompanies the corresponding-source offer in `legal/SOURCE-OFFER.txt`.
It describes ordinary HQ builds and a source-build path for modifying the
LGPL-covered glibc-derived code embedded through V8. It is not legal clearance,
nor a claim of byte-for-byte reproducibility of signed release artifacts.

**Verification status:** HQ build/package checks are automated. The upstream
source-build controls below have been checked in upstream documentation/code.
The complete modified-V8 → Deno runtime → HQ build has **not yet been executed
and validated by this project**, on any platform. Do not mark that step complete
based only on the presence of this guide.

## Match the distributed version

Use the HQ commit or release tag corresponding to your binary, not the latest
branch. The GitHub Actions run identifies its source commit. Keep that checkout's
`bun.lock`, `desktop/deno.lock`, `legal/manifest.json` and build workflows.

The current reference chain is:

| Component | Source reference                                                             |
| --------- | ---------------------------------------------------------------------------- |
| HQ        | https://github.com/use-novamira/novamira-hq — matching release tag/commit    |
| Site CLI  | https://github.com/use-novamira/novamira-cli/tree/v1.3.0                     |
| Deno      | https://github.com/denoland/deno/tree/v2.9.6                                 |
| Rusty V8  | https://github.com/denoland/rusty_v8/tree/v150.4.0                           |
| V8        | https://github.com/denoland/v8/tree/ac1e23989121713ca642f6650b34deff7b686896 |

These are version-specific references, not a promise that later HQ releases use
the same runtime. Check the manifest and workflows in your release. If access or
materials are missing, request them from **dev@novamira.ai**, identifying the HQ
version, commit if known, and platform. No license key or purchase is required.

## Prerequisites

Build natively for the desired OS/architecture. Install Git, Node.js 22+, Bun
(use the version in the matching workflow), and Deno matching the reference.
For runtime rebuilding, also install rustup/Cargo and the toolchain specified by
Deno's `rust-toolchain.toml`, Python 3, and the native build prerequisites listed
in the matching Rusty V8 README. Network access is needed to obtain dependencies.

- macOS: Xcode and command-line tools; build Intel and Apple Silicon separately.
- Linux: a C/C++ toolchain and Rusty V8's development dependencies; running HQ's
  window additionally requires WebKitGTK 4.1.
- Windows: a 64-bit MSVC build environment and Windows SDK; run commands in a
  developer shell. The GUI uses WebView2.

The source-build instructions are upstream at:
https://github.com/denoland/rusty_v8/blob/v150.4.0/README.md

## Ordinary HQ build

In the matching HQ checkout:

```sh
bun install --frozen-lockfile
bun run check
bun run desktop:build
```

The result is `dist-desktop/novamira-hq-desktop` (`.exe` on Windows).
The site CLI comes from the exact integrity-locked public npm release in both
distributions, with its `guide-data/` assets. No sibling checkout is used. Its
AGPL license is identical to the included `LICENSE`; its source and build scripts
are available at the public tag above. `spawn-acceptance` is a test-only compiled
executable and is not part of release archives. Run `node scripts/desktop-smoke.mjs`
to exercise compiled offline site features and process cleanup.
This normally uses a **precompiled** Deno runtime. It rebuilds HQ, but does not
recompile the LGPL component. The following steps are needed to modify that code.

## Rebuild the runtime with modified library source

Use separate fresh source checkouts, outside your HQ checkout:

```sh
git clone --branch v2.9.6 --recurse-submodules https://github.com/denoland/deno.git deno-source
git clone --branch v150.4.0 --recurse-submodules https://github.com/denoland/rusty_v8.git rusty-v8-source
git -C rusty-v8-source/v8 rev-parse HEAD
```

Verify the V8 commit against the table before modifying it. The LGPL code is
under `rusty-v8-source/v8/third_party/glibc/`; preserve its notices. Keep your
patch and the original commit IDs. Do not edit installed Cargo registry caches.

In the Deno source checkout, add an entry to its root Cargo.toml
`[patch.crates-io]` table (merge with any existing table):

```toml
[patch.crates-io]
v8 = { path = "/absolute/path/to/rusty-v8-source" }
```

Use your actual absolute path (forward slashes also work in Windows TOML).
This patches the `v8` package, not Deno's `deno_v8` facade. Regenerate the lock
only as required for this deliberate local patch and inspect the diff; do not
perform an unrelated dependency upgrade. Confirm the local source with
`cargo tree -p v8` before building.

From the Deno checkout, POSIX shell:

```sh
export V8_FROM_SOURCE=1
cargo build --release --manifest-path cli/Cargo.toml --bin deno
cargo build --release --manifest-path cli/rt/Cargo.toml --bin denort
```

PowerShell uses `$env:V8_FROM_SOURCE = '1'` followed by the same Cargo commands.
Unset any `RUSTY_V8_ARCHIVE` override for this source-build path. Preserve build
logs and verify they compile the modified source rather than downloading a V8
archive. Expected outputs are `target/release/deno` and `target/release/denort`
(both with `.exe` on Windows). Fix build failures before continuing; do not
silently fall back to a precompiled runtime.

## Embed the rebuilt runtime in HQ

In the HQ checkout, replace the example paths with your build locations:

```sh
export PATH="/absolute/path/to/deno-source/target/release:$PATH"
export DENORT_BIN="/absolute/path/to/deno-source/target/release/denort"
deno --version
bun run desktop:build
```

PowerShell equivalent:

```powershell
$env:PATH = 'C:\source\deno-source\target\release;' + $env:PATH
$env:DENORT_BIN = 'C:\source\deno-source\target\release\denort.exe'
deno --version
bun run desktop:build
```

`DENORT_BIN` is important: merely rebuilding the `deno` command is insufficient
if compilation downloads an unmodified runtime. Deno 2.9.6's selection code is at:
https://github.com/denoland/deno/blob/v2.9.6/cli/standalone/binary.rs
HQ's desktop build inherits these environment variables. Use a runtime for the
same OS/architecture as the intended executable; this is not a cross-build recipe.

Run `node scripts/desktop-smoke.mjs <compiled-executable>` and open the GUI.
Also retain evidence that your library change reached the executable; a passing
HQ smoke test alone does not prove that the modified V8 was linked.

## Signing, distribution and verification record

Ovation's Apple signing credentials are not needed to compile the source and
are not distributed. A locally modified build is not the official signed app;
macOS signing/Gatekeeper requirements and credential-helper consent still apply.
Do not disable those protections to make a build test pass. The packaging source
is in `scripts/` and `.github/workflows/`; these are distinct from compilation.

For each distributed version, preserve the HQ commit, upstream commits and
submodules, dependency locks, modifications, toolchain versions, build commands,
logs and output checksums needed to fulfill the offer. Record successful tests
separately for macOS Intel, macOS Apple Silicon, Windows and Linux. Public upstream
links help recipients locate materials but do not cancel Ovation's source offer
if a link later disappears. No end-to-end runtime rebuild is recorded yet.
