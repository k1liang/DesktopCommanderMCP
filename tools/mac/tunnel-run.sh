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
TUNNEL_RUN_BIN="${TUNNEL_CLIENT_RUN_BIN:-$TUNNEL_CLIENT_BIN}"

: "${CONTROL_PLANE_API_KEY:?Set CONTROL_PLANE_API_KEY in tunnel.local.sh}"
: "${CONTROL_PLANE_TUNNEL_ID:?Set CONTROL_PLANE_TUNNEL_ID in tunnel.local.sh}"
[[ "$CONTROL_PLANE_API_KEY" != "PASTE_YOUR_RUNTIME_API_KEY_HERE" && "$CONTROL_PLANE_TUNNEL_ID" != "PASTE_YOUR_TUNNEL_ID_HERE" ]] || { echo "[ERROR] Replace credential placeholders in tunnel.local.sh" >&2; exit 1; }

if [[ ! -f "$TUNNEL_RUN_BIN" && "$TUNNEL_RUN_BIN" == "$TUNNEL_CLIENT_BIN" && -f "$TUNNEL_CLIENT_REPO/Makefile" ]]; then
    command -v go >/dev/null || { echo "[ERROR] go not found in PATH; required to build sibling tunnel-client" >&2; exit 1; }
    command -v make >/dev/null || { echo "[ERROR] make not found in PATH; required to build sibling tunnel-client" >&2; exit 1; }
    echo "[INFO] Building full tunnel-client from sibling repo: $TUNNEL_CLIENT_REPO"
    (cd "$TUNNEL_CLIENT_REPO" && make tunnel-client)
fi
[[ -f "$TUNNEL_RUN_BIN" ]] || { echo "[ERROR] Tunnel executable not found: $TUNNEL_RUN_BIN" >&2; exit 1; }
chmod +x "$TUNNEL_RUN_BIN"

if [[ "${TUNNEL_TRUST_DOWNLOADED_BINARY:-0}" == "1" ]]; then
    xattr -d com.apple.quarantine "$TUNNEL_RUN_BIN" 2>/dev/null || true
fi

TUNNEL_PROFILE="${TUNNEL_PROFILE:-desktop-commander}"
DC_RESILIENT_MCP_HOST="${DC_RESILIENT_MCP_HOST:-127.0.0.1}"
DC_RESILIENT_MCP_PORT="${DC_RESILIENT_MCP_PORT:-8765}"
DC_DISABLE_MCP_UI_PREVIEWS="${DC_DISABLE_MCP_UI_PREVIEWS:-1}"
[[ "$DC_RESILIENT_MCP_HOST" == "127.0.0.1" || "$DC_RESILIENT_MCP_HOST" == "localhost" ]] || { echo "[ERROR] Keep DC_RESILIENT_MCP_HOST on loopback; the local proxy has no HTTP authentication" >&2; exit 1; }

command -v node >/dev/null || { echo "[ERROR] node not found in PATH" >&2; exit 1; }
if [[ ! -f "$REPO_DIR/dist/resilient-mcp-proxy.js" || ! -f "$REPO_DIR/dist/index.js" ]]; then
    command -v npm >/dev/null || { echo "[ERROR] npm not found in PATH" >&2; exit 1; }
    (cd "$REPO_DIR" && npm run build)
fi

export CONTROL_PLANE_API_KEY CONTROL_PLANE_TUNNEL_ID DC_RESILIENT_MCP_HOST DC_RESILIENT_MCP_PORT DC_DISABLE_MCP_UI_PREVIEWS
export TUNNEL_RESILIENT_PROXY=1
echo "[INFO] Starting resilient HTTP MCP proxy on $DC_RESILIENT_MCP_HOST:$DC_RESILIENT_MCP_PORT..."
echo "[INFO] Starting tunnel profile $TUNNEL_PROFILE..."
exec node "$REPO_DIR/tools/tunnel-supervisor.mjs" "$TUNNEL_RUN_BIN" run --profile "$TUNNEL_PROFILE" "$@"
