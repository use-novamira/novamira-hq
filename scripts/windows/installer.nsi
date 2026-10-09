; SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
; SPDX-License-Identifier: AGPL-3.0-or-later
;
; Per-user installer: a stable path keeps AI client configurations valid
; across updates, which replace the files in place.

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!ifndef VERSION
  !error "Pass /DVERSION=<version>"
!endif
!ifndef STAGE
  !error "Pass /DSTAGE=<staging directory>"
!endif
!ifndef OUTFILE
  !error "Pass /DOUTFILE=<installer path>"
!endif

!include "MUI2.nsh"

!define APP "Novamira HQ"
!define EXE "novamira-hq-desktop.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NovamiraHQ"

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"

; Code signing goes here (!finalize and !uninstfinalize) once a certificate exists.

!define MUI_ICON "${STAGE}\novamira-hq.ico"
!define MUI_UNICON "${STAGE}\novamira-hq.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSE"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; HQ windows, servers, MCP processes and the command launcher lock their
; executables. The uninstaller itself runs from $INSTDIR when given _?=.
!macro StopRunning
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-Process | Where-Object { $$_.Path -and $$_.Name -ne 'Uninstall' -and ($$_.Path.StartsWith('$INSTDIR\', [StringComparison]::OrdinalIgnoreCase) -or $$_.Path.StartsWith('$LOCALAPPDATA\Novamira HQ\State\command\', [StringComparison]::OrdinalIgnoreCase)) } | Stop-Process -Force"`
  Pop $0
!macroend

Section "Install"
  !insertmacro StopRunning
  SetOutPath "$INSTDIR"
  File "${STAGE}\novamira-hq-desktop.exe"
  File "${STAGE}\LICENSE"
  File "${STAGE}\SOURCE-OFFER.txt"
  File "${STAGE}\LGPL-2.1.txt"
  File "${STAGE}\THIRD-PARTY-NOTICES.txt"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Ovation S.r.l."
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

; Settings, state and credentials stay, as the Settings uninstall help says.
Section "Uninstall"
  !insertmacro StopRunning
  Delete "$INSTDIR\novamira-hq-desktop.exe"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\SOURCE-OFFER.txt"
  Delete "$INSTDIR\LGPL-2.1.txt"
  Delete "$INSTDIR\THIRD-PARTY-NOTICES.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APP}.lnk"
  RMDir /r "$LOCALAPPDATA\Novamira HQ\State\command"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
