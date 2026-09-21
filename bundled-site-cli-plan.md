# Bundle Novamira CLI with HQ

## Goal

Ship a pinned public npm release of `@novamira/cli` with both HQ distributions:

- **npm:** `@novamira/hq` includes the CLI as a dependency and runs it using the
  Node runtime already required by HQ.
- **Desktop:** embed the CLI in the compiled application and run it using the
  application's embedded Deno runtime. Users need no separate Node, npm, Deno,
  or `novamira` installation for site features.

This document is a proposed implementation plan, not authorization to override
the current repository instructions. No implementation is included.

## Prerequisite: authorize the packaging change

Before implementation, revise the active repository instructions that prohibit
any `@novamira/cli` dependency or import. Explicitly permit a pinned dependency
for npm HQ and a desktop-only launch entry point for the embedded CLI.

Preserve these architectural requirements:

- Site commands execute in a separate child process through `src/integration/`.
- The site CLI alone owns site configuration, tokens, credential storage, and
  WordPress HTTP requests. HQ consumes public command arguments and JSON output.
- HQ and the site CLI keep their separate storage namespaces.
- CLI arguments use arrays with `shell: false`; cancellation, timeouts, bounded
  output, and process-tree termination remain enforced.
- Hosting operations do not depend on a successful site-CLI invocation.
- Runtime-specific Deno code stays under `desktop/`.

## 1. Establish the upstream package interface

Work in `novamira-cli`, following that repository's own instructions.

1. Provide a documented package export for its existing callable `main()` entry
   point, with stable argument, output, and exit-code behavior. Keep the normal
   `novamira` executable supported.
2. Add an explicit embedded/distribution option so a bundled invocation cannot
   run npm/Bun self-update. Direct users to update HQ instead. Suppress automatic
   CLI update notices for HQ-managed invocations.
3. Make runtime diagnostics accurately represent an embedded Deno runtime rather
   than assuming `process.versions.node` identifies the actual runtime.
4. Verify Node-compatible filesystem, HTTP, crypto, stream, subprocess, and
   packaged-data access under Deno. Make narrowly scoped compatibility fixes as
   needed; do not assume source compatibility proves compiled compatibility.
5. Retain the existing profile and credential namespace so standalone and bundled
   CLI installations can share state. Document supported version coexistence.
6. Publish the resulting public npm release before pinning it in HQ.

Acceptance: the published tarball contains the launch export and required data;
its existing Node behavior passes tests, and offline Deno checks exercise the
entry point and packaged assets.

## 2. Add a shared launch-target abstraction in HQ

Use the existing `SiteCliResolution` shape (`command`, `prefixArgs`) as the
launch target. Pass it through composition roots rather than adding separate
launch logic to individual commands.

1. For npm HQ, resolve the pinned dependency's supported entry point from HQ's
   installation, not the current directory or a global npm prefix. Launch a
   minimal integration-owned wrapper with the current Node executable; the
   wrapper invokes the upstream entry point in the child process.
2. For desktop HQ, inject the current desktop executable with a fixed
   `--site-cli` prefix, including the required development launch arguments when
   running an uncompiled desktop shell.
3. Apply the same resolution policy to dashboard connection detection, login,
   profile management, site operations, MCP, and doctor.
4. Default to the packaged copy instead of searching `PATH`. Preserve the
   explicit `NOVAMIRA_HQ_SITE_CLI` override for intentionally selected external
   executables and test its precedence. Do not silently select an arbitrary
   global CLI when the packaged installation is damaged.
5. Correct Node-specific Windows shim assumptions: `process.execPath` in a
   compiled desktop process is not a Node executable. External overrides must
   have a documented supported launch form.
6. Report missing or incompatible packaged code as an actionable repair/update
   state while keeping hosting operations usable.

Acceptance: every site-CLI consumer uses the intended target, independently of
the working directory, global npm layout, and whether `novamira` is on `PATH`.

## 3. Include the dependency in the npm distribution

1. Add the released `@novamira/cli` version as an exact runtime dependency and
   update the lockfile. Test and release HQ against that exact version.
