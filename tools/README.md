# Local platform tools

Scripts for launching the local Desktop Commander fork and OpenAI Tunnel.

## Layout

| Windows | Mac | Purpose |
| --- | --- | --- |
| windows/start-remote-local.bat | mac/start-remote-local.sh | Build and launch the local fork in remote mode |
| windows/logout.bat | mac/logout.sh | Log out of Remote Desktop Commander |
| windows/tunnel-init.bat | mac/tunnel-init.sh | Initialize Tunnel profile pointing to the local resilient HTTP MCP proxy |
| windows/tunnel-run.bat | mac/tunnel-run.sh | Start Tunnel from saved profile |
| windows/tunnel.local.cmd.example | mac/tunnel.local.sh.example | Tracked local configuration templates |

## Private configuration

Copy the platform-specific template and edit it. The copied files are gitignored and MUST NOT be committed.

Windows (from repository root):

    copy tools\windows\tunnel.local.cmd.example tools\windows\tunnel.local.cmd

macOS (from repository root):

    cp tools/mac/tunnel.local.sh.example tools/mac/tunnel.local.sh
    chmod +x tools/mac/*.sh

Set your runtime API key, Tunnel ID, and **executable path** (TUNNEL_CLIENT_BIN) in the private file. Windows' currently configured credentials have already been migrated into the ignored tools/windows/tunnel.local.cmd on the local development machine.

macOS special case: the v0.0.16 tunnel-client-runtime-cloudflared executable is run-only. Tunnel init requires the full macOS tunnel-client binary. Configure TUNNEL_CLIENT_BIN for init; the optional TUNNEL_CLIENT_RUN_BIN can point to the runtime-cloudflared binary. Do not assume that the runtime binary supports init.

On Windows and macOS, Tunnel init points OpenAI Tunnel at a loopback HTTP MCP endpoint served by `dist/resilient-mcp-proxy.js`. The proxy owns the long-lived stdio child (`dist/index.js`), performs the legacy `initialize` → `notifications/initialized` handshake itself, and can recreate that child without exposing transient initialization failures to Tunnel. Use the full tunnel-client CLI for init; on macOS, the optional run-only runtime-cloudflared binary can still run the resulting HTTP profile.

## Commands

Windows:

    tools\windows\start-remote-local.bat
    tools\windows\logout.bat
    tools\windows\tunnel-init.bat
    tools\windows\tunnel-run.bat

macOS:

    ./tools/mac/start-remote-local.sh
    ./tools/mac/logout.sh
    ./tools/mac/tunnel-init.sh
    ./tools/mac/tunnel-run.sh

Tunnel init is a one-time operation; run starts the profile subsequently. Use separate Tunnel IDs on devices running simultaneously. Stop run with Ctrl+C.

Both platforms use a loopback resilient HTTP MCP proxy (`src/resilient-mcp-proxy.ts`) instead of binding Tunnel directly to Desktop Commander's stdio process. OpenAI tunnel-client intentionally rejects legacy stdio operational requests before they reach the child unless the caller already completed `initialize` + `notifications/initialized`; the local HTTP proxy owns that child lifecycle itself, so cold `tools/list` / `tools/call` requests can recover without surfacing `mcp_initialization_required` to ChatGPT. `tools/tunnel-supervisor.mjs` hosts the proxy and restarts tunnel-client after unexpected exits while keeping the initialized Desktop Commander child alive. Set `TUNNEL_SUPERVISOR_RESTART_DELAY_MS` to change the default 1500 ms restart delay, or `TUNNEL_SUPERVISOR_MAX_RESTARTS` to a positive number to cap retries (0 means unlimited). Configure `DC_RESILIENT_MCP_HOST` and `DC_RESILIENT_MCP_PORT` to adjust the loopback listener; do not expose it to the network because it has no HTTP authentication.

On macOS, if Gatekeeper blocks a trusted binary, you can opt in to removing its quarantine flag for initialization only:

    TUNNEL_TRUST_DOWNLOADED_BINARY=1 ./tools/mac/tunnel-init.sh

Do not share the private .cmd/.sh files, and never add them to Git. The .example files contain placeholders only.
