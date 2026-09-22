# Contributing to Novamira HQ

Thank you for taking the time. This document is the short version of
`AGENTS.md`, which is the full set of conventions this repository is developed
under; read that before a substantial change.

Security issues do not belong in a pull request or a public issue. Follow
[`SECURITY.md`](SECURITY.md) and mail **security@novamira.ai**.

## Toolchain

- Node.js 22 or newer, ESM only.
- [Bun](https://bun.sh) runs the scripts and installs dependencies.
- [Deno](https://deno.com) type-checks and builds the desktop shell in
  `desktop/`; the Node toolchain does not own that directory.

```sh
bun install
bun run check            # lint, format check, build, and the contract suite
```

`bun run check` is the gate. Run it before opening a pull request. For a change
to packaging, an installer or the release workflow, also run
artifact build and `bun run desktop:acceptance`; for a change to the
desktop shell, `bun run desktop:check`.

## What a change looks like here

- **Edit `src/`, the tests and the documentation.** `dist/` is generated and
  ignored.
- **Add or update a focused contract test.** Tests in `test/` are named for the
  contract they pin, not for the file they cover, and they are the repository's
  memory of _why_ behaviour is the way it is. A behaviour change that no test
  notices is the thing we are trying to make impossible.
- **Keep `.js` extensions in relative TypeScript imports**, and keep the SPDX
  headers. `bun run headers` adds a missing one.
- **Prefer discriminated unions over class hierarchies**, and an exhaustive
  `switch` with a `never` default.
- **Runtime dependencies are intentionally limited.** Adding one is a product
  and distribution decision, not a detail: discuss it before implementation.
- **No `console.*` in `src/`.** Output goes through the output layer, which owns
  the JSON envelope and the redaction.

## Boundaries that are not negotiable

These are invariants of the product, enforced by tests and restated in
[`SECURITY.md`](SECURITY.md). A pull request that crosses one will be closed
regardless of how well it is written:

- HQ never holds a WordPress site token and never calls an authenticated
  WordPress REST route on a configured site's behalf. Hosting credentials and
  WordPress site authentication remain separate.
- HQ implements no site deletion or reset, no environment deletion, no backup
  deletion, no domain deletion, no DNS-record mutation and no SSH/SFTP
  credential management — through any surface.
- A provider credential never reaches stdout, stderr, an error, a diagnostic, a
  serialized result, a URL or a process argument list.
- No workflow may carry a provider credential, and no test may make a live
  provider call. `scripts/provider-live.mjs` is the single sanctioned live path
  and it refuses to run under CI; see `AGENTS.md`.

A change to shipped behaviour must include focused contract coverage and update
the relevant user-facing documentation in the same pull request.

## Pull requests

Describe what changed and why, name the contract test that covers it, and say
which of `check`, `desktop:acceptance` and `desktop:check` you
ran. If you deliberately left something out of scope, say so — that is useful,
not embarrassing.

## Licence

Contributions are accepted under
[AGPL-3.0-or-later](LICENSE), the licence this project ships under. By opening a
pull request you confirm you have the right to contribute the code under it.
