# 005: Complete the Release Validation Gate

Status: open — final gate

## Question

What evidence is still required before the current release candidate can be
published after the hosting-safety decisions are implemented?

## Current Local Evidence

As of 2026-09-07:

- `bun run check` passed with 965 passing tests and one Deno-dependent test
  skipped because Deno was not installed locally.
- `bun run pack:inspect` passed after the guarded restore work.
- Local package acceptance first encountered an owner-mismatched npm cache and
  then could not complete with an isolated empty cache in the restricted local
  environment. This is not a passing acceptance result.
- No live provider API calls were made, by design.
- The guarded restore commit is local and the branch is one commit ahead of its
  tracked remote at this snapshot.

This snapshot is evidence for the review date only. Re-run every gate against
the exact release commit.

## Required Validation

- Resolve Issues 001–003 and update their focused contract tests.
- Run `bun run check` from a clean worktree.
- Run `bun run pack:inspect` and inspect the exact package contents.
- Run `bun run package:acceptance` on Linux, macOS, and Windows in CI.
- Run the Deno desktop checks and desktop builds in their supported CI jobs.
- Exercise macOS signing and notarization through the dedicated protected
  workflow; do not copy Apple credentials into another job.
- Validate provider response shapes with sanitized fixtures.
- Perform explicitly gated smoke tests only on disposable staging environments
  for workflows whose correctness depends on provider operation state.
- Confirm that the release commit contains no forbidden destructive hosting
  surface and no provider or site credentials.
- Push the reviewed commit and require the release workflow to build from that
  exact commit.

## Acceptance Criteria

- All required platform and packaging jobs pass on the exact release commit.
- Provider-dependent safety promises are backed by fixtures and scoped staging
  evidence rather than assumptions about HTTP acceptance.
- The release remains `1.0.0-rc1` unless a separate version decision changes it.
- Documentation, bundled skills, CLI help, dashboard copy, MCP schemas, and
  capability output describe the same final behavior.
