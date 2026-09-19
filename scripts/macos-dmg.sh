#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
# SPDX-License-Identifier: AGPL-3.0-or-later

# Package an already signed and stapled app. Signing/notarizing the resulting
# image belongs to macos-sign.sh; this script needs no signing credentials.
set -euo pipefail
[ "$(uname -s)" = Darwin ] || exit 1
[ "$#" -eq 2 ] || { printf 'usage: macos-dmg.sh <app> <output.dmg>\n' >&2; exit 1; }
app=$1
output=$2
[ -d "$app/Contents" ] || exit 1
[ ! -e "$output" ] || { printf 'Refusing to overwrite %s\n' "$output" >&2; exit 1; }
root=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/novamira-dmg.XXXXXX")
mounted=
cleanup() {
  if [ -n "$mounted" ]; then hdiutil detach "$work/mount" -force >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/source/.background" "$work/mount"
ditto "$app" "$work/source/Novamira HQ.app"
ln -s /Applications "$work/source/Applications"
swift "$root/scripts/macos/dmg-background.swift" "$work/source/.background/install.png"
hdiutil create -quiet -fs HFS+ -format UDRW -volname "Novamira HQ" \
  -srcfolder "$work/source" "$work/writable.dmg"
hdiutil attach -quiet -nobrowse -noautoopen -mountpoint "$work/mount" "$work/writable.dmg"
mounted=yes
# Finder writes .DS_Store in the image, not inside the signed application.
osascript "$root/scripts/macos/dmg-layout.applescript" "$work/mount"
sync
hdiutil detach -quiet "$work/mount"
mounted=
hdiutil convert -quiet "$work/writable.dmg" -format UDZO -imagekey zlib-level=9 -o "$output"
hdiutil verify "$output"
