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
# The smoke test is `novamira-hq doctor --offline`, and it is offline on purpose.
# A fresh machine has no hosting profiles and no site CLI, so `profile.credentials`
# and `integration.site_cli` both warn — and a produced doctor report is exit 0
# whatever its status, which is what makes it usable here.

set -eu

package=@novamira/hq
# Pinned exactly, never a range: an installer that runs `npx skills@latest` is a
# supply-chain hole with a scheduled trigger.
skills_package=skills@1.5.18

fail() {
  printf 'novamira-hq installer: %s\n' "$*" >&2
  exit 1
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
"$novamira_hq_bin" doctor --offline

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
    --skill novamira-hq --global --agent "$agent" --yes
elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
  DISABLE_TELEMETRY=1 npm_config_ignore_scripts=true \
    npx --yes "$skills_package" add "$skill_source" \
    --skill novamira-hq --global </dev/tty
else
  fail "skill installation needs a terminal or NOVAMIRA_HQ_AGENT (for example, NOVAMIRA_HQ_AGENT=opencode)"
fi

printf '\nNovamira HQ and its agent skill installed successfully.\n'
printf 'Optional: install the site CLI for connected-state detection —\n'
printf '  npm install -g @novamira/cli\n'
