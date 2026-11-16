#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
export PUPPETEER_SKIP_DOWNLOAD=true
command -v node >/dev/null || { echo "[ERROR] node not found in PATH" >&2; exit 1; }
command -v npm >/dev/null || { echo "[ERROR] npm not found in PATH" >&2; exit 1; }
cd "$REPO_DIR"
if [[ ! -x node_modules/.bin/tsc ]]; then
    echo "[INFO] Installing development dependencies (Puppeteer download disabled)..."
    npm install --include=dev
fi
echo "[INFO] Building local Desktop Commander fork..."
npm run build
[[ -f "$REPO_DIR/dist/index.js" ]] || { echo "[ERROR] dist/index.js missing after build" >&2; exit 1; }
echo "[INFO] Starting local fork in remote mode. Ctrl+C to stop."
exec node "$REPO_DIR/dist/index.js" remote
