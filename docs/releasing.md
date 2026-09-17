# Release Runbook

Novamira HQ releases are one serialized transaction in
`.github/workflows/release.yml`. A release tag is accepted only when its commit
is contained in `main`, its version equals `package.json`, and package acceptance
passes on that exact commit on Linux, macOS, and Windows. Prereleases publish
under `next`; only stable versions publish under `latest`.

## Repository Setup

Before creating a release tag:

1. Make this a public repository. npm provenance and the raw installer URLs both
   depend on public GitHub data.
2. Protect `main` and require the package workflow before merge.
3. Create the GitHub `npm-release` environment, restrict it to release tags, and
   require an approving reviewer.
4. After the package exists, configure npm trusted publishing for
   `use-novamira/novamira-hq`, workflow `release.yml`, environment `npm-release`.
5. Keep publication credentials and provider credentials out of repository and
   workflow variables. Normal releases authenticate only through GitHub OIDC.
6. Create the GitHub `macos-signing` environment, restrict it to release tags,
   and give it the six Apple secrets below and no reviewers. It scopes the
   signing certificate to one job; the human gate stays `npm-release`, which the
   desktop jobs already run downstream of. Then dispatch **Verify macOS
   signing** once, and read its Gatekeeper verdict, before relying on a release
   to sign anything.

All third-party actions in the publication workflow are pinned to reviewed
commit SHAs. Update those SHAs deliberately rather than replacing them with
movable major tags.

## First Publication

npm cannot configure a trusted publisher before `@novamira/hq` exists. The first
publication therefore uses one temporary, tightly scoped bootstrap token:

1. Create an npm granular access token for the Ovation publisher account with
   the minimum available package-creation scope and a short expiration.
2. Add it as the `NPM_BOOTSTRAP_TOKEN` secret on the protected `npm-release`
   environment. Do not add it as a repository or organization secret.
3. Create and push the reviewed release tag on the current `main` commit.
4. Cancel the automatic tag-triggered run before it enters the protected
   environment; without the bootstrap input it is intentionally unable to use
   the token.
5. Manually dispatch `Publish public package` for that existing tag with
   `bootstrap` enabled. Approve the environment only after checking the tag and
   commit shown by the run.
6. Confirm npm shows the exact version and provenance, and GitHub has the release
   with both installer assets.
7. Configure the npm trusted publisher as described above.
8. Delete `NPM_BOOTSTRAP_TOKEN` from GitHub and revoke the token at npm.

Never enable bootstrap for an existing package. The workflow refuses to replace
an exact version whose tarball integrity differs from the tagged commit.

## Normal Release

1. Confirm the package workflow passed on the exact current `main` commit.
2. Create and push `v<package version>` at that commit.
3. Approve the `npm-release` environment after the workflow's three-platform
   acceptance job passes.
4. Confirm the exact npm version, provenance, dist-tag, and GitHub installer
   assets.

Rerunning the workflow is safe after a partial failure. If npm already holds the
exact candidate integrity, publication is skipped and verification, installed
package acceptance, and GitHub release creation continue. A different integrity
fails closed. Serialization and the dist-tag monotonicity check prevent an older
run from moving `latest` or `next` backward.

## Desktop Assets

The `desktop` job compiles the Deno shell on `ubuntu-latest` and
`windows-latest`, runs the compiled executable's `--serve` role before it is
uploaded, and attaches it to the release the job above created. macOS is a
separate job, below, because it is the only one that signs, and it runs twice
because `deno compile` emits a binary for the host — arm64 on `macos-latest`
and Intel on `macos-15-intel`.

Every build carries the same icon, derived at build time by
`scripts/desktop-icons.mjs` from `scripts/macos/icon.png`, the one committed
1024x1024 master. Nothing derived is committed, so no size can drift from it:

- **Windows** — `deno compile --icon` embeds a seven-entry `.ico`. The flag is
  Windows-only, which is why `desktop/deno.json` has a second `compile:windows`
  task and `scripts/desktop-build.mjs` chooses between the two. `deno compile`
  parses the icon and fails on a malformed one, so the Windows leg of
  `package.yml`'s desktop matrix is the automated check on the generator.
- **Linux** — an ELF executable cannot hold an icon, so
  `scripts/desktop-build.mjs --package` writes
  `novamira-hq-desktop-linux-x86_64.tar.gz`: the executable, the freedesktop
  entry `ai.novamira.hq.desktop.desktop`, the hicolor icons its `Icon` key
  resolves, and an `INSTALL.txt` with the three commands. The archive is built
  reproducibly, so re-running the job cannot publish a different tarball than
  the one it replaces. The bare executable is still published beside it.
- **macOS** — `scripts/macos-sign.sh` builds the `.icns` with `sips` and
  `iconutil` and puts it in the bundle it signs, as it always has.

The Windows executable is **not** signed: SmartScreen shows its unrecognized-app
prompt the first time someone runs it, and they have to choose "More info" then
"Run anyway". Authenticode needs an OV or EV certificate this project does not
hold; it is listed under Accepted Risks below.

## macOS Desktop Signing

The `desktop-macos` job runs on both macOS architectures — arm64 on
`macos-latest`, Intel on `macos-15-intel` — compiles the Deno shell natively on
each, then runs `scripts/macos-sign.sh`, which signs it with a Developer ID
Application certificate under the Hardened Runtime, notarizes it, staples the
ticket to the bundle, and publishes two assets per architecture:

- `novamira-hq-desktop-macos-arm64` — the arm64 executable, signed and
  notarized.
- `novamira-hq-desktop-macos-arm64.app.zip` — `Novamira HQ.app` around that same
  executable, signed, notarized and **stapled**.
