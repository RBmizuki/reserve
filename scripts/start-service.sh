#!/usr/bin/env bash
# Starts the already-installed launchd service.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_macos
require_installed

launchctl bootstrap "${DOMAIN}" "${INSTALLED_PLIST}" 2>/dev/null || true
launchctl enable "${SERVICE_TARGET}" 2>/dev/null || true
launchctl kickstart -k "${SERVICE_TARGET}" 2>/dev/null \
  || die "Could not start the service. Try: npm run install-service"

say ""
ok "Service started."
say "Check it with:  npm run status"
say ""
