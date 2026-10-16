import assert from 'node:assert/strict';
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
  const proxy = await startResilientMcpProxy({ port: 0, resultPageBytes: 4096 });
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

    const generationBefore = proxy.session.childGeneration;
    const child = proxy.session.child;
    assert.ok(child?.pid, 'proxy should own a live Desktop Commander child');
    child.kill();
    await waitForExit(child);

    const list2 = await post(proxy.url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {},
    });
    assert.ok(Array.isArray(list2.result?.tools), 'tools/list should recover after child replacement');
    assert.ok(proxy.session.childGeneration > generationBefore, 'child generation should advance after recovery');

    const health = await fetch(`http://${proxy.host}:${proxy.port}/healthz`).then(response => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.childReady, true);

    console.log('PASS: resilient MCP proxy handles cold requests and child replacement');
    return true;
  } finally {
    await proxy.close();
  }
}

run().then(
  ok => process.exit(ok ? 0 : 1),
  error => {
    console.error(error);
    process.exit(1);
  },
);