- `novamira-hq-desktop-macos-x86_64` — the Intel executable, signed and
  notarized.
- `novamira-hq-desktop-macos-x86_64.app.zip` — `Novamira HQ.app` around it,
  signed, notarized and **stapled**.

The `.app` exists beside the bare executable because `xcrun stapler` accepts
only a bundle, a disk image or an installer package. A bare executable can be
notarized but never carries its ticket, so Gatekeeper has to reach Apple the
first time it runs; the `.app` carries the ticket in the download and opens on a
machine that is offline. Point people at the `.app`, and keep the executable for
scripts.

Set these six secrets on the `macos-signing` environment. Nothing else in the
repository may hold them.

| Secret                    | Where it comes from                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `APPLE_CERT_P12_BASE64`   | Developer portal → Certificates → **Developer ID Application** (CSR from Keychain Access), exported with its private key as `.p12`, then `base64 -i cert.p12` |
| `APPLE_CERT_PASSWORD`     | that `.p12`'s export password                                                                             |
| `APPLE_SIGNING_IDENTITY`  | `Developer ID Application: Ovation S.r.l. (TEAMID)`, exactly as `security find-identity -v -p codesigning` prints it |
| `APPLE_API_KEY_P8_BASE64` | App Store Connect → Users and Access → Integrations → **Team Key** with the Developer role, `base64 -i AuthKey_XXXX.p8` |
| `APPLE_API_KEY_ID`        | that key's Key ID                                                                                         |
| `APPLE_API_ISSUER_ID`     | that key's Issuer ID                                                                                      |

Creating the Developer ID certificate requires the Account Holder or an Admin,
and Apple issues a limited number of them: export the `.p12` once, store it where
the team can find it, and reuse it. The App Store Connect key is used instead of
an Apple ID and app-specific password because it belongs to the team rather than
to a person, survives a password change, and is scoped to one role.

`scripts/macos/entitlements.plist` holds the three Hardened Runtime exceptions
the shell needs, and its comment says why each one is there. Two are V8's.
The third, `disable-library-validation`, remains for the bare executable, which
still downloads the upstream native library. The `.app` now includes the correct
`libwebview.<arch>.dylib` under `Contents/Frameworks/`: `macos-native.mjs` selects
the architecture from the executable, verifies the pinned upstream version and
SHA-256, and includes its MIT license. The signing script signs the dylib before
the app. The packaged window uses that local library only, including with an
empty Deno cache; a missing library is an installation error, never a network
fallback. Removing the remaining entitlement requires separating bare-executable
and app entitlements and verifying both with Apple's signing workflow.

If `APPLE_SIGNING_IDENTITY` is unset each job emits a warning annotation and
uploads an unsigned executable rather than failing the release. Before
announcing a release, check both `desktop / novamira-hq-desktop-macos-*` jobs
for that warning.

### Downloading test builds without a release

**Package acceptance** runs on pushes to `main` and can also be dispatched
manually. Each desktop job uploads its build only after the server and MCP
smoke tests pass. Download it from the run's **Artifacts** section within seven
days. Linux includes its installation archive; Windows includes the unsigned
executable. The macOS test artifacts are unsigned arm64 and Intel executables in
tarballs, not signed `.app`s suitable for sharing with colleagues. Use the
signing workflow below for that. Neither workflow publishes to npm or creates a
release.

### Proving the signing path without a release

`.github/workflows/macos-signing.yml` — **Verify macOS signing** — is that job
with the release removed. Dispatch it by hand: it compiles the shell, runs the
same `scripts/macos-sign.sh` against the same `macos-signing` environment,
notarizes for real, prints the signature, entitlements and Gatekeeper verdict,
and attaches both artifacts to the run. It publishes nothing and holds no write
permission, and unlike the release job it *fails* when a secret is missing,
because a green run that skipped signing would answer the only question it
exists to answer with the wrong word.

Dispatch it after setting the six secrets, after renewing the certificate, and
before any release that changes the entitlements, the desktop shell or the
signing script. A Developer ID certificate expires; the first release after that
date is the wrong place to notice.

The artifacts are files, not an unpacked bundle, because GitHub re-zips an
artifact's contents and drops the symlinks, modes and extended attributes a
signed bundle is made of. Unzip the download once to get
`novamira-hq-desktop-macos-<arch>.app.zip` back byte for byte, then unzip that
to get the stapled bundle. The bare executable loses its mode the same way, so
`chmod +x` it before running.

## Accepted Risks

- Installer and launcher behavior remains primarily statically tested; package
  installation and executable acceptance do run on all three target systems.
- Windows ACL and doctor-repair behavior is not covered by the full POSIX-heavy
  contract suite.
- README installer URLs follow mutable `main` rather than a release asset.
- Runtime dependency ranges can resolve newer compatible dependency graphs than
  the release lockfile.
- The macOS desktop app is signed and notarized for both arm64 and Intel, but
  only the `.app` bundles its native webview library; the bare executable still
  downloads it on first launch. Only the `.app` carries a stapled ticket, so it
  is the one that opens offline.
- The Windows desktop executable is unsigned, so SmartScreen warns on first run.
- macOS ships two architectures, arm64 and x86_64; Linux and Windows ship x86_64
  only, so there is no Linux or Windows release asset for arm64.
- The Linux desktop archive is installed by hand from three documented commands;
  there is no Linux desktop installer, and no AppImage or distribution package.
- The desktop icons are verified structurally — sizes, encodings and headers —
  never visually; nothing in CI looks at a taskbar.
- A release whose `macos-signing` secrets are missing still publishes; the
  unsigned macOS asset is flagged by a workflow warning, not by a failure.
