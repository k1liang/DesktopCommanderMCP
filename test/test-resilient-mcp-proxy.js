import assert from 'node:assert/strict';
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
  const proxy = await startResilientMcpProxy({ port: 0 });
  try {
    const list1 = await post(proxy.url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    assert.ok(Array.isArray(list1.result?.tools), 'cold tools/list should succeed without caller initialize');
    assert.ok(list1.result.tools.some(tool => tool.name === 'get_config'), 'get_config should be advertised');

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
