#!/usr/bin/env bash
#
# Registers the monitor as a macOS launchd user agent, so it starts at login
# (and therefore after a reboot) and restarts if it ever crashes.
#
# No secrets are written into the plist: the LINE token stays in .env.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_macos

say ""
say "Miracosta Monitor — installing the background service"
say ""

# --- 1. Find the real Node.js binary ----------------------------------------
# launchd starts with a minimal PATH, so "node" alone is not enough. Asking
# Node itself for process.execPath resolves nvm shims and Homebrew symlinks to
# the actual binary.
say "1) Locating Node.js"
command -v node >/dev/null 2>&1 || die "Node.js is not on your PATH.

Install it with:
  brew install node"

NODE_PATH="$(node -e 'process.stdout.write(process.execPath)')"
[ -x "${NODE_PATH}" ] || die "Could not resolve a usable Node.js binary (got: ${NODE_PATH})"
ok "Node.js $(node -v) at ${NODE_PATH}"

case "${NODE_PATH}" in
  *"/.nvm/"*)
    warn "This Node.js comes from nvm."
    warn "If you later uninstall this Node version, the service will stop working."
    warn "Re-run 'npm run install-service' after any Node upgrade."
    warn "A Homebrew install (brew install node) is more stable for a background service."
    ;;
esac

# launchd needs an explicit PATH; include the Node bin dir plus the usual places.
NODE_BIN_DIR="$(dirname "${NODE_PATH}")"
PATH_VALUE="${NODE_BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ok "Service PATH: ${PATH_VALUE}"

# --- 2. Pre-flight ----------------------------------------------------------
say ""
say "2) Checking the project"
cd "${PROJECT_DIR}"
[ -d node_modules ] || die "Dependencies are not installed. Run:
  npm install"

if [ ! -f "${PROJECT_DIR}/.env" ]; then
  warn "There is no .env file — LINE notifications will not be sent."
  warn "Create it with:  cp .env.example .env   (then fill in the two values)"
fi
if [ ! -f "${PROJECT_DIR}/config/watch.json" ]; then
  warn "config/watch.json is missing; creating it from the example."
  cp "${PROJECT_DIR}/config/watch.example.json" "${PROJECT_DIR}/config/watch.json"
fi

say "   Building the TypeScript sources..."
npm run build --silent || die "The build failed. Fix the errors above, then run this again."
[ -f "${PROJECT_DIR}/dist/index.js" ] || die "Build finished but dist/index.js is missing."
ok "Built dist/index.js"

mkdir -p "${PROJECT_DIR}/logs" "${PROJECT_DIR}/data" "${PROJECT_DIR}/debug"

# --- 3. Generate the plist --------------------------------------------------
say ""
say "3) Writing the launchd configuration"
TEMPLATE="${PROJECT_DIR}/launchd/${PLIST_NAME}.template"
[ -f "${TEMPLATE}" ] || die "Missing template: ${TEMPLATE}"

mkdir -p "${LAUNCH_AGENTS_DIR}"
GENERATED="${PROJECT_DIR}/launchd/${PLIST_NAME}"

# Use a Python one-liner rather than sed so that paths containing slashes,
# spaces or ampersands are substituted literally.
NODE_PATH="${NODE_PATH}" PROJECT_DIR="${PROJECT_DIR}" PATH_VALUE="${PATH_VALUE}" LABEL="${LABEL}" \
python3 - "${TEMPLATE}" "${GENERATED}" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding='utf-8').read()
for key in ('NODE_PATH', 'PROJECT_DIR', 'PATH_VALUE', 'LABEL'):
    text = text.replace(f'__{key}__', os.environ[key])
open(dst, 'w', encoding='utf-8').write(text)
PY

plutil -lint "${GENERATED}" >/dev/null || die "The generated plist is not valid: ${GENERATED}"
cp "${GENERATED}" "${INSTALLED_PLIST}"
chmod 644 "${INSTALLED_PLIST}"
ok "Installed ${INSTALLED_PLIST}"

# --- 4. Load it -------------------------------------------------------------
say ""
say "4) Starting the service"
# Remove any previous registration first, so re-running this is always safe.
launchctl bootout "${SERVICE_TARGET}" 2>/dev/null || true

if ! launchctl bootstrap "${DOMAIN}" "${INSTALLED_PLIST}" 2>/dev/null; then
  # Older macOS releases only understand the legacy verbs.
  launchctl load -w "${INSTALLED_PLIST}" || die "launchctl could not load the service."
fi
launchctl enable "${SERVICE_TARGET}" 2>/dev/null || true
launchctl kickstart -k "${SERVICE_TARGET}" 2>/dev/null || true
ok "Service registered and started"

say ""
say "Done. What happens now:"
say "  • The monitor is running in the background right now."
say "  • It starts again automatically every time you log in to this Mac."
say "  • If it crashes, launchd restarts it after 30 seconds."
say ""
say "Useful commands:"
say "  npm run status           # is it running, and what does it see?"
say "  npm run history          # recent checks"
say "  tail -f logs/monitor.log # watch it work, live"
say "  npm run stop-service     # stop it"
say ""
say "Note: while this Mac is asleep, nothing is checked. See README section"
say "'Mac のスリープについて' for how to handle that."
say ""
