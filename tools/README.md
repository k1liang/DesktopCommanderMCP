# Local platform tools

Scripts for launching the local Desktop Commander fork and OpenAI Tunnel.

## Layout

| Windows | Mac | Purpose |
| --- | --- | --- |
| windows/start-remote-local.bat | mac/start-remote-local.sh | Build and launch the local fork in remote mode |
| windows/logout.bat | mac/logout.sh | Log out of Remote Desktop Commander |
| windows/tunnel-init.bat | mac/tunnel-init.sh | Initialize Tunnel profile pointing to this repository's dist/index.js |
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

The Tunnel init scripts point to the built MCP server at repository-root/dist/index.js. Clone and build this repository on each platform before initializing Tunnel.

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

On macOS, if Gatekeeper blocks a trusted binary, you can opt in to removing its quarantine flag for initialization only:

    TUNNEL_TRUST_DOWNLOADED_BINARY=1 ./tools/mac/tunnel-init.sh

Do not share the private .cmd/.sh files, and never add them to Git. The .example files contain placeholders only.
