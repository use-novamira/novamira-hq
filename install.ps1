# SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
# SPDX-License-Identifier: AGPL-3.0-or-later

# Install Novamira HQ and register its agent skill, on Windows.
#
# The PowerShell twin of install.sh; see that file's header for why the Go's
# self-replacing binary and hand-written agent stub are deleted rather than
# ported. Two Windows-specific differences: npm's global bin is a `.cmd` shim,
# not a `bin/` entry, and the two environment variables the `skills` CLI needs
# are set and restored around the call rather than passed as a command prefix.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$package = "@novamira/hq"
# Pinned exactly, never a range. See install.sh.
$skillsPackage = "skills@1.5.18"

function Fail([string] $Message) {
  throw "novamira-hq installer: $Message"
}

function Resolve-Application([string] $Name) {
  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $command) {
    Fail "$Name is required but was not found in PATH"
  }
  return $command.Source
}

function Invoke-Checked([string] $Command, [string[]] $Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "$Command failed with exit code $LASTEXITCODE"
  }
}

function Install-WindowsMenuEntry([string] $NodePath, [string] $HqEntryPoint) {
  $programsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
  if ([string]::IsNullOrWhiteSpace($programsDirectory)) {
    Fail "could not resolve the current user's Start Menu programs directory"
  }
  $shortcutPath = Join-Path $programsDirectory "Novamira HQ.lnk"

  Write-Output "`nInstalling the Novamira HQ application launcher..."
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $NodePath
    $shortcut.Arguments = "`"$HqEntryPoint`" dashboard --open"
    $shortcut.WorkingDirectory = Split-Path -Parent $HqEntryPoint
    $shortcut.Description = "Open the Novamira HQ dashboard"
    $shortcut.WindowStyle = 7
    $shortcut.Save()
  } catch {
    Fail "could not install the Windows application launcher at ${shortcutPath}: $($_.Exception.Message)"
  }

  Write-Output "Application launcher installed at $shortcutPath"
}

$node = Resolve-Application "node"
$npm = Resolve-Application "npm"
$npx = Resolve-Application "npx"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  Fail "the PowerShell installer supports Windows only; use install.sh on macOS or Linux"
}

$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)' -or [int] $Matches[1] -lt 22) {
  Fail "Node.js 22 or newer is required (found $nodeVersion)"
}

Write-Output "Installing $package with npm..."
Invoke-Checked $npm @("install", "--global", "--ignore-scripts", $package)

$npmPrefix = & $npm prefix --global
if ($LASTEXITCODE -ne 0) {
  Fail "npm prefix --global failed with exit code $LASTEXITCODE"
}
$npmPrefix = ([string] $npmPrefix).Trim()
$novamiraHqBin = Join-Path $npmPrefix "novamira-hq.cmd"
if (-not (Test-Path -LiteralPath $novamiraHqBin -PathType Leaf)) {
  Fail "npm installed Novamira HQ, but novamira-hq is not available in PATH (npm prefix: $npmPrefix)"
}

Invoke-Checked $novamiraHqBin @("--version")
$doctorOutput = & $novamiraHqBin @("doctor", "--offline", "--json")
if ($LASTEXITCODE -ne 0) {
  Fail "novamira-hq doctor failed with exit code $LASTEXITCODE"
}
$doctorJson = $doctorOutput | Out-String
$doctorReport = ConvertFrom-Json $doctorJson
if ($null -eq $doctorReport.data) {
  Fail "novamira-hq doctor produced no machine-readable report"
}
if ($doctorReport.data.status -ne "pass" -and $doctorReport.data.status -ne "warn") {
  Fail "doctor reported an unhealthy installation: $($doctorReport.data.status)"
}

$npmRoot = & $npm root --global
if ($LASTEXITCODE -ne 0) {
  Fail "npm root --global failed with exit code $LASTEXITCODE"
}
$npmRoot = ([string] $npmRoot).Trim()
$skillSource = Join-Path $npmRoot "@novamira/hq"
$skillFile = Join-Path $skillSource "skills/novamira-hq/SKILL.md"
if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) {
  Fail "the installed npm package does not contain the Novamira HQ agent skill"
}
$hqEntryPoint = Join-Path $skillSource "dist/index.js"
if (-not (Test-Path -LiteralPath $hqEntryPoint -PathType Leaf)) {
  Fail "the installed npm package does not contain the Novamira HQ entry point"
}
Install-WindowsMenuEntry $node $hqEntryPoint

Write-Output "`nInstalling the Novamira HQ agent skill globally..."
# NOVAMIRA_HQ_AGENT first, NOVAMIRA_AGENT as a fallback, so someone installing
# both tools sets one variable rather than two.
$agent = [Environment]::GetEnvironmentVariable("NOVAMIRA_HQ_AGENT")
if ([string]::IsNullOrWhiteSpace($agent)) {
  $agent = [Environment]::GetEnvironmentVariable("NOVAMIRA_AGENT")
}
$oldDisableTelemetry = [Environment]::GetEnvironmentVariable("DISABLE_TELEMETRY")
$oldIgnoreScripts = [Environment]::GetEnvironmentVariable("npm_config_ignore_scripts")
try {
  [Environment]::SetEnvironmentVariable("DISABLE_TELEMETRY", "1")
  [Environment]::SetEnvironmentVariable("npm_config_ignore_scripts", "true")
  $skillArguments = @("--yes", $skillsPackage, "add", $skillSource, "--skill", "novamira-hq", "--global")
  if (-not [string]::IsNullOrWhiteSpace($agent)) {
    $skillArguments += @("--agent", $agent, "--yes")
  } elseif ([Console]::IsInputRedirected) {
    Fail "skill installation needs a terminal or NOVAMIRA_HQ_AGENT (for example, NOVAMIRA_HQ_AGENT=opencode)"
  }
  Invoke-Checked $npx $skillArguments
} finally {
  [Environment]::SetEnvironmentVariable("DISABLE_TELEMETRY", $oldDisableTelemetry)
  [Environment]::SetEnvironmentVariable("npm_config_ignore_scripts", $oldIgnoreScripts)
}

Write-Output "`nNovamira HQ and its agent skill installed successfully."

# The site CLI is installed by default; see install.sh for why it is a separate
# global package rather than a dependency, and why a failure here is reported
# and not fatal. `Invoke-Checked` is deliberately not used: this is the one step
# whose failure must not fail the script. The try/catch pairs with the
# $LASTEXITCODE test because PowerShell 7.4+ throws on a nonzero native exit
# under $ErrorActionPreference = "Stop", while older hosts only set the code.
$sitePackage = "@novamira/cli"
$skipSiteCli = [Environment]::GetEnvironmentVariable("NOVAMIRA_HQ_SKIP_SITE_CLI")
if (-not [string]::IsNullOrWhiteSpace($skipSiteCli)) {
  Write-Output "`nSkipping the site CLI (NOVAMIRA_HQ_SKIP_SITE_CLI is set)."
  Write-Output "Install it later with: npm install -g $sitePackage"
} else {
  Write-Output "`nInstalling the site CLI for connected-state detection..."
  $siteCliInstalled = $false
  try {
    & $npm @("install", "--global", "--ignore-scripts", $sitePackage)
    $siteCliInstalled = ($LASTEXITCODE -eq 0)
  } catch {
    $siteCliInstalled = $false
  }
  if ($siteCliInstalled) {
    Write-Output "`nThe site CLI is installed. Connect a provisioned site with:"
    Write-Output "  novamira auth login <url>"
  } else {
    Write-Warning "The site CLI could not be installed. Novamira HQ is unaffected:"
    Write-Warning "only the connected-state detection and Connect action need it."
    Write-Warning "Retry with: npm install -g $sitePackage"
  }
}
