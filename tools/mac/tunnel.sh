#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-}" in
    init)
        shift
        exec "$SCRIPT_DIR/tunnel-init.sh" "$@"
        ;;
    run)
        shift
        exec "$SCRIPT_DIR/tunnel-run.sh" "$@"
        ;;
    *)
        echo "Usage: $0 {init|run} [tunnel-client args...]" >&2
        echo "  $0 init   # one-time profile initialization/build" >&2
        echo "  $0 run    # start Desktop Commander + Tunnel" >&2
        exit 2
        ;;
esac
