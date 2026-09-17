#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
# SPDX-License-Identifier: AGPL-3.0-or-later

# Sign, notarize and staple the compiled macOS desktop executable.
#
#   scripts/macos-sign.sh dist-desktop/novamira-hq-desktop-macos-arm64
#
# Produces two release assets beside the input:
#
#   <binary>              the same executable, Developer ID signed and notarized
#   <binary>.app.zip      "Novamira HQ.app" around it, signed, notarized, stapled
#
# Both matter. `xcrun stapler` only accepts a bundle, a disk image or an
# installer package, so a bare executable can be notarized but never carries its
# ticket: Gatekeeper has to ask Apple online the first time it runs. The `.app`
# carries the ticket in the download, works on a machine that is offline at
# first launch, and is the thing a person double-clicks. The bare executable
# stays because it is the asset this release already publishes and the shape a
# script expects.
#
# Runs only on a macOS host: every tool it uses is Apple's. It creates a
# throwaway keychain under $RUNNER_TEMP (or a mktemp dir) and removes it, the
# .p12 and the App Store Connect key on the way out, whatever the exit status.
#
# Required environment:
#   APPLE_CERT_P12_BASE64   base64 of the Developer ID Application .p12
#   APPLE_CERT_PASSWORD     that .p12's export password
#   APPLE_SIGNING_IDENTITY  "Developer ID Application: Name (TEAMID)"
#   APPLE_API_KEY_P8_BASE64 base64 of the App Store Connect .p8 private key
#   APPLE_API_KEY_ID        that key's Key ID
#   APPLE_API_ISSUER_ID     that key's Issuer ID
#
# The App Store Connect key is deliberate: notarytool also takes an Apple ID and
# an app-specific password, but that is a person's account credential, it breaks
# when they change their password, and it cannot be scoped to one role.

set -euo pipefail

