#!/bin/sh
# SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
cat <<'GUIDANCE'
Novamira HQ is distributed as a desktop application.
Download the release for your platform:
https://github.com/use-novamira/novamira-hq/releases

macOS: open the DMG and move Novamira HQ.app to Applications.
Windows: save the portable .exe in a permanent user-owned location and open it.
Linux: extract the .tar.gz to a permanent user-owned location and run novamira-hq-desktop.

Open Configure AI to connect your AI client through MCP. No skills are required.
MCP works with the window closed. No Node, npm, or Deno is required.
Use Sites in the app to connect a site.
GUIDANCE
