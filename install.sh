#!/bin/sh
# SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
# SPDX-License-Identifier: AGPL-3.0-or-later

# Install Novamira HQ and register its agent skill.
#
# What the Go had: nothing. `novamira-hub` shipped a self-replacing binary and a
# `novamira setup` command that hand-wrote `~/.agents/skills/novamira/SKILL.md`
# and symlinked `~/.claude/skills/novamira` at it, guessing two agents' on-disk
# layouts and silently deleting a symlink whose target it did not like. Both are
# deleted. Distribution is npm-only, and skill registration is delegated to the
# third-party `skills` CLI, which knows every agent's layout and asks the user
# which one — the same approach @novamira/cli takes.
#
# This script is NOT shipped inside the npm tarball: an installer inside the
# package it installs is circular. It is consumed from the repository's raw URL
# and from the GitHub release assets.
#
# The smoke test is `novamira-hq doctor --offline --json`, and it is offline on
# purpose. A fresh machine has no hosting profiles and no site CLI, so
# `profile.credentials` and `integration.site_cli` both warn — and a produced
# doctor report is exit 0 whatever its status, which is why the installer asks
# for machine-readable output and rejects an overall `fail` itself: a `warn`
# report is a healthy install, a `fail` report is a broken one.

set -eu

package=@novamira/hq
# Pinned exactly, never a range: an installer that runs `npx skills@latest` is a
# supply-chain hole with a scheduled trigger.
skills_package=skills@1.5.18

fail() {
  printf 'novamira-hq installer: %s\n' "$*" >&2
  exit 1
}

install_macos_menu_entry() {
  if [ -w /Applications ]; then
    application_dir=/Applications
  else
    application_dir=$HOME/Applications
  fi
  app_dir=$application_dir/Novamira\ HQ.app
  executable_dir=$app_dir/Contents/MacOS
  launcher=$executable_dir/novamira-hq-dashboard

  printf '\nInstalling the Novamira HQ application launcher...\n'
  mkdir -p "$executable_dir" ||
    fail "could not create the macOS application launcher at $app_dir"

  printf '%s\n' \
    '<?xml version="1.0" encoding="UTF-8"?>' \
    '<plist version="1.0">' \
    '<dict>' \
    '  <key>CFBundleDisplayName</key>' \
    '  <string>Novamira HQ</string>' \
    '  <key>CFBundleExecutable</key>' \
    '  <string>novamira-hq-dashboard</string>' \
    '  <key>CFBundleIdentifier</key>' \
    '  <string>ai.novamira.hq.dashboard</string>' \
    '  <key>CFBundleName</key>' \
    '  <string>Novamira HQ</string>' \
    '  <key>CFBundlePackageType</key>' \
    '  <string>APPL</string>' \
    '</dict>' \
    '</plist>' >"$app_dir/Contents/Info.plist" ||
    fail "could not write the macOS application launcher metadata"

  printf '%s\n' \
    '#!/bin/sh' \
    'launcher_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)' \
    'PATH=$launcher_dir:/usr/bin:/bin:/usr/sbin:/sbin' \
    'export PATH' \
    'exec "$launcher_dir/novamira-hq" dashboard --open' >"$launcher" ||
    fail "could not write the macOS application launcher executable"
  chmod 755 "$launcher" ||
    fail "could not make the macOS application launcher executable"

  node_bin=$(node -p 'process.execPath')
  [ -x "$node_bin" ] || fail "could not resolve the Node.js executable"
  ln -sf "$node_bin" "$executable_dir/node" ||
    fail "could not link Node.js into the macOS application launcher"
  ln -sf "$novamira_hq_bin" "$executable_dir/novamira-hq" ||
    fail "could not link Novamira HQ into the macOS application launcher"

  printf 'Application launcher installed at %s\n' "$app_dir"
}

