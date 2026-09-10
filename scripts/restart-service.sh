#!/usr/bin/env bash
# Restarts the service. Use this after editing config/watch.json or .env,
# and to resume monitoring after a CAPTCHA suspension.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_macos
require_installed

cd "${PROJECT_DIR}"
say ""
say "Rebuilding and restarting..."
npm run build --silent || die "Build failed — the old version is still running."

launchctl kickstart -k "${SERVICE_TARGET}" 2>/dev/null || {
  launchctl bootout "${SERVICE_TARGET}" 2>/dev/null || true
  launchctl bootstrap "${DOMAIN}" "${INSTALLED_PLIST}" \
    || die "Could not restart. Try: npm run install-service"
}
ok "Service restarted."
say "Check it with:  npm run status"
say ""
