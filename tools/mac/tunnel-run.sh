#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/tunnel.local.sh"
[[ -f "$CONFIG" ]] || { echo "[ERROR] Missing $CONFIG (copy tunnel.local.sh.example)" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"
: "${CONTROL_PLANE_API_KEY:?Set CONTROL_PLANE_API_KEY in tunnel.local.sh}"
: "${CONTROL_PLANE_TUNNEL_ID:?Set CONTROL_PLANE_TUNNEL_ID in tunnel.local.sh}"
TUNNEL_RUN_BIN="${TUNNEL_CLIENT_RUN_BIN:-${TUNNEL_CLIENT_BIN:-}}"
[[ -n "$TUNNEL_RUN_BIN" ]] || { echo "[ERROR] Set TUNNEL_CLIENT_BIN or TUNNEL_CLIENT_RUN_BIN in tunnel.local.sh" >&2; exit 1; }
[[ "$CONTROL_PLANE_API_KEY" != "PASTE_YOUR_RUNTIME_API_KEY_HERE" && "$CONTROL_PLANE_TUNNEL_ID" != "PASTE_YOUR_TUNNEL_ID_HERE" ]] || { echo "[ERROR] Replace credential placeholders in tunnel.local.sh" >&2; exit 1; }
[[ -f "$TUNNEL_RUN_BIN" ]] || { echo "[ERROR] Tunnel executable not found: $TUNNEL_RUN_BIN" >&2; exit 1; }

echo "[INFO] Fix tunnel-client permission..."
chmod +x "$TUNNEL_RUN_BIN"

echo "[INFO] Remove macOS quarantine flag..."
xattr -d com.apple.quarantine "$TUNNEL_RUN_BIN" 2>/dev/null || true

export CONTROL_PLANE_API_KEY CONTROL_PLANE_TUNNEL_ID
TUNNEL_PROFILE="${TUNNEL_PROFILE:-desktop-commander}"
echo "[INFO] Starting tunnel profile $TUNNEL_PROFILE ..."
exec "$TUNNEL_RUN_BIN" run --profile "$TUNNEL_PROFILE" "$@"
