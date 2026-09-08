# 002: Require Human Consent Before MCP Enables AI Abilities

Status: direction agreed — mechanics open

## Question

How does an operator explicitly accept, before an MCP-controlled setup, that an
agent may enable Novamira AI Abilities and therefore permit PHP execution and
filesystem operations in WordPress?

## Security Invariant

Plan/apply is not proof of human consent: the same agent can call both tools.
Consent must be granted outside the MCP tool surface and checked before any
provider request or WP-CLI mutation.

## Agreed Direction

- Dashboard Connect remains unchanged. It starts `novamira auth login <url>`
  and does not enable AI Abilities.
- An HQ operation that enables AI Abilities requires prior human consent.
- Consent is disabled by default, clearly describes PHP and filesystem access,
  is revocable, and is scoped at least to a hosting profile.
- Broad MCP access alone must not silently imply this consent.
- MCP cannot create, widen, or renew its own consent.
- A denied request must explain exactly which consent is missing and how the
  operator can grant it.
- No change to `@novamira/cli` is part of this issue.

## Proposed User Message

> Allow agents connected through Novamira HQ MCP to enable Novamira AI
> Abilities for this hosting profile. AI Abilities permit PHP execution and
> filesystem operations in WordPress. While this authorization is active, an
> agent may enable them without asking again for each setup.

## Questions Still Open

- Is consent stored as an owner-only HQ policy, supplied as an explicit MCP
  launch policy, or represented by a short-lived session authorization?
- Is profile scope sufficient, or must consent name individual environments?
- Does consent expire at process exit, after a fixed duration, or only when the
  operator revokes it?
- Should `hosting_novamira_setup` always mean a full agent-ready setup, with no
  `enableAiAbilities` choice, or should the setup tool retain an explicit mode?
- Where should the dashboard expose grant, scope, expiry, and revocation?
- Should the tool remain advertised when consent is absent so its refusal can
  explain the missing authorization?

## Acceptance Criteria

- Omitting consent can never enable AI Abilities.
- An agent cannot grant consent through any MCP tool.
- The consent check happens before plugin installation, update, activation, or
  option writes.
- Structured MCP errors name the hosting profile and use no secrets.
- Dashboard copy distinguishes Connect from Set up Novamira.
- Tests prove that every access preset, including the broadest preset, behaves
  according to the chosen explicit-consent rule.
