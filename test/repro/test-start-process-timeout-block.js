import assert from 'assert';
import { runIfMain } from '../helpers/run-if-main.js';
import { terminalManager } from '../../dist/terminal-manager.js';

/**
 * Regression coverage for the local start_process policy:
 * executeCommand() is a spawn operation. Once the child process and listeners
 * are registered it must return the PID immediately; output and completion are
 * consumed later through read_process_output / the TerminalManager buffer.
 */

const START_MAX_MS = 500;
const PROC_LIFETIME_MS = 2000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const cleanup = (pid) => { try { terminalManager.forceTerminate(pid); } catch {} };

async function testSilentProcessReturnsImmediately() {
  console.log('\n馃搵 Test 1: silent long-running process returns immediately...');
  const t0 = Date.now();
  const res = await terminalManager.executeCommand(
    `node -e "setTimeout(function(){}, ${PROC_LIFETIME_MS})"`,
    10000,
    undefined,
    true
  );
  const elapsed = Date.now() - t0;

  try {
    assert(res.pid > 0, 'should have spawned a process');
    assert.strictEqual(res.isBlocked, true, 'running process should report isBlocked=true');
    assert.strictEqual(res.output, '', 'start_process should not wait for initial output');
    assert.strictEqual(res.timingInfo?.exitReason, 'process_started');
    assert(elapsed < START_MAX_MS, `start_process should return in <${START_MAX_MS}ms, took ${elapsed}ms`);
    assert(terminalManager.getSession(res.pid), 'session must remain registered after start_process returns');
    console.log(`  鉁?returned in ${elapsed}ms with PID ${res.pid}`);
  } finally {
    cleanup(res.pid);
  }
}

async function testOutputRemainsReadableAfterImmediateReturn() {
  console.log('\n馃搵 Test 2: output remains readable after immediate return...');
  const t0 = Date.now();
  const res = await terminalManager.executeCommand(
    `node -e "setInterval(function(){console.log('progress')},100);setTimeout(function(){},${PROC_LIFETIME_MS})"`,
    10000,
    undefined,
    true
  );
  const elapsed = Date.now() - t0;

  try {
    assert(elapsed < START_MAX_MS, `start_process should return in <${START_MAX_MS}ms, took ${elapsed}ms`);
    await sleep(350);

    const output = terminalManager.readOutputPaginated(res.pid, 0, 100);
    assert(output, 'running session output should be readable');
    assert(output.lines.join('\n').includes('progress'), 'buffer should contain process output');
    assert.strictEqual(output.isComplete, false, 'process should still be running');
    console.log(`  鉁?returned in ${elapsed}ms and buffered output remained readable`);
  } finally {
    cleanup(res.pid);
  }
}

async function testCompletedProcessRemainsReadable() {
  console.log('\n馃搵 Test 3: completed process output remains readable...');
  const t0 = Date.now();
  const res = await terminalManager.executeCommand(
    `node -e "setTimeout(function(){console.log('done')},150)"`,
    10000,
    undefined,
    true
  );
  const elapsed = Date.now() - t0;

  assert(elapsed < START_MAX_MS, `start_process should return in <${START_MAX_MS}ms, took ${elapsed}ms`);
  await sleep(500);

  const output = terminalManager.readOutputPaginated(res.pid, 0, 100);
  assert(output, 'completed session should remain readable');
  assert.strictEqual(output.isComplete, true, 'process should have completed');
  assert.strictEqual(output.exitCode, 0, 'process should exit successfully');
  assert(output.lines.join('\n').includes('done'), 'completed output should contain done');
  console.log(`  鉁?returned in ${elapsed}ms; completion and output were retained`);
}

async function runAllTests() {
  console.log('馃殌 Starting immediate start_process regression tests...');
  try {
    await testSilentProcessReturnsImmediately();
    await testOutputRemainsReadableAfterImmediateReturn();
    await testCompletedProcessRemainsReadable();
    console.log('\n馃帀 All immediate start_process tests passed!');
    return true;
  } catch (error) {
    console.error('\n鉂?Test failed:', error.message);
    console.error(error.stack);
    return false;
  }
}

runIfMain(import.meta.url, runAllTests);
