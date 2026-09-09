# 001: Verify Backup Completion Before Restore

Status: implemented — offline contracts; live validation remains in issue 005

## Question

What provider evidence is sufficient for HQ to claim that the pre-restore
safety backup is complete, and what must HQ do when that evidence is missing?

## Current Behavior

The shared verified-action helper requires an operation ID and real terminal
success evidence before push or restore. Missing IDs, synthetic raw-null statuses,
provider errors and uncertain outcomes stop the workflow; they never trigger an
automatic replay. Apply revalidates the plan before mutation. Kinsta's polling
requires its operation payload to say status 200, not merely HTTP success.

WP Engine no longer advertises guarded restore because its generic operation
status cannot prove safety-backup completion. No replacement shortcut was added.

## Implemented Direction

1. Revalidate the target environment and selected backup at apply time.
2. Create the target safety backup.
3. Require provider-specific positive evidence that it completed.
4. Stop before restore on failure, timeout, missing operation id, malformed
   status, or any other indeterminate outcome.
5. Consume the MCP confirmation id even when apply fails.
6. Poll the restore to completion when the provider supplies a verifiable
   operation. If its request has already been accepted but its final state
   cannot be verified, report an indeterminate non-retryable result rather than
   submitting the same restore again.

Kinsta, Pantheon, and Rocket.net expose operation identifiers through their
adapters. Their guarded restore path requires those identifiers.

WP Engine must remain absent from guarded restore until its backup resource can
be polled to a terminal successful state. Re-enable it only with a focused
adapter implementation and fixture-backed tests.

## Questions Still Open

- Which exact WP Engine backup states are terminal and successful?
- Is a backup-specific read endpoint available, or must the adapter poll and
  search the environment backup catalog?
- Indeterminate completion is a non-retryable error with mutation metadata;
  no new public success state was introduced.
- Which sanitized real-provider fixtures can be committed without exposing
  customer or credential data?

## Acceptance Criteria

- No restore request is sent unless safety-backup completion is proven.
- A missing expected operation id fails closed.
- Apply revalidates the selected backup before the first mutation.
- WP Engine is either backed by real resource-state polling or omitted from the
  public restore capability.
- Contract tests cover success, provider failure, timeout, missing identifiers,
  stale plans, and indeterminate post-request outcomes.
- Manual smoke tests use disposable staging environments and never run in CI.
