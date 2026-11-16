#!/usr/bin/env bash
set -euo pipefail
command -v npx >/dev/null || { echo "[ERROR] npx not found in PATH" >&2; exit 1; }
exec npx @wonderwhy-er/desktop-commander@latest remote --logout