fail() {
  printf 'macos-sign: %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "this script signs on macOS only"
[ $# -eq 1 ] || fail "usage: macos-sign.sh <compiled-executable>"

binary=$1
[ -f "$binary" ] || fail "no such executable: $binary"

for name in \
  APPLE_CERT_P12_BASE64 APPLE_CERT_PASSWORD APPLE_SIGNING_IDENTITY \
  APPLE_API_KEY_P8_BASE64 APPLE_API_KEY_ID APPLE_API_ISSUER_ID; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || fail "$name is not set"
done

root=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
entitlements=$root/scripts/macos/entitlements.plist
[ -f "$entitlements" ] || fail "missing entitlements at $entitlements"
icon=$root/scripts/macos/icon.png
[ -f "$icon" ] || fail "missing application icon at $icon"

work=${RUNNER_TEMP:-$(mktemp -d)}
keychain=$work/novamira-signing.keychain-db
certificate=$work/novamira-signing.p12
api_key=$work/novamira-notary.p8
staging=$work/novamira-notarize
iconset=$work/novamira-hq.iconset
keychain_password=$(uuidgen)
created_keychain=

cleanup() {
  status=$?
  rm -f "$certificate" "$api_key"
  rm -rf "$staging" "$iconset"
  if [ -n "$created_keychain" ]; then
    security delete-keychain "$keychain" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

# --- the signing identity, in a keychain that outlives nothing -------------

printf '%s' "$APPLE_CERT_P12_BASE64" | base64 --decode >"$certificate" ||
  fail "APPLE_CERT_P12_BASE64 is not valid base64"

security create-keychain -p "$keychain_password" "$keychain"
created_keychain=yes
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$certificate" -k "$keychain" -P "$APPLE_CERT_PASSWORD" \
  -f pkcs12 -T /usr/bin/codesign ||
  fail "could not import the Developer ID certificate"
rm -f "$certificate"
# Without this, codesign blocks on a UI prompt no runner can answer.
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$keychain_password" "$keychain" >/dev/null
# Prepend, never replace: the login keychain stays reachable for everything else.
# shellcheck disable=SC2046
security list-keychains -d user -s "$keychain" \
  $(security list-keychains -d user | sed 's/"//g')

security find-identity -v -p codesigning "$keychain" |
  grep -qF "$APPLE_SIGNING_IDENTITY" ||
  fail "the imported certificate is not \"$APPLE_SIGNING_IDENTITY\""

sign() {
  codesign --force --timestamp --options runtime \
    --entitlements "$entitlements" \
    --keychain "$keychain" \
    --sign "$APPLE_SIGNING_IDENTITY" "$1" ||
    fail "could not sign $1"
  codesign --verify --strict --verbose=2 "$1" ||
    fail "the signature on $1 does not verify"
}

# --- the application bundle -------------------------------------------------

version=$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$root/package.json")
app=$(dirname "$binary")/Novamira\ HQ.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

# The icon is one 1024x1024 master; `iconutil` wants every representation the
# Finder, the Dock and Get Info ask for, at both scale factors, or it refuses
# the iconset. Built here rather than committed as an .icns so the master stays
# the reviewable artefact and the derived sizes cannot drift from it.
rm -rf "$iconset"
mkdir -p "$iconset"
node "$root/scripts/desktop-icons.mjs" --macos "$work/macos-icon.png" ||
  fail "could not prepare the macOS icon margins"
icon=$work/macos-icon.png
for size in 16 32 128 256 512; do
  retina=$((size * 2))
  sips -z "$size" "$size" "$icon" \
    --out "$iconset/icon_${size}x${size}.png" >/dev/null ||
    fail "could not scale the application icon to ${size}x${size}"
  sips -z "$retina" "$retina" "$icon" \
    --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null ||
    fail "could not scale the application icon to ${retina}x${retina}"
done
iconutil --convert icns "$iconset" \
  --output "$app/Contents/Resources/novamira-hq.icns" ||
  fail "could not build the application icon"
rm -rf "$iconset"

cat >"$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Novamira HQ</string>
  <key>CFBundleExecutable</key>
  <string>novamira-hq-desktop</string>
  <key>CFBundleIconFile</key>
  <string>novamira-hq</string>
  <key>CFBundleIconName</key>
  <string>novamira-hq</string>
  <key>CFBundleIdentifier</key>
  <string>ai.novamira.hq.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Novamira HQ</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$version</string>
  <key>CFBundleVersion</key>
  <string>$version</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

cp "$binary" "$app/Contents/MacOS/novamira-hq-desktop"
native_library=$(node "$root/scripts/macos-native.mjs" "$binary" "$app")
sign "$native_library"

# The standalone executable first, then the bundle. Signing the bundle re-signs
# its own copy of the executable; the two are separate code objects and each
# needs its own Developer ID signature.
sign "$binary"
sign "$app"

# --- notarization, both artifacts in one submission -------------------------

printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode >"$api_key" ||
  fail "APPLE_API_KEY_P8_BASE64 is not valid base64"

rm -rf "$staging"
mkdir -p "$staging"
ditto "$app" "$staging/Novamira HQ.app"
cp "$binary" "$staging/$(basename "$binary")"
ditto -c -k --sequesterRsrc "$staging" "$work/notarize.zip"

notary() {
  xcrun notarytool "$@" \
    --key "$api_key" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER_ID" \
    --output-format json
}

field() {
  printf '%s' "$2" |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{process.stdout.write(String(JSON.parse(s)[process.argv[1]] ?? ""))})' "$1"
}

submission=$(notary submit "$work/notarize.zip" --wait --timeout 30m) ||
  fail "notarization could not be submitted"
status=$(field status "$submission")
if [ "$status" != "Accepted" ]; then
  # The status alone never says which binary was rejected or why; the log does,
  # and this is the one moment it can still be fetched.
  notary log "$(field id "$submission")" >&2 || true
  fail "notarization returned $status"
fi
rm -f "$api_key"

# Only the bundle can hold the ticket. The bare executable keeps the online
# notarization record and nothing more, which is exactly why the bundle exists.
xcrun stapler staple "$app" || fail "could not staple the notarization ticket"
xcrun stapler validate "$app" || fail "the stapled ticket does not validate"

spctl --assess --type execute -vv "$app" ||
  fail "Gatekeeper did not accept the stapled bundle"

# --- the release asset ------------------------------------------------------

ditto -c -k --sequesterRsrc --keepParent "$app" "$binary.app.zip"
rm -rf "$app"

printf 'Signed and notarized %s\n' "$binary"
printf 'Signed, notarized and stapled %s\n' "$binary.app.zip"
