/**
 * The ceiling on one blocking process wait is a fixed constant, not a config
 * value: timeout_ms is the only knob callers have. Checks that a wait the
 * ceiling ends answers before the client's request timeout, the ceiling the
 * product computes, that set_config_value refuses the old maxProcessWaitMs key
 * and get_config doesn't list it, and set_config_value's handling of number
 * fields (numeric strings stored as numbers, non-numbers rejected, null resets)
 * and of null on array fields (it clears them too; it was stored as ["null"],
 * which made "null" the only allowed folder).
 * A wait the ceiling ends answers with the same status line as before.
 * The tests change settings in the home, so they run only in a test home (the
 * runner's), and leave every setting they change as they found it.
 */
import assert from 'assert';
import os from 'os';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { configManager } from '../dist/config-manager.js';
import { MAX_PROCESS_WAIT_MS } from '../dist/config.js';
import { getProcessWaitLimit } from '../dist/terminal-manager.js';
import { getConfig, setConfigValue } from '../dist/tools/config.js';
import { validatePath } from '../dist/tools/filesystem.js';
import { startProcess, readProcessOutput, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

// A capped wait answers after MAX_PROCESS_WAIT_MS, and that answer still has to
// be built and delivered (through the remote device's relay, too) before the
// client gives up on the call: at the MCP SDK's default request timeout, which
// Claude Desktop and the remote device's own client use (-32001 "Request timed out").
const MIN_MARGIN_UNDER_CLIENT_TIMEOUT_MS = 10000;

async function testCeilingUnderClientTimeout() {
  console.log('\n--- Test 0: a capped wait answers before the client gives up ---');
  const margin = DEFAULT_REQUEST_TIMEOUT_MSEC - MAX_PROCESS_WAIT_MS;
  assert(margin >= MIN_MARGIN_UNDER_CLIENT_TIMEOUT_MS,
    `a wait capped at ${MAX_PROCESS_WAIT_MS}ms leaves ${margin}ms before the client's ${DEFAULT_REQUEST_TIMEOUT_MSEC}ms request timeout: ` +
    `the answer arrives after the client has given up (-32001); it needs at least ${MIN_MARGIN_UNDER_CLIENT_TIMEOUT_MS}ms`);
  console.log(`ok: ${margin}ms margin under the SDK's ${DEFAULT_REQUEST_TIMEOUT_MSEC}ms request timeout`);
}

async function testFixedCeiling() {
  console.log('\n--- Test 1: the wait ceiling is the fixed constant ---');
  assert.strictEqual(MAX_PROCESS_WAIT_MS, 5000);
  assert.deepStrictEqual(getProcessWaitLimit(MAX_PROCESS_WAIT_MS * 5),
    { waitMs: MAX_PROCESS_WAIT_MS, capMs: MAX_PROCESS_WAIT_MS, capped: true });
  assert.deepStrictEqual(getProcessWaitLimit(1000),
    { waitMs: 1000, capMs: MAX_PROCESS_WAIT_MS, capped: false });
  assert.deepStrictEqual(getProcessWaitLimit(MAX_PROCESS_WAIT_MS),
    { waitMs: MAX_PROCESS_WAIT_MS, capMs: MAX_PROCESS_WAIT_MS, capped: false });
  console.log(`ok: min(timeout_ms, ${MAX_PROCESS_WAIT_MS}ms)`);
}

async function testNotConfigurable() {
  console.log('\n--- Test 2: maxProcessWaitMs is not a config key ---');
  const response = await setConfigValue({ key: 'maxProcessWaitMs', value: 5000 });
  assert.strictEqual(response.isError, true);
  assert.match(response.content[0].text, /not configurable/);
  assert.strictEqual(await configManager.getValue('maxProcessWaitMs'), undefined);
  const keys = (await getConfig()).structuredContent.entries.map((entry) => entry.key);
  assert(!keys.includes('maxProcessWaitMs'), `get_config must not list it, got: ${keys.join(', ')}`);
  console.log('ok: set_config_value refuses it, get_config does not list it');
}

async function testNumberFields() {
  console.log('\n--- Test 3: set_config_value number fields ---');
  const key = 'fileReadLineLimit';
  const before = await configManager.getValue(key);
  try {
    let response = await setConfigValue({ key, value: '250' });
    assert.notStrictEqual(response.isError, true, response.content?.[0]?.text);
    assert.strictEqual(await configManager.getValue(key), 250);

    response = await setConfigValue({ key, value: 'many' });
    assert.strictEqual(response.isError, true);
    assert.match(response.content[0].text, /must be a number/);
    assert.strictEqual(await configManager.getValue(key), 250, 'a rejected value must not change the stored one');

    response = await setConfigValue({ key, value: null });
    assert.notStrictEqual(response.isError, true, response.content?.[0]?.text);
    assert.strictEqual(await configManager.getValue(key), null);
  } finally {
    await configManager.setValue(key, before);
  }
  console.log('ok: "250" stored as 250, "many" rejected, null clears it');
}

async function testNullOnArrayFields() {
  console.log('\n--- Test 3b: set_config_value null on array fields ---');
  for (const key of ['allowedDirectories', 'blockedCommands']) {
    const before = await configManager.getValue(key);
    try {
      const response = await setConfigValue({ key, value: null });
      assert.notStrictEqual(response.isError, true, response.content?.[0]?.text);
      assert.strictEqual(await configManager.getValue(key), null,
        `null should clear ${key}, got ${JSON.stringify(await configManager.getValue(key))}: ${response.content[0].text.split('\n')[0]}`);
      if (key === 'allowedDirectories') {
        // Cleared, the allowed folders are what they are when never set: the home folder
        await validatePath(os.homedir()).catch((error) => assert.fail(`the home folder should be allowed again: ${error.message}`));
      }
    } finally {
      await configManager.setValue(key, before);
    }
  }
  console.log('ok: null clears allowedDirectories and blockedCommands');
}

async function testCappedWaitAnswers() {
  console.log('\n--- Test 4: blocking process polls release at the wait ceiling ---');
  // A small ceiling stands in for MAX_PROCESS_WAIT_MS so the test stays fast.
  const CAP_MS = 300;
  const started = await startProcess({ command: 'node -e "setTimeout(() => {}, 3000)"', timeout_ms: 5000 });
  const pid = started.structuredContent?.pid;
  assert.ok(pid > 0, `start_process should start node, got: ${started.content[0].text}`);
  try {
    const began = Date.now();
    const read = await readProcessOutput({ pid, timeout_ms: 5000 }, CAP_MS);
    const elapsed = Date.now() - began;
    assert.ok(elapsed >= CAP_MS - 75 && elapsed < CAP_MS + 1000,
      `read_process_output should release at ~${CAP_MS}ms, took ${elapsed}ms: ${read.content[0].text}`);
    assert.ok(!read.content[0].text.includes('Process completed'),
      `the wait ceiling must not terminate the underlying process: ${read.content[0].text}`);
  } finally {
    await forceTerminate({ pid });
  }

  const repl = await startProcess({ command: 'node -i', timeout_ms: 5000 });
  const replPid = repl.structuredContent?.pid;
  assert.ok(replPid > 0, `start_process should start the Node.js REPL, got: ${repl.content[0].text}`);
  try {
    let promptText = '';
    for (let i = 0; i < 10 && !promptText.includes('waiting for input'); i++) {
      promptText = (await readProcessOutput({ pid: replPid, timeout_ms: 500 })).content[0].text;
    }
    assert.ok(promptText.includes('waiting for input'),
      `the REPL prompt should be visible before interaction: ${promptText}`);
    const busy = await interactWithProcess(
      { pid: replPid, input: 'const t = Date.now(); while (Date.now() - t < 2000) {}', timeout_ms: 5000 }, CAP_MS);
    assert.strictEqual(busy.structuredContent.waitCapped, true, busy.content[0].text);
    assert.ok(busy.content[0].text.endsWith('\n⏱️ Response may be incomplete (timeout reached)'),
      `interact_with_process should end with the old status line, got: ${busy.content[0].text}`);
  } finally {
    await forceTerminate({ pid: replPid });
  }
  console.log('ok: read_process_output and interact_with_process release at the wait ceiling');
}

async function testNodeLocalKeepsItsOwnTimeout() {
  console.log('\n--- Test 5: node:local keeps its own timeout instead of the resumable wait ceiling ---');
  // node:local is one-shot: a short resumable-process ceiling must not kill it.
  const CAP_MS = 300;
  const started = await startProcess({ command: 'node:local', timeout_ms: 3000 });
  const pid = Number(started.content[0].text.match(/PID (-?\d+)/)?.[1]);
  assert.ok(pid < 0, `start_process should start a node:local session, got: ${started.content[0].text}`);
  try {
    const result = await interactWithProcess(
      { pid, input: "await new Promise((resolve) => setTimeout(resolve, 800)); console.log('done');", timeout_ms: 3000 }, CAP_MS);
    assert.notStrictEqual(result.isError, true, result.content[0].text);
    assert.strictEqual(result.content[0].text.trim(), 'done',
      `node:local should finish under its explicit timeout even though maxWaitMs is ${CAP_MS}ms`);
  } finally {
    await forceTerminate({ pid });
  }
  console.log('ok: node:local is not killed by the resumable process wait ceiling');
}

// The settings these tests change: they must be left as they were found
const CHANGED_SETTINGS = ['fileReadLineLimit', 'allowedDirectories', 'blockedCommands'];

async function runAllTests() {
  if (!isTestHome()) {
    skip('process wait and config tests: they change settings in the home, so they run only through the test runner');
    return;
  }
  const before = await configManager.getConfig();
  await testCeilingUnderClientTimeout();
  await testFixedCeiling();
  await testNotConfigurable();
  await testNumberFields();
  await testNullOnArrayFields();
  await testCappedWaitAnswers();
  await testNodeLocalKeepsItsOwnTimeout();
  const after = await configManager.getConfig();
  for (const key of CHANGED_SETTINGS) {
    assert.deepStrictEqual(after[key], before[key],
      `the tests left ${key} as ${JSON.stringify(after[key])}, not as they found it (${JSON.stringify(before[key])})`);
  }
  console.log('\n✅ process wait ceiling and config number tests passed');
}

runIfMain(import.meta.url, runAllTests);

export default runAllTests;
