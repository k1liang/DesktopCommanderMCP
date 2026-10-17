import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startResilientMcpProxy } from '../dist/resilient-mcp-proxy.js';

async function post(url, message, requestId) {
  const headers = { 'content-type': 'application/json' };
  if (requestId !== undefined) headers['X-Request-ID'] = requestId;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function getEvents(proxy, after = 0, limit = 256) {
  const response = await fetch(
    `http://${proxy.host}:${proxy.port}/diagnostics/tool-events?after=${after}&limit=${limit}`,
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

function assertPair(events, { requestId, jsonrpcId, toolName, outcome = 'success' }) {
  assert.equal(events.length, 2, `expected lifecycle pair for ${toolName}`);
  const [started, completed] = events;
  assert.equal(started.version, 1);
  assert.equal(completed.version, 1);
  assert.ok(completed.seq > started.seq);
  assert.equal(started.request_id, requestId);
  assert.equal(completed.request_id, requestId);
  assert.equal(started.jsonrpc_id, jsonrpcId);
  assert.equal(completed.jsonrpc_id, jsonrpcId);
  assert.equal(started.tool_name, toolName);
  assert.equal(completed.tool_name, toolName);
  assert.equal(started.phase, 'started');
  assert.equal(completed.phase, 'completed');
  assert.equal(started.pending_tool_calls >= 1, true);
  assert.equal(completed.pending_tool_calls >= 0, true);
  assert.equal(completed.outcome, outcome);
  assert.equal(typeof completed.response_bytes, 'number');
  assert.equal(typeof completed.duration_ms, 'number');
  assert.equal(typeof started.started_at, 'string');
  assert.equal(typeof completed.result_returned_at, 'string');
}

async function run() {
  const diagnosticsDir = await mkdtemp(path.join(os.tmpdir(), 'dc-correlation-'));
  const childEntry = fileURLToPath(new URL('./fixtures/resilient-proxy-correlation-child.mjs', import.meta.url));
  const proxy = await startResilientMcpProxy({
    port: 0,
    childEntry,
    diagnosticsDir,
    resultPageBytes: 2048,
    toolEventHistoryLimit: 12,
    stallThresholdMs: 0,
  });

  let cursor = 0;
  try {
    // 1. single tool success + case-insensitive header lookup
    await post(proxy.url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ok', arguments: { text: 'single-success' } },
    }, 'req-success');
    let page = await getEvents(proxy, cursor);
    assertPair(page.events, { requestId: 'req-success', jsonrpcId: 1, toolName: 'ok' });
    assert.equal(page.events[0].pending_tool_calls, 1);
    assert.equal(page.events[1].pending_tool_calls, 0);
    cursor = page.next_after;

    // 2. single tool error
    await post(proxy.url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'fail', arguments: {} },
    }, 'req-error');
    page = await getEvents(proxy, cursor);
    assertPair(page.events, { requestId: 'req-error', jsonrpcId: 2, toolName: 'fail', outcome: 'error' });
    cursor = page.next_after;

    // 3. two concurrent tool calls must expose a pending count of 2.
    await Promise.all([
      post(proxy.url, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'ok', arguments: { delay_ms: 120, text: 'a' } },
      }, 'req-concurrent-a'),
      post(proxy.url, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'ok', arguments: { delay_ms: 10, text: 'b' } },
      }, 'req-concurrent-b'),
    ]);
    page = await getEvents(proxy, cursor);
    assert.equal(page.events.length, 4);
    assert.ok(page.events.some(event => event.phase === 'started' && event.pending_tool_calls === 2));
    assert.equal(page.events.at(-1).pending_tool_calls, 0);
    assert.deepEqual(
      new Set(page.events.filter(event => event.phase === 'completed').map(event => event.request_id)),
      new Set(['req-concurrent-a', 'req-concurrent-b']),
    );

    const stallEvents = (await readFile(proxy.diagnostics.stallLogPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const concurrentStalls = stallEvents.filter(
      event => event.kind === 'tool_stall' && (event.seq === '3' || event.seq === '4'),
    );
    assert.deepEqual(
      concurrentStalls.map(event => event.seq),
      ['4', '3'],
      'stall log should preserve real completion order when concurrent calls finish out of arrival order',
    );
    const lateCompletion = concurrentStalls.find(event => event.seq === '3');
    assert.equal(lateCompletion?.completion_out_of_order, true);
    assert.equal(lateCompletion?.previous_stall_seq, '4');
    assert.equal(lateCompletion?.messages_since_previous_stall, null);
    assert.ok(
      stallEvents.every(event => event.messages_since_previous_stall == null || BigInt(event.messages_since_previous_stall) >= 0n),
      'stall sequence deltas must never become negative',
    );
    cursor = page.next_after;

    // 4. JSON-RPC batch: both child messages inherit one HTTP request id.
    const batch = await post(proxy.url, [
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'ok', arguments: { text: 'batch-a' } },
      },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'ok', arguments: { text: 'batch-b' } },
      },
    ], 'req-batch');
    assert.equal(batch.length, 2);
    page = await getEvents(proxy, cursor);
    assert.equal(page.events.length, 4);
    assert.deepEqual(new Set(page.events.map(event => event.request_id)), new Set(['req-batch']));
    assert.deepEqual(new Set(page.events.map(event => event.jsonrpc_id)), new Set([5, 6]));
    cursor = page.next_after;

    // 5. Missing x-request-id is observable as null, never synthesized.
    await post(proxy.url, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'ok', arguments: {} },
    });
    page = await getEvents(proxy, cursor);
    assertPair(page.events, { requestId: null, jsonrpcId: 7, toolName: 'ok' });
    cursor = page.next_after;

    // 6. Cursor reconnect can resume at the last observed transition.
    const reconnectCursor = cursor;
    await post(proxy.url, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'ok', arguments: { text: 'reconnect' } },
    }, 'req-reconnect');
    const reconnectFirst = await getEvents(proxy, reconnectCursor, 1);
    assert.equal(reconnectFirst.events.length, 1);
    assert.equal(reconnectFirst.events[0].phase, 'started');
    assert.equal(reconnectFirst.has_more, true);
    const reconnectSecond = await getEvents(proxy, reconnectFirst.next_after, 8);
    assert.equal(reconnectSecond.events.length, 1);
    assert.equal(reconnectSecond.events[0].phase, 'completed');
    cursor = reconnectSecond.next_after;

    // 7. Child generation change is reflected on subsequent lifecycle events.
    const generationBefore = proxy.session.childGeneration;
    await proxy.session.restart();
    assert.ok(proxy.session.childGeneration > generationBefore);
    await post(proxy.url, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'ok', arguments: { text: 'new-generation' } },
    }, 'req-generation');
    page = await getEvents(proxy, cursor);
    assertPair(page.events, { requestId: 'req-generation', jsonrpcId: 9, toolName: 'ok' });
    assert.ok(page.events.every(event => event.generation > generationBefore));
    cursor = page.next_after;

    // 8. Large/paged response still reports the concrete returned response size.
    const large = await post(proxy.url, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'large', arguments: { size: 10000 } },
    }, 'req-large');
    assert.equal(large.result?.structuredContent?.pagination?.has_more, true);
    page = await getEvents(proxy, cursor);
    assertPair(page.events, { requestId: 'req-large', jsonrpcId: 10, toolName: 'large' });
    assert.ok(page.events[1].response_bytes > 0);
    cursor = page.next_after;

    // 9. Explicit correlation marker carries the opaque coordinator token.
    const correlationToken = 'gaifan-bind-0123456789abcdef';
    await post(proxy.url, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'correlation_marker',
        arguments: { token: correlationToken },
      },
    }, 'req-correlation-marker');
    page = await getEvents(proxy, cursor);
    assertPair(page.events, { requestId: 'req-correlation-marker', jsonrpcId: 11, toolName: 'correlation_marker' });
    assert.ok(page.events.every(event => event.correlation_token === correlationToken));
    cursor = page.next_after;

    // Bounded retention: overflow the ring and verify old cursors are marked truncated.
    for (let i = 0; i < 8; i += 1) {
      await post(proxy.url, {
        jsonrpc: '2.0',
        id: 100 + i,
        method: 'tools/call',
        params: { name: 'ok', arguments: { text: `retention-${i}` } },
      }, `req-retention-${i}`);
    }
    const retained = await getEvents(proxy, 0, 256);
    assert.equal(retained.retention_limit, 12);
    assert.equal(retained.events.length, 12);
    assert.equal(retained.truncated, true);
    assert.ok(retained.oldest_seq > 1);
    assert.equal(retained.latest_seq - retained.oldest_seq + 1, 12);
    assert.equal(retained.next_after, retained.latest_seq);

    const badAfter = await fetch(
      `http://${proxy.host}:${proxy.port}/diagnostics/tool-events?after=-1&limit=1`,
    );
    assert.equal(badAfter.status, 400);

    console.log('PASS: request correlation lifecycle acceptance matrix (9/9)');
    return true;
  } finally {
    await proxy.close();
    await rm(diagnosticsDir, { recursive: true, force: true });
  }
}

run().then(
  ok => process.exit(ok ? 0 : 1),
  error => {
    console.error(error);
    process.exit(1);
  },
);
