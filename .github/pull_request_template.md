## What changed, and why

<!-- The behaviour, not the diff. If it changes shipped behaviour, say which
     part of docs/v1-contract.md moves with it. -->

## Contract coverage

<!-- Name the test in test/ that pins this. If none does, say why not. -->

## Checks run

- [ ] `bun run check`
- [ ] `bun run pack:inspect` / `bun run package:acceptance` (packaging, installer or release changes)
- [ ] `bun run desktop:check` (changes under `desktop/`)

## Boundaries

- [ ] No new WordPress site credential, site token or authenticated site request
- [ ] No deletion, reset or DNS-write surface added
- [ ] No provider credential can reach output, an error, a log, a URL or argv
- [ ] No workflow gained a provider credential

## Left out of scope

<!-- Anything you deliberately did not do. -->
