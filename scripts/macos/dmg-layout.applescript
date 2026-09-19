-- SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
-- SPDX-License-Identifier: AGPL-3.0-or-later

on run argv
  set mountFolder to POSIX file (item 1 of argv) as alias
  tell application "Finder"
    tell folder mountFolder
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set bounds of container window to {120, 120, 840, 620}
      set viewOptions to icon view options of container window
      set arrangement of viewOptions to not arranged
      set icon size of viewOptions to 112
      set text size of viewOptions to 14
      set background picture of viewOptions to file ".background:install.png"
      set position of item "Novamira HQ.app" to {190, 290}
      set position of item "Applications" to {530, 290}
      update without registering applications
      delay 2
      close
    end tell
  end tell
end run
