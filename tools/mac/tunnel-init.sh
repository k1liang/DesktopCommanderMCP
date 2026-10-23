#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
CONFIG="$SCRIPT_DIR/tunnel.local.sh"
[[ -f "$CONFIG" ]] || { echo "[ERROR] Missing $CONFIG (copy tunnel.local.sh.example)" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"

TUNNEL_CLIENT_REPO="${TUNNEL_CLIENT_REPO:-$REPO_DIR/../tunnel-client}"
TUNNEL_CLIENT_BIN="${TUNNEL_CLIENT_BIN:-$TUNNEL_CLIENT_REPO/bin/tunnel-client}"

: "${CONTROL_PLANE_API_KEY:?Set CONTROL_PLANE_API_KEY in tunnel.local.sh}"
: "${CONTROL_PLANE_TUNNEL_ID:?Set CONTROL_PLANE_TUNNEL_ID in tunnel.local.sh}"
[[ "$CONTROL_PLANE_API_KEY" != "PASTE_YOUR_RUNTIME_API_KEY_HERE" && "$CONTROL_PLANE_TUNNEL_ID" != "PASTE_YOUR_TUNNEL_ID_HERE" ]] || { echo "[ERROR] Replace credential placeholders in tunnel.local.sh" >&2; exit 1; }
TUNNEL_PROFILE="${TUNNEL_PROFILE:-desktop-commander}"
DC_RESILIENT_MCP_HOST="${DC_RESILIENT_MCP_HOST:-127.0.0.1}"
DC_RESILIENT_MCP_PORT="${DC_RESILIENT_MCP_PORT:-8765}"
DC_DISABLE_MCP_UI_PREVIEWS="${DC_DISABLE_MCP_UI_PREVIEWS:-1}"
[[ "$DC_RESILIENT_MCP_HOST" == "127.0.0.1" || "$DC_RESILIENT_MCP_HOST" == "localhost" ]] || { echo "[ERROR] Keep DC_RESILIENT_MCP_HOST on loopback; the local proxy has no HTTP authentication" >&2; exit 1; }

if [[ ! -f "$TUNNEL_CLIENT_BIN" && -f "$TUNNEL_CLIENT_REPO/Makefile" ]]; then
    command -v go >/dev/null || { echo "[ERROR] go not found in PATH; required to build sibling tunnel-client" >&2; exit 1; }
    command -v make >/dev/null || { echo "[ERROR] make not found in PATH; required to build sibling tunnel-client" >&2; exit 1; }
    echo "[INFO] Building full tunnel-client from sibling repo: $TUNNEL_CLIENT_REPO"
    (cd "$TUNNEL_CLIENT_REPO" && make tunnel-client)
fi
[[ -f "$TUNNEL_CLIENT_BIN" ]] || { echo "[ERROR] Full tunnel-client executable not found: $TUNNEL_CLIENT_BIN" >&2; echo "[ERROR] Expected sibling source repo at: $TUNNEL_CLIENT_REPO" >&2; exit 1; }
chmod +x "$TUNNEL_CLIENT_BIN"

# Remove Gatekeeper quarantine only after explicitly trusting the downloaded binary.
if [[ "${TUNNEL_TRUST_DOWNLOADED_BINARY:-0}" == "1" ]]; then
    xattr -d com.apple.quarantine "$TUNNEL_CLIENT_BIN" 2>/dev/null || true
fi

command -v node >/dev/null || { echo "[ERROR] node not found in PATH" >&2; exit 1; }
command -v npm >/dev/null || { echo "[ERROR] npm not found in PATH" >&2; exit 1; }
echo "[INFO] Installing Desktop Commander dependencies..."
(cd "$REPO_DIR" && npm install)
echo "[INFO] Building Desktop Commander..."
(cd "$REPO_DIR" && npm run build)

MCP_PROXY_URL="http://$DC_RESILIENT_MCP_HOST:$DC_RESILIENT_MCP_PORT/mcp"
export CONTROL_PLANE_API_KEY CONTROL_PLANE_TUNNEL_ID DC_RESILIENT_MCP_HOST DC_RESILIENT_MCP_PORT DC_DISABLE_MCP_UI_PREVIEWS

echo "[INFO] Initializing tunnel profile $TUNNEL_PROFILE for resilient HTTP MCP proxy..."
"$TUNNEL_CLIENT_BIN" init --force --sample sample_mcp_remote_no_auth --profile "$TUNNEL_PROFILE" --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" --mcp-server-url "$MCP_PROXY_URL" --health-listen-addr "127.0.0.1:0" "$@"

echo "[INFO] Running tunnel doctor through resilient MCP proxy..."
TUNNEL_RESILIENT_PROXY=1 TUNNEL_SUPERVISOR_ONESHOT=1 node "$REPO_DIR/tools/tunnel-supervisor.mjs" "$TUNNEL_CLIENT_BIN" doctor --profile "$TUNNEL_PROFILE" --explain
