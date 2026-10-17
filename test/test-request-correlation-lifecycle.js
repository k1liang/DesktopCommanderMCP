import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startResilientMcpProxy } from '../dist/resilient-mcp-proxy.js';

const childEntry = fileURLToPath(new URL('./fixtures/tool-lifecycle-mcp-server.js', import.meta.url));

function toolCall(id, name, args = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

async function post(proxy, message, requestId) {
  const headers = { 'content-type': 'application/json' };
  if (requestId !== undefined) headers['x-request-id'] = requestId;
  const response = await fetch(proxy.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function eventPage(proxy, after = 0, limit = 1000) {
  const url = new URL('/diagnostics/tool-events', `http://${proxy.host}:${proxy.port}`);
  url.searchParams.set('after', String(after));
  url.searchParams.set('limit', String(limit));
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => child.once('exit', resolve));
}

function assertPair(events, { requestId, jsonrpcId, toolName, outcome }) {
  assert.equal(events.length, 2);
  const [started, completed] = events;
  assert.equal(started.version, 1);
  assert.equal(completed.version, 1);
  assert.equal(started.phase, 'started');
  assert.equal(completed.phase, 'completed');
  assert.equal(started.request_id, requestId);
  assert.equal(completed.request_id, requestId);
  assert.equal(started.jsonrpc_id, jsonrpcId);
  assert.equal(completed.jsonrpc_id, jsonrpcId);
  assert.equal(started.tool_name, toolName);
  assert.equal(completed.tool_name, toolName);
  assert.equal(started.pending_tool_calls, 1);
  assert.equal(completed.pending_tool_calls, 0);
  assert.equal(completed.outcome, outcome);
  assert.equal(completed.started_at, started.started_at);
  assert.equal(completed.result_returned_at, completed.at);
  assert.ok(completed.duration_ms >= 0);
  assert.ok(completed.response_bytes >= 0);
  assert.ok(completed.seq > started.seq);
  assert.equal(Object.hasOwn(started, 'arguments'), false);
  assert.equal(Object.hasOwn(completed, 'result'), false);
}

async function run() {
  const diagnosticsDir = await mkdtemp(path.join(os.tmpdir(), 'dc-request-correlation-'));
  const proxy = await startResilientMcpProxy({
    port: 0,
    childEntry,
    diagnosticsDir,
    resultPageBytes: 1024,
    toolEventMaxEntries: 12,
  });
  let cursor = 0;

  const drain = async () => {
    const page = await eventPage(proxy, cursor);
    cursor = page.next_after;
    return page.events;
  };

  try {
    // 1. single tool success
    const successResponse = await post(proxy, toolCall(1, 'ok'), 'req-success');
    let events = await drain();
    assertPair(events, { requestId: 'req-success', jsonrpcId: 1, toolName: 'ok', outcome: 'success' });
    assert.equal(events[1].response_bytes, Buffer.byteLength(JSON.stringify(successResponse), 'utf8'));

    // 2. single tool error
    const errorResponse = await post(proxy, toolCall(2, 'error'), 'req-error');
    assert.equal(errorResponse.result?.isError, true);
    events = await drain();
    assertPair(events, { requestId: 'req-error', jsonrpcId: 2, toolName: 'error', outcome: 'error' });

    // 3. two concurrent tool calls
    await Promise.all([
      post(proxy, toolCall(3, 'delay', { ms: 120 }), 'req-concurrent-a'),
      post(proxy, toolCall(4, 'delay', { ms: 120 }), 'req-concurrent-b'),
    ]);
    events = await drain();
    assert.equal(events.length, 4);
    const concurrentStarted = events.filter(event => event.phase === 'started');
    const concurrentCompleted = events.filter(event => event.phase === 'completed');
    assert.equal(concurrentStarted.length, 2);
    assert.equal(concurrentCompleted.length, 2);
    assert.equal(Math.max(...concurrentStarted.map(event => event.pending_tool_calls)), 2);
    assert.deepEqual(concurrentCompleted.map(event => event.pending_tool_calls).sort((a, b) => a - b), [0, 1]);
    assert.deepEqual(new Set(events.map(event => event.request_id)), new Set(['req-concurrent-a', 'req-concurrent-b']));

    // 4. JSON-RPC batch under one HTTP request id
    const batchResponse = await post(proxy, [
      toolCall(5, 'ok'),
      toolCall('six', 'ok'),
    ], 'req-batch');
    assert.equal(batchResponse.length, 2);
    events = await drain();
    assert.equal(events.length, 4);
    assert.ok(events.every(event => event.request_id === 'req-batch'));
    assert.deepEqual(new Set(events.map(event => event.jsonrpc_id)), new Set([5, 'six']));

    // 5. missing x-request-id is observable as null; never synthesize one
    await post(proxy, toolCall(7, 'ok'));
    events = await drain();
    assertPair(events, { requestId: null, jsonrpcId: 7, toolName: 'ok', outcome: 'success' });

    // 6. reconnect from cursor: page one transition, reconnect with next_after
    await post(proxy, toolCall(8, 'ok'), 'req-cursor');
    const firstCursorPage = await eventPage(proxy, cursor, 1);
    assert.equal(firstCursorPage.events.length, 1);
    assert.equal(firstCursorPage.events[0].phase, 'started');
    assert.equal(firstCursorPage.has_more, true);
    const secondCursorPage = await eventPage(proxy, firstCursorPage.next_after, 1);
    assert.equal(secondCursorPage.events.length, 1);
    assert.equal(secondCursorPage.events[0].phase, 'completed');
    assert.equal(secondCursorPage.events[0].request_id, 'req-cursor');
    cursor = secondCursorPage.next_after;

    // 7. child generation change is reflected by the completion transition
    const generationBefore = proxy.session.childGeneration;
    const child = proxy.session.child;
    assert.ok(child?.pid);
    child.kill();
    await waitForExit(child);
    await post(proxy, toolCall(9, 'ok'), 'req-generation');
    events = await drain();
    assert.equal(events.length, 2);
    const generationCompletion = events.find(event => event.phase === 'completed');
    assert.ok(generationCompletion.generation > generationBefore);
    assert.ok(proxy.session.childGeneration > generationBefore);

    // 8. response with a large/paged result records final wire response bytes
    const largeResponse = await post(proxy, toolCall(10, 'large', { bytes: 8192 }), 'req-large');
    assert.equal(largeResponse.result?.structuredContent?.pagination?.has_more, true);
    events = await drain();
    assertPair(events, { requestId: 'req-large', jsonrpcId: 10, toolName: 'large', outcome: 'success' });
    assert.equal(events[1].response_bytes, Buffer.byteLength(JSON.stringify(largeResponse), 'utf8'));

    // Bounded retention: older transitions are explicitly reported as truncated.
    const retained = await eventPage(proxy, 0, 1000);
    assert.equal(retained.max_entries, 12);
    assert.equal(retained.events.length, 12);
    assert.equal(retained.truncated, true);
    assert.ok(retained.oldest_seq > 1);
    assert.equal(retained.latest_seq, cursor);

    // Existing health/ready semantics remain intact.
    const health = await fetch(`http://${proxy.host}:${proxy.port}/healthz`).then(response => response.json());
    const ready = await fetch(`http://${proxy.host}:${proxy.port}/readyz`).then(response => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.childReady, true);
    assert.equal(ready.ok, true);
    assert.equal(ready.childReady, true);
  } finally {
    await proxy.close();
    await rm(diagnosticsDir, { recursive: true, force: true });
  }

  console.log('PASS: request-correlation lifecycle acceptance matrix 8/8');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