install_linux_menu_entry() {
  case ${XDG_DATA_HOME:-} in
    /*) data_home=$XDG_DATA_HOME ;;
    *) data_home=$HOME/.local/share ;;
  esac
  applications_dir=$data_home/applications
  launcher_dir=$data_home/novamira-hq
  launcher=$launcher_dir/novamira-hq-dashboard
  desktop_entry=$applications_dir/ai.novamira.hq.dashboard.desktop

  printf '\nInstalling the Novamira HQ application launcher...\n'
  mkdir -p "$applications_dir" "$launcher_dir" ||
    fail "could not create the Linux application launcher under $data_home"

  printf '%s\n' \
    '#!/bin/sh' \
    'launcher_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)' \
    'PATH=$launcher_dir:/usr/local/bin:/usr/bin:/bin' \
    'export PATH' \
    'exec "$launcher_dir/novamira-hq" dashboard --open' >"$launcher" ||
    fail "could not write the Linux application launcher executable"
  chmod 755 "$launcher" ||
    fail "could not make the Linux application launcher executable"

  node_bin=$(node -p 'process.execPath')
  [ -x "$node_bin" ] || fail "could not resolve the Node.js executable"
  ln -sf "$node_bin" "$launcher_dir/node" ||
    fail "could not link Node.js into the Linux application launcher"
  ln -sf "$novamira_hq_bin" "$launcher_dir/novamira-hq" ||
    fail "could not link Novamira HQ into the Linux application launcher"

  printf '%s\n' \
    '[Desktop Entry]' \
    'Type=Application' \
    'Name=Novamira HQ' \
    'Comment=Open the Novamira HQ dashboard' \
    "Exec=\"$launcher\"" \
    'Terminal=false' \
    'Categories=Development;WebDevelopment;' >"$desktop_entry" ||
    fail "could not write the Linux application launcher metadata"
  chmod 644 "$desktop_entry" ||
    fail "could not set the Linux application launcher permissions"

  printf 'Application launcher installed at %s\n' "$desktop_entry"
}

install_menu_entry() {
  case $(uname -s) in
    Darwin) install_macos_menu_entry ;;
    Linux) install_linux_menu_entry ;;
    *) : ;;
  esac
}

for command_name in node npm npx; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "$command_name is required but was not found in PATH"
done

node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 22 ? 0 : 1)' ||
  fail "Node.js 22 or newer is required (found $(node --version))"

printf 'Installing %s with npm...\n' "$package"
npm install --global --ignore-scripts "$package"

npm_prefix=$(npm prefix --global)
novamira_hq_bin=$npm_prefix/bin/novamira-hq
[ -x "$novamira_hq_bin" ] ||
  fail "npm installed Novamira HQ, but novamira-hq is not available in PATH (npm prefix: $npm_prefix)"

"$novamira_hq_bin" --version
doctor_report=$(mktemp) || fail "could not create the doctor report file"
trap 'rm -f "$doctor_report"' EXIT HUP INT TERM
if "$novamira_hq_bin" doctor --offline --json >"$doctor_report"; then
  doctor_status=0
else
  doctor_status=$?
fi
if [ "$doctor_status" -ne 0 ]; then
  fail "novamira-hq doctor failed with exit code $doctor_status"
fi
node -e '
  const fs = require("fs");
  const text = fs.readFileSync(process.argv[1], "utf8");
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    console.error("doctor produced no machine-readable report");
    process.exit(1);
  }
  const status = report && report.data && report.data.status;
  if (status !== "pass" && status !== "warn") {
    console.error(`doctor reported an unhealthy installation: ${status}`);
    process.exit(1);
  }
' "$doctor_report" ||
  fail "doctor reported an unhealthy installation"
rm -f "$doctor_report"
trap - EXIT HUP INT TERM
install_menu_entry

skill_source=$(npm root --global)/@novamira/hq
[ -f "$skill_source/skills/novamira-hq/SKILL.md" ] ||
  fail "the installed npm package does not contain the Novamira HQ agent skill"

printf '\nInstalling the Novamira HQ agent skill globally...\n'
# NOVAMIRA_HQ_AGENT first, NOVAMIRA_AGENT as a fallback, so someone installing
# both tools sets one variable rather than two.
agent=${NOVAMIRA_HQ_AGENT:-${NOVAMIRA_AGENT:-}}
if [ -n "$agent" ]; then
  DISABLE_TELEMETRY=1 npm_config_ignore_scripts=true \
    npx --yes "$skills_package" add "$skill_source" \
    --skill novamira-hq --global --agent "$agent" --yes </dev/null
elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
  DISABLE_TELEMETRY=1 npm_config_ignore_scripts=true \
    npx --yes "$skills_package" add "$skill_source" \
    --skill novamira-hq --global </dev/tty
else
  fail "skill installation needs a terminal or NOVAMIRA_HQ_AGENT (for example, NOVAMIRA_HQ_AGENT=opencode)"
fi

printf '\nNovamira HQ and its agent skill installed successfully.\n'

# The site CLI ships alongside HQ so connected-state detection and the
# dashboard's Connect action work on a fresh machine rather than after a second
# thing the user has to be told about. It is a *separate global package*, never
# a dependency of @novamira/hq — the boundary is unchanged, and so is the
# runtime rule that hosting inventory, provider actions, provisioning and
# plugin-installed status all work with `novamira` absent.
#
# Which is exactly why a failure here is reported and not fatal. HQ is already
# installed and smoke-tested by this point; a registry hiccup on an optional
# integration must not turn a working HQ install into a nonzero exit. The
# executable is installed, never invoked: HQ smoke-tests HQ.
site_package=@novamira/cli
if [ -n "${NOVAMIRA_HQ_SKIP_SITE_CLI:-}" ]; then
  printf '\nSkipping the site CLI (NOVAMIRA_HQ_SKIP_SITE_CLI is set).\n'
  printf 'Install it later with: npm install -g %s\n' "$site_package"
else
  printf '\nInstalling the site CLI for connected-state detection...\n'
  printf 'Novamira CLI is an independent component and remains installed if you remove Novamira HQ.\n'
  printf 'Optional removal later: npm uninstall -g @novamira/cli\n'
  printf 'This does not remove WordPress plugins or guarantee cleanup of saved profiles and credentials. See HQ Settings > Uninstalling.\n'
  if npm install --global --ignore-scripts "$site_package"; then
    printf '\nThe site CLI is installed. Connect a provisioned site with:\n'
    printf '  novamira auth login <url>\n'
  else
    printf '\nThe site CLI could not be installed. Novamira HQ is unaffected:\n' >&2
    printf 'only the connected-state detection and Connect action need it.\n' >&2
    printf 'Retry with: npm install -g %s\n' "$site_package" >&2
  fi
fi
