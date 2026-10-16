import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startResilientMcpProxy } from '../dist/resilient-mcp-proxy.js';

async function post(url, message) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => child.once('exit', resolve));
}

async function run() {
  const diagnosticsDir = await mkdtemp(path.join(os.tmpdir(), 'dc-resilient-proxy-'));
  const proxy = await startResilientMcpProxy({
    port: 0,
    resultPageBytes: 4096,
    diagnosticsDir,
    stallThresholdMs: 0,
    messageGapThresholdMs: 0,
    sequenceBlockSize: 8n,
  });
  let lastSequence = 0n;
  try {
    const list1 = await post(proxy.url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    assert.ok(Array.isArray(list1.result?.tools), 'cold tools/list should succeed without caller initialize');
    assert.ok(list1.result.tools.some(tool => tool.name === 'get_config'), 'get_config should be advertised');
    assert.ok(list1.result.tools.some(tool => tool.name === 'get_result_page'), 'proxy pagination tool should be advertised');

    const config = await post(proxy.url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'get_config',
        arguments: { origin: 'llm' },
      },
    });
    assert.equal(config.error, undefined, 'cold get_config should not expose initialization error');
    assert.equal(config.result?.isError, undefined, 'get_config should succeed');

    const small = await post(proxy.url, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'get_file_info',
        arguments: { path: fileURLToPath(new URL('../package.json', import.meta.url)) },
      },
    });
    assert.equal(small.result?.structuredContent, undefined, 'small text results should remain unchanged');

    const paged = await post(proxy.url, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'read_file',
        arguments: { path: fileURLToPath(new URL('../src/resilient-mcp-proxy.ts', import.meta.url)) },
      },
    });
    const firstMeta = paged.result?.structuredContent?.pagination;
    assert.equal(firstMeta?.has_more, true, 'large text result should be paginated');
    assert.equal(firstMeta?.page, 1);
    assert.ok(firstMeta?.total_pages > 1);
    assert.match(paged.result.content[0].text, /This response is incomplete/);
    assert.match(paged.result.content[0].text, /Call get_result_page/);

    let cursor = firstMeta.next_cursor;
    let pageCount = 1;

    // Existing ChatGPT conversations may cache the old tool schema and not see
    // get_result_page until a new conversation starts. read_file provides a
    // backwards-compatible cursor transport so those sessions can continue too.
    const fallbackPage = await post(proxy.url, {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: `result-page://${cursor}` } },
    });
    pageCount += 1;
    let pageMeta = fallbackPage.result?.structuredContent?.pagination;
    assert.equal(pageMeta?.page, pageCount);
    assert.equal(pageMeta?.total_pages, firstMeta.total_pages);
    cursor = pageMeta.next_cursor;

    while (cursor) {
      const page = await post(proxy.url, {
        jsonrpc: '2.0',
        id: 21 + pageCount,
        method: 'tools/call',
        params: { name: 'get_result_page', arguments: { cursor } },
      });
      pageCount += 1;
      pageMeta = page.result?.structuredContent?.pagination;
      assert.equal(pageMeta?.page, pageCount);
      assert.equal(pageMeta?.total_pages, firstMeta.total_pages);
      cursor = pageMeta.next_cursor;
    }
    assert.equal(pageCount, firstMeta.total_pages, 'all paginated pages should be retrievable');

    const repoRoot = fileURLToPath(new URL('../', import.meta.url));
    const search = await post(proxy.url, {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: 'start_search',
        arguments: {
          path: repoRoot,
          pattern: 'package.json',
          searchType: 'files',
          maxResults: 20,
        },
      },
    });
    const searchText = search.result?.content?.[0]?.text ?? '';
    const searchId = searchText.match(/started .* search session:\s*(search_[^\s]+)/i)?.[1];
    assert.ok(searchId, 'start_search should return a session id');

    const generationBefore = proxy.session.childGeneration;
    const child = proxy.session.child;
    assert.ok(child?.pid, 'proxy should own a live Desktop Commander child');
    child.kill();
    await waitForExit(child);

    const resumedSearch = await post(proxy.url, {
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'get_more_search_results',
        arguments: { sessionId: searchId, offset: 0, length: 20 },
      },
    });
    assert.equal(resumedSearch.result?.isError, undefined, 'search should transparently recover after child replacement');
    const resumedText = resumedSearch.result?.content?.[0]?.text ?? '';
    assert.match(resumedText, new RegExp(searchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'recovered search keeps the external session id');
    assert.doesNotMatch(resumedText, /not found/i);
    assert.ok(proxy.session.childGeneration > generationBefore, 'child generation should advance after recovery');

    const list2 = await post(proxy.url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {},
    });
    assert.ok(Array.isArray(list2.result?.tools), 'tools/list should recover after child replacement');

    const health = await fetch(`http://${proxy.host}:${proxy.port}/healthz`).then(response => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.childReady, true);
    assert.equal(health.stallThresholdMs, 0);
    assert.equal(health.messageGapThresholdMs, 0);
    assert.equal(health.stallLogPath, proxy.diagnostics.stallLogPath);

    const firstEvents = (await readFile(proxy.diagnostics.stallLogPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const firstToolStalls = firstEvents.filter(event => event.kind === 'tool_stall');
    assert.ok(firstToolStalls.length > 0, 'tool calls should be captured in the dedicated stall log');
    const continuationGap = firstEvents.find(event => event.kind === 'continuation_gap_candidate');
    assert.ok(continuationGap, 'continuation gaps should be captured in the dedicated stall log');
    assert.equal(typeof continuationGap.arrival_gap_ms, 'number');
    assert.equal(typeof continuationGap.idle_after_completed_tool_ms, 'number');
    assert.ok(continuationGap.last_completed_tool_seq, 'continuation gaps should identify the last completed tool');
    assert.ok(firstEvents.some(event => event.kind === 'search_session_rehydrated'), 'child replacement should record search rehydration');
    for (let i = 1; i < firstToolStalls.length; i += 1) {
      assert.ok(BigInt(firstToolStalls[i].seq) > BigInt(firstToolStalls[i - 1].seq), 'tool message sequence must increase');
    }
    lastSequence = BigInt(firstToolStalls.at(-1).seq);
  } finally {
    await proxy.close();
  }

  const proxy2 = await startResilientMcpProxy({
    port: 0,
    diagnosticsDir,
    stallThresholdMs: 0,
    messageGapThresholdMs: 0,
    sequenceBlockSize: 8n,
  });
  try {
    await post(proxy2.url, {
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: { name: 'get_config', arguments: { origin: 'llm' } },
    });
    const secondEvents = (await readFile(proxy2.diagnostics.stallLogPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
    const secondToolStalls = secondEvents.filter(event => event.kind === 'tool_stall');
    assert.ok(BigInt(secondToolStalls.at(-1).seq) > lastSequence, 'message sequence must remain monotonic after proxy restart');
  } finally {
    await proxy2.close();
    await rm(diagnosticsDir, { recursive: true, force: true });
  }

  console.log('PASS: resilient MCP proxy preserves search sessions and persistent diagnostic sequencing');
  return true;
}

run().then(
  ok => process.exit(ok ? 0 : 1),
  error => {
    console.error(error);
    process.exit(1);
  },
);
