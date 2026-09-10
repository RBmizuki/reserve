#!/usr/bin/env bash
# Stops the service without uninstalling it. It will start again at next login
# unless you run 'npm run uninstall-service'.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_macos

if launchctl bootout "${SERVICE_TARGET}" 2>/dev/null; then
  ok "Service stopped."
else
  warn "The service was not running."
fi
rm -f "${PROJECT_DIR}/data/monitor.lock"
say ""
say "To start it again:  npm run start-service"
say ""
