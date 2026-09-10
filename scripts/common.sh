#!/usr/bin/env bash
# Shared helpers for the service scripts. Sourced, not executed.

set -euo pipefail

LABEL="com.mizuki.miracosta-monitor"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_NAME="${LABEL}.plist"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
INSTALLED_PLIST="${LAUNCH_AGENTS_DIR}/${PLIST_NAME}"
DOMAIN="gui/$(id -u)"
SERVICE_TARGET="${DOMAIN}/${LABEL}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*"; }
die()  { printf '\n❌ %s\n\n' "$*" >&2; exit 1; }

require_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    die "This command only works on macOS (launchd). Your system is: $(uname -s)

On another system, run the monitor in the foreground instead:
  npm run monitor"
  fi
}

require_installed() {
  [ -f "${INSTALLED_PLIST}" ] || die "The service is not installed yet.

Install it first:
  npm run install-service"
}
