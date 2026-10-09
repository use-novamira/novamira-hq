# SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
# SPDX-License-Identifier: AGPL-3.0-or-later
$ErrorActionPreference = 'Stop'
Write-Output @'
Novamira HQ is distributed as a desktop application.
Download the Windows installer (novamira-hq-setup-windows-x86_64.exe):
https://github.com/use-novamira/novamira-hq/releases

Run it. It installs for your user account, without administrator rights.
Open Configure AI to connect your AI client through MCP. No skills are required.
MCP works with the window closed. No Node, npm, or Deno is required.
Use Sites in the app to connect a site.
'@
