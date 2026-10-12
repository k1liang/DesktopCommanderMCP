#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
CONFIG="$SCRIPT_DIR/tunnel.local.sh"
[[ -f "$CONFIG" ]] || { echo "[ERROR] Missing $CONFIG (copy tunnel.local.sh.example)" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
: "${CONTROL_PLANE_API_KEY:?Set CONTROL_PLANE_API_KEY in tunnel.local.sh}"
: "${CONTROL_PLANE_TUNNEL_ID:?Set CONTROL_PLANE_TUNNEL_ID in tunnel.local.sh}"
: "${TUNNEL_CLIENT_BIN:?Set TUNNEL_CLIENT_BIN in tunnel.local.sh}"
[[ "$CONTROL_PLANE_API_KEY" != "PASTE_YOUR_RUNTIME_API_KEY_HERE" && "$CONTROL_PLANE_TUNNEL_ID" != "PASTE_YOUR_TUNNEL_ID_HERE" ]] || { echo "[ERROR] Replace credential placeholders in tunnel.local.sh" >&2; exit 1; }
TUNNEL_PROFILE="${TUNNEL_PROFILE:-desktop-commander}"
[[ -f "$TUNNEL_CLIENT_BIN" ]] || { echo "[ERROR] Full tunnel-client executable not found: $TUNNEL_CLIENT_BIN" >&2; exit 1; }

echo "[INFO] Fix tunnel-client permission..."
chmod +x "$TUNNEL_CLIENT_BIN"

echo "[INFO] Remove macOS quarantine flag..."
xattr -d com.apple.quarantine "$TUNNEL_CLIENT_BIN" 2>/dev/null || true

# Gatekeeper: after verifying the download, optionally remove quarantine by running:
# TUNNEL_TRUST_DOWNLOADED_BINARY=1 ./tunnel-init.sh
if [[ "${TUNNEL_TRUST_DOWNLOADED_BINARY:-0}" == "1" ]]; then
    xattr -d com.apple.quarantine "$TUNNEL_CLIENT_BIN" 2>/dev/null || true
fi
command -v node >/dev/null || { echo "[ERROR] node not found in PATH" >&2; exit 1; }
[[ -f "$REPO_DIR/dist/index.js" ]] || { echo "[ERROR] dist/index.js missing; run npm install and npm run build from repository root" >&2; exit 1; }
export CONTROL_PLANE_API_KEY CONTROL_PLANE_TUNNEL_ID
echo "[INFO] Initializing tunnel profile $TUNNEL_PROFILE ..."
"$TUNNEL_CLIENT_BIN" init --sample sample_mcp_stdio_local --profile "$TUNNEL_PROFILE" --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" --mcp-command "node \"$REPO_DIR/dist/index.js\"" "$@"
echo "[INFO] Checking profile..."
"$TUNNEL_CLIENT_BIN" doctor --profile "$TUNNEL_PROFILE" --explain
