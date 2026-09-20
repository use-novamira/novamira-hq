# 005: Complete the Release Validation Gate

Status: open — final gate

## Question

What evidence is still required before the current release candidate can be
published after the hosting-safety decisions are implemented?

## Current Local Evidence

As of 2026-09-20, `docs/release-defects.md` records every defect from the
release review as closed, so this issue — evidence, not defects — is what gates
the tag. Two gaps are open and known: the repository is still private, and no
adapter has been run against a live provider API.

As of 2026-09-09 (working tree, not a published release):

- `bun run check` passed with 1000 passing tests and none skipped.
- Deno desktop formatting, lint and type checks passed.
- The local macOS desktop build passed; headless dashboard startup and shutdown,
  and MCP initialization/tool listing passed without opening a window.
- `bun run pack:inspect` and local package acceptance passed. Acceptance used an
  isolated temporary npm cache because the normal cache has permission errors;
  the normal cache was not modified.
- No live provider API calls were made, by design.
- No commit, push, version bump, release, signing or notarization was performed.
- Visual review in a real browser remains pending: no controllable browser was
  available in this session. Rendering, route/token guards, app acknowledgement,
  MCP verification and deploy execution have offline contract coverage.

This snapshot is evidence for the review date only. Re-run every gate against
the exact release commit.

## Required Validation

- Review the implementation and focused contracts for Issues 001–003.
- Run `bun run check` from a clean worktree.
- Run `bun run pack:inspect` and inspect the exact package contents.
- Run `bun run package:acceptance` on Linux, macOS, and Windows in CI.
- Run the Deno desktop checks and desktop builds in their supported CI jobs.
- Exercise macOS signing and notarization through the dedicated protected
  workflow; do not copy Apple credentials into another job.
- Validate provider response shapes with sanitized fixtures.
- Run the live provider gate on an operator machine, at the release commit, for
  every provider the release claims to support:
  `bun run providers:live -- --report <path>`. It is read-only, refuses to run
  under CI, and records response shapes rather than values, so its report can be
  attached here. This is the only evidence that an adapter still matches its
  provider's API; everything else in `test/` proves the adapter against bodies
  we wrote ourselves. Attach one report per provider validated, and name the
  providers with no report — a release may ship with gaps, but not with unnamed
  ones.
- Perform explicitly gated smoke tests only on disposable staging environments
  for workflows whose correctness depends on provider operation state.
- Confirm that the release commit contains no forbidden destructive hosting
  surface and no provider or site credentials.
- Push the reviewed commit and require the release workflow to build from that
  exact commit.

## Acceptance Criteria

- All required platform and packaging jobs pass on the exact release commit.
- The live provider gate has been run at that commit, its reports are attached,
  and any provider without one is named as a known gap.
- Provider-dependent safety promises are backed by fixtures and scoped staging
  evidence rather than assumptions about HTTP acceptance.
- The release remains `1.0.0-rc1` unless a separate version decision changes it.
- Documentation, bundled skills, CLI help, dashboard copy, MCP schemas, and
  capability output describe the same final behavior.
