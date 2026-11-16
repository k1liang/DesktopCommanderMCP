/**
 * Specialized test for Node.js REPL interaction
 * Drives a Node.js REPL through the MCP tools a client uses: start_process
 * starts `node -i` and interact_with_process sends a single-line command and a
 * multi-line block, checking the output of each.
 */

import assert from 'assert';
import { startProcess, readProcessOutput, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { runIfMain } from './helpers/run-if-main.js';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

// Multi-line block: the REPL buffers it until the statements are complete
const MULTILINE_CODE = [
  'function greet(name) {',
  '  return `Hello, ${name}!`;',
  '}',
  '',
  'for (let i = 0; i < 3; i++) {',
  '  console.log(greet(`User ${i}`));',
  '}',
].join('\n');

/**
 * Test Node.js REPL interaction through start_process / interact_with_process
 */
async function testNodeREPL() {
async function readUntilPrompt(pid, timeoutMs, name) {
  const deadline = Date.now() + timeoutMs;
  let output = '';
  while (Date.now() < deadline) {
    const result = await readProcessOutput({
      pid,
      timeout_ms: Math.max(1, Math.min(1_000, deadline - Date.now())),
    });
    output += result.content.map((part) => part.text ?? '').join('\n') + '\n';
    if (output.includes('waiting for input')) return output;
  }
  throw new Error(name + ' did not reach a prompt: ' + output.slice(-300));
}
  console.log(`${colors.blue}Node.js REPL test via MCP tools...${colors.reset}`);

  const started = await startProcess({ command: 'node -i', timeout_ms: 5000 });
  const pid = started.structuredContent?.pid;
  assert(pid, `start_process should start the Node.js REPL, got: ${started.content[0].text}`);
  console.log(`${colors.green}✓ Started Node.js REPL with PID ${pid}${colors.reset}`);

  try {
    await readUntilPrompt(pid, 10_000, 'Node REPL');
    // Single-line command
    const single = await interactWithProcess({
      pid,
      input: 'console.log("Hello from Node.js!");',
      timeout_ms: 5000
    });
    const singleOutput = single.content[0].text;
    assert(singleOutput.includes('Hello from Node.js!'), `Single-line command output missing, got: ${singleOutput}`);
    console.log(`${colors.green}✓ Single-line command output received${colors.reset}`);

    // Multi-line block
    const multi = await interactWithProcess({ pid, input: MULTILINE_CODE, timeout_ms: 5000 });
    const multiOutput = multi.content[0].text;
    for (const greeting of ['Hello, User 0!', 'Hello, User 1!', 'Hello, User 2!']) {
      assert(multiOutput.includes(greeting), `Multi-line block output should include "${greeting}", got: ${multiOutput}`);
    }
    console.log(`${colors.green}✓ Multi-line block output received${colors.reset}`);
  } finally {
    await forceTerminate({ pid });
  }
}

runIfMain(import.meta.url, testNodeREPL);
