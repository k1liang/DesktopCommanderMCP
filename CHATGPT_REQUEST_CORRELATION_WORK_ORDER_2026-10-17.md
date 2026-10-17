# ChatGPT request correlation / MCP lifecycle work order — 2026-10-17

## Goal

Expose a narrow, transport-neutral lifecycle feed from DesktopCommanderMCP / resilient MCP proxy so gaifan can correlate ChatGPT provider turns with concrete MCP activity without teaching the tunnel anything about ChatGPT.

The tunnel side MUST NOT decide whether a ChatGPT turn is "stalled". Its authority is only MCP request/tool lifecycle facts.

## Background

Current gaifan autoresume can identify the origin conversation, but reading a large ChatGPT conversation via `/backend-api/conversation/<id>` is rate-limited (HTTP 429) and is not a reliable liveness source. We are moving to exact request correlation:

```
ChatGPT live stream
  metadata.request_id + conversation_id
             |
             v
        correlation table
             ^
             |
Tunnel / MCP proxy
  x-request-id + JSON-RPC id + tool lifecycle
```

## Required tunnel facts

For every inbound HTTP POST `/mcp` / JSON-RPC `tools/call`, capture:

- `request_id`: normalized inbound HTTP `x-request-id` when present
- `jsonrpc_id`: original JSON-RPC request id
- `tool_name`
- `started_at`
- `result_returned_at`
- `outcome`: success | error | canceled
- `response_bytes`
- `pending_tool_calls` after the transition
- proxy process generation / child generation if already available

Do not synthesize request ids. Missing `x-request-id` is a valid observable state.

## API shape

Prefer a local read-only diagnostics endpoint owned by the resilient proxy.

### Option A — SSE/event stream (preferred)

`GET /diagnostics/tool-events`

Each event is one JSON object:

```json
{
  "version": 1,
  "seq": 1234,
  "request_id": "wfr_...",
  "jsonrpc_id": 91,
  "tool_name": "read_multiple_files",
  "phase": "started",
  "at": "2026-10-17T12:00:00.000Z",
  "pending_tool_calls": 2,
  "generation": 7
}
```

Completion:

```json
{
  "version": 1,
  "seq": 1235,
  "request_id": "wfr_...",
  "jsonrpc_id": 91,
  "tool_name": "read_multiple_files",
  "phase": "completed",
  "at": "2026-10-17T12:00:01.100Z",
  "duration_ms": 1100,
  "outcome": "success",
  "response_bytes": 8421,
  "pending_tool_calls": 1,
  "generation": 7
}
```

### Option B — bounded snapshot + cursor

`GET /diagnostics/tool-events?after=<seq>&limit=<n>`

Return a bounded ring-buffer page and latest sequence.

## Correctness requirements

1. `request_id` must come from the actual inbound HTTP request header; never infer it from JSON-RPC id, timing, tool name, process id, or MCP session.
2. A single HTTP request may contain a JSON-RPC batch. All child messages inherit the same HTTP request id; each keeps its own JSON-RPC id.
3. Multiple tool calls may share the same ChatGPT `request_id`. Do not treat request id as a unique tool-call id.
4. Emit completion only after the response/error path is known.
5. Keep at least a bounded recent history so gaifan can reconnect without losing the last transition.
6. Endpoint is localhost-only by default and read-only.
7. Do not include tool arguments or tool results in this feed.
8. Existing `/healthz` and `/readyz` semantics must remain unchanged.
9. Existing diagnostics / stall logs must remain compatible.
10. No ChatGPT-specific parsing belongs in this repository.

## Acceptance matrix

Run as one test driver after implementation:

- single tool success
- single tool error
- two concurrent tool calls
- JSON-RPC batch under one HTTP request id
- missing `x-request-id`
- reconnect from cursor/ring buffer
- child generation change
- response with large/paged result

For every case verify event ordering, pending count, ids, and bounded retention.

## Files likely involved

- `src/resilient-mcp-proxy.ts`
- existing `ProxyDiagnostics` implementation and tests
- resilient proxy integration tests

## Deliverable

Commit the implementation and tests on the DesktopCommanderMCP fork and hand back:

- commit SHA
- endpoint / event schema
- exact header normalization rule
- test summary
- any cases where the upstream client does not send `x-request-id`

Do not add autoresume/stall policy here. gaifan owns correlation + policy.
