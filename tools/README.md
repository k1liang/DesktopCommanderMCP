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

Tunnel init automatically runs `npm install` followed by `npm run build` from the repository root before creating the profile (and stops if either step fails). You do not need to run those commands manually before init. Tunnel init is a one-time operation; run starts the profile subsequently. Use separate Tunnel IDs on devices running simultaneously. Stop run with Ctrl+C.

Both platforms use a loopback resilient HTTP MCP proxy (`src/resilient-mcp-proxy.ts`) instead of binding Tunnel directly to Desktop Commander's stdio process. OpenAI tunnel-client intentionally rejects legacy stdio operational requests before they reach the child unless the caller already completed `initialize` + `notifications/initialized`; the local HTTP proxy owns that child lifecycle itself, so cold `tools/list` / `tools/call` requests can recover without surfacing `mcp_initialization_required` to ChatGPT. `tools/tunnel-supervisor.mjs` hosts the proxy and restarts tunnel-client after unexpected exits while keeping the initialized Desktop Commander child alive. Set `TUNNEL_SUPERVISOR_RESTART_DELAY_MS` to change the default 1500 ms restart delay, or `TUNNEL_SUPERVISOR_MAX_RESTARTS` to a positive number to cap retries (0 means unlimited). Configure `DC_RESILIENT_MCP_HOST` and `DC_RESILIENT_MCP_PORT` to adjust the loopback listener; do not expose it to the network because it has no HTTP authentication.

Large plain-text `tools/call` results are automatically paginated by the resilient proxy. The default page target is 32 KiB (`DC_RESILIENT_MCP_RESULT_PAGE_BYTES`), cursors live for 30 minutes (`DC_RESILIENT_MCP_RESULT_PAGE_TTL_MS`), and up to 64 paged results are cached (`DC_RESILIENT_MCP_RESULT_PAGE_MAX_ENTRIES`). The first page contains explicit `has_more` / `next_cursor` metadata and the proxy advertises a read-only `get_result_page` tool for continuation. Small results and non-text/structured results are returned unchanged. Search sessions are also retained for 30 minutes and tracked by the proxy: if the Desktop Commander child is replaced, a later `get_more_search_results` transparently recreates the search and keeps the caller-facing session ID stable. Override the proxy recipe TTL with `DC_RESILIENT_MCP_SEARCH_SESSION_TTL_MS`.

Every inbound MCP message receives a persistent monotonically increasing int64-style sequence number. The allocator reserves sequence blocks on disk, so a proxy restart may leave gaps but never intentionally reuses or moves the sequence backwards. Every `tools/call` INFO line includes `seq`, tool name, local proxy duration, outcome, response byte size, pagination state, concurrent active-call count, and child generation; arguments are never logged. Calls taking at least 1500 ms are also appended as JSONL to `%USERPROFILE%\.claude-server-commander\tunnel-diagnostics\stalls.jsonl` on Windows (the equivalent home-directory path on macOS/Linux), together with the previous stall sequence, message distance, arrival gap, active count, generation, and whether the delay looks like the expected 5-second process poll. If the next inbound MCP message arrives at least 10 seconds after the most recently completed tool, a `continuation_gap_candidate` event records `previous_seq -> seq`, both the raw arrival gap and the idle time after that tool completed, plus the previous/current method and tool. Because multiple ChatGPT sessions share one proxy, the supervisor also watches tunnel-client's admin log by `cmd_request_id` workflow prefix and writes `%USERPROFILE%\.claude-server-commander\tunnel-diagnostics\workflow-stalls.jsonl`: `workflow_stall_open` records a live 10-second candidate while other workflows are still issuing commands, and `workflow_stall_recovered` records the eventual next command, total gap, other-workflow traffic during the gap, and dispatcher/queue/response-delivery/control-plane health. Open events are candidates rather than proof because tunnel-client cannot know whether ChatGPT intended the turn to end. Child-generation changes and automatic search-session rehydration remain in `stalls.jsonl`. Use `DC_RESILIENT_MCP_STALL_MS`, `DC_RESILIENT_MCP_GAP_MS`, `DC_RESILIENT_MCP_DIAGNOSTICS_DIR`, `TUNNEL_WORKFLOW_STALL_MS`, `TUNNEL_WORKFLOW_MONITOR_INTERVAL_MS`, and `TUNNEL_WORKFLOW_MONITOR_DISABLE=1` to override thresholds, polling, location, or disable workflow monitoring.

Windows `tunnel-run.bat` also caps the official Tunnel dispatcher with `--mcp.max-concurrent-requests`. The local default is 8 (OpenAI tunnel-client defaults to 10): this leaves headroom for concurrent ChatGPT sessions while still limiting result bursts. Desktop Commander's resumable process waits are capped at 5 seconds per MCP call, so long-running `read_process_output` / regular `interact_with_process` polls release dispatcher capacity quickly while the underlying process keeps running. `node:local` one-shot scripts keep their explicit/session timeout because they cannot be resumed after returning. A single process keeps a 50 MiB in-memory output tail; before older complete lines leave memory they are appended to `%USERPROFILE%\.claude-server-commander\process-output-archive\process-<pid>-<start>.log` (equivalent home-directory path on macOS/Linux). `read_process_output` and `interact_with_process` surface that archive path and archival failures, so crossing the memory cap no longer silently destroys long-task evidence; retained-buffer offsets still refer only to the in-memory tail, and historical output should be read from the archive. Completed process output is retained across short-process churn with a 2048-session hard cap and a 256 MiB aggregate buffered-output cap; sessions whose output has been fully read are evicted before unread/paginating sessions. This prevents unrelated sessions from pushing a just-finished PID out of the old 100-entry completed-session cache before `read_process_output` reaches it. A Desktop Commander child-generation change still marks a separate lifecycle boundary for process-output buffers, so generation is kept in tunnel diagnostics when investigating `No session found for PID`. Override `TUNNEL_MCP_MAX_CONCURRENT_REQUESTS` in the ignored `tools/windows/tunnel.local.cmd` to A/B other values without editing the script.

On macOS, if Gatekeeper blocks a trusted binary, you can opt in to removing its quarantine flag for initialization only:

    TUNNEL_TRUST_DOWNLOADED_BINARY=1 ./tools/mac/tunnel-init.sh

Do not share the private .cmd/.sh files, and never add them to Git. The .example files contain placeholders only.
