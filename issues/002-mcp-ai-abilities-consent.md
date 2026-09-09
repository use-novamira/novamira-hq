# 002: App Acknowledgement and Explicit AI Abilities Activation

Status: implemented — final product decision, 2026-09-08

## Decision

The initial HQ application screen explains and asks the user to accept that an
AI may explicitly enable Novamira AI Abilities without asking again. These allow
PHP execution and filesystem/data changes. This is app onboarding, not a
revocable authorization, per-hosting permission, or per-site prompt.

CLI and MCP require no acceptance record and do not consult it. Their launch
capability policy remains independent. Plan/apply is not proof of a human prompt.
No change to the separate Novamira site CLI is part of this work.

## Setup behavior

- A new installation enables abilities automatically.
- An existing compatible installation preserves both options by default.
- CLI --ai-abilities or MCP enableAiAbilities: true explicitly enables them and
  binds them to the current domain. An AI can make this request autonomously.
- --force controls reinstallation, not abilities activation.
- An existing version below the compatibility minimum stops before mutation,
  even with force; updating it is a separate explicit operation.
- Dashboard Connect only invokes the site CLI login and never enables abilities.

## Evidence

The app acknowledgement is versioned in private HQ state. Setup, MCP schema,
dashboard defaults, normative contract and focused tests follow this policy.
The earlier proposal for revocable per-profile consent is superseded.
