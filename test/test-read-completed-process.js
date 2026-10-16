import assert from 'assert';
import { startProcess, readProcessOutput } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

/**
 * Proper test for read_process_output on completed processes
 * 
 * This test should:
 * - FAIL when the bug exists (current behavior)  
 * - PASS when the bug is fixed (desired behavior)
 */
async function testReadCompletedProcessOutput() {
  console.log('Testing read_process_output on completed process...');
  
  // Start echo command with delay, but timeout before echo happens
  const startResult = await startProcess({
    // Cross-platform delay + output using Node
    command: 'node -e "setTimeout(() => console.log(\'SUCCESS MESSAGE\'), 1000)"',
    timeout_ms: 500  // Returns before the output happens
  });
  
  const pid = startResult.structuredContent?.pid;
  assert(pid, 'Should get PID from start_process');
  
  // Wait for the actual command to complete
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Try to read the output - this should work when fixed
  const readResult = await readProcessOutput({ pid, timeout_ms: 1000 });
  
  // ASSERT: Should be able to read from completed process
  assert(!readResult.isError, 
    'Should be able to read from completed process without error');
    
  // ASSERT: Should contain the echo output
  assert(readResult.content[0].text.includes('SUCCESS MESSAGE'), 
    'Should contain the echo output from completed process');
    
  console.log('✅ Successfully read from completed process');
  console.log('✅ Retrieved echo output:', readResult.content[0].text);
}

async function waitForFinished(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (terminalManager.getProcessState(pid)?.isFinished) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Process ${pid} did not finish within ${timeoutMs}ms`);
}

/**
 * Test unread completed-session retention beyond the old global cap.
 */
async function testRetentionAcrossCompletedProcessChurn() {
  console.log('Testing unread completed-process retention across churn...');

  const first = await startProcess({
    command: 'node -e "console.log(\'RETENTION SENTINEL\')"',
    timeout_ms: 1000
  });
  const firstPid = first.structuredContent?.pid;
  assert(firstPid, 'Should get PID for retention sentinel');
  await waitForFinished(firstPid);

  // TypeScript private members are ordinary properties in emitted JS. Use them
  // here to exercise the retention policy without spawning thousands of real
  // processes (the old global cap was 100; the new hard cap is 2048).
  const completedSessions = terminalManager.completedSessions;
  const trimCompletedSessions = terminalManager.trimCompletedSessions.bind(terminalManager);
  const sentinel = completedSessions.get(firstPid);
  assert(sentinel, 'Sentinel should already be archived as a completed session');

  const fakePids = [];
  const fakeBase = 2_000_000_000;
  for (let i = 0; i < 2048; i += 1) {
    const pid = fakeBase + i;
    fakePids.push(pid);
    completedSessions.set(pid, {
      ...sentinel,
      endTime: new Date(sentinel.endTime.getTime() + i + 1),
      fullyReadTime: i === 0 ? new Date() : undefined,
    });
  }

  trimCompletedSessions();

  assert(completedSessions.has(firstPid), 'Unread sentinel must survive completed-session churn');
  assert(!completedSessions.has(fakeBase), 'Hard-cap trimming should evict an already-read session first');

  const readResult = await readProcessOutput({ pid: firstPid, timeout_ms: 1000 });
  assert(!readResult.isError, 'Unread completed session should remain readable');
  assert(readResult.content[0].text.includes('RETENTION SENTINEL'), 'Retained session should keep its final output');

  for (const pid of fakePids) completedSessions.delete(pid);
  console.log('✅ Unread completed session survives churn and read sessions are evicted first');
}

async function testImmediateCompletion() {
  console.log('Testing immediate completion...');
  
  const startResult = await startProcess({
    command: 'node -e "console.log(\'IMMEDIATE OUTPUT\')"',
    timeout_ms: 2000
  });
  
  const pid = startResult.structuredContent?.pid;
  assert(pid, 'Should get PID from start_process');
  
  // Small delay to ensure process completed
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Should be able to read from immediately completed process
  const readResult = await readProcessOutput({ pid, timeout_ms: 1000 });
  
  assert(!readResult.isError, 
    'Should be able to read from immediately completed process');
    
  assert(readResult.content[0].text.includes('IMMEDIATE OUTPUT'), 
    'Should contain immediate output from completed process');
    
  console.log('✅ Successfully read from immediately completed process');
}

// Run tests
async function runTests() {
  try {
    await testReadCompletedProcessOutput();
    await testRetentionAcrossCompletedProcessChurn();
    await testImmediateCompletion();
    console.log('\n🎉 All tests passed - read_process_output works on completed processes!');
    return true;
  } catch (error) {
    console.log('\n❌ Test failed:', error.message);
    console.log('\n💡 This indicates the bug still exists:');
    console.log('   read_process_output cannot read from completed processes');
    console.log('   Expected behavior: Should return completion info and final output');
    return false;
  }
}

runIfMain(import.meta.url, runTests);
