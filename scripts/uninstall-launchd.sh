#!/usr/bin/env bash
#
# Removes the launchd service. Your data, logs and config are left untouched.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_macos

say ""
say "Miracosta Monitor — removing the background service"
say ""

launchctl bootout "${SERVICE_TARGET}" 2>/dev/null \
  || launchctl unload -w "${INSTALLED_PLIST}" 2>/dev/null \
  || true

if [ -f "${INSTALLED_PLIST}" ]; then
  rm -f "${INSTALLED_PLIST}"
  ok "Removed ${INSTALLED_PLIST}"
else
  warn "No installed plist found — it was probably already removed."
fi

rm -f "${PROJECT_DIR}/data/monitor.lock"

say ""
say "The service will no longer start at login."
say "Your history (data/), logs (logs/) and settings (config/) were kept."
say "To monitor manually again:  npm run monitor"
say ""