2. Add a public `novamira-hq site-cli <arguments...>` forwarding command so users
   can run the bundled CLI without a global `novamira` command. Preserve child
   stdin/stdout/stderr and exit codes, and ensure HQ option parsing does not
   consume the forwarded CLI's flags. Declare and test this public grammar.
3. Update provisioning handoffs, dashboard hints, and relevant documentation to
   use an available launch path. Installing a nested npm dependency does not
   guarantee that a global `novamira` executable exists.
4. Remove the installers' separate global CLI installation step and obsolete
   skip option. Preserve HQ installation, smoke tests, skill registration, and
   desktop launcher behavior.
5. Ensure standalone CLI installations can coexist without HQ modifying their
   binaries or independently updating its managed dependency.

Acceptance: a clean HQ npm install can perform offline CLI commands through its
own dependency, with no global `novamira` installation or registry access at
runtime for module resolution.

## 4. Embed the same release in the desktop application

1. Stage the exact CLI npm artifact for the desktop build. Reuse the installed
   pinned dependency or verify an explicitly fetched artifact; never build from
   an unversioned sibling checkout or an unpinned npm tag.
2. Embed its JavaScript and required package data, preserving relative paths.
   Include the CLI's guide data and other shipped assets used at runtime.
3. Add a `--site-cli` role to `desktop/main.ts` before the window role. Load the
   supported upstream entry point, select embedded distribution behavior, and
   propagate its exit code without creating a window or dashboard server.
4. Wire the bundled target into desktop dashboard, terminal, and MCP roles.
5. Ensure the module graph and dependencies are available offline in the
   compiled executable, without an npm cache or writable installation directory.
6. Update build scripts, Deno configuration/lockfiles, release packaging, bundled
   notices, and source attribution for the added package.

Acceptance: a compiled desktop application can run CLI commands and site
features on a clean machine without external JavaScript runtimes or CLI tools.
Existing platform browser, webview, and credential-service requirements remain.

## 5. Update contracts and user-facing behavior

Update `AGENTS.md` after the prerequisite authorization, `docs/v1-contract.md`,
README, installer documentation, release documentation, and affected comments and
contract tests to describe the new distribution model consistently.

Document:

- The exact bundled CLI version and how to inspect it.
- Updating HQ updates its managed CLI; standalone CLI updates are separate.
- External executable override precedence and supported launch forms.
- Shared CLI profiles and credentials, including coexistence expectations.
- Repair guidance replacing the normal "install the optional CLI" hint.
- Public forwarding grammar and revised provisioning handoffs.

## 6. Verify the complete distributions

### Focused automated contracts

- Packaged resolution, explicit overrides, paths with spaces, and Windows launch
  behavior, with no accidental `PATH` fallback.
- Consistent targets across doctor, dashboard, MCP, and terminal entry points.
- CLI arguments, stdin, JSON output, error codes, and forwarding semantics.
- Packaged assets and version parity between npm and desktop distributions.
- Embedded update behavior never spawning a package manager.
- Existing timeout, cancellation, output bounds, and descendant cleanup behavior
  under the actual embedded runtime.

Use isolated homes, local mock HTTP servers, and injected command runners. Do
not access real credentials, provider APIs, or live WordPress sites in tests.

### Platform acceptance

On macOS, Windows, and Linux, validate the compiled artifact, not just `deno
run`. Cover OAuth browser launch and loopback callbacks, credential persistence,
profile operations, and a representative mocked site operation. Exercise signed
macOS packaging and platform credential behavior with dedicated test records.

Run desktop acceptance without Node, npm, Deno, or external `novamira` available,
and without a populated Deno/npm runtime cache. Verify that child cancellation
does not leave descendants running.

### Required repository checks

- `bun run check`
- `bun run pack:inspect`
- `bun run package:acceptance`
- `bun run desktop:check`
- Desktop build and compiled smoke/acceptance checks on supported platforms
- Legal notice checks applicable to npm and desktop packaging
- Upstream CLI checks required by its repository

## Completion criteria

Both HQ distributions ship the same pinned public CLI release. Site features
work without a separately installed CLI; the compiled desktop additionally
needs no installed JavaScript runtime. HQ continues delegating site access to a
bounded child process, and packaged updates, terminal handoffs, diagnostics,
documentation, and platform acceptance all reflect the new model.
