/**
 * #196: while pytest -v collected its tests, its output ended in "collecting ... "
 * and start_process answered "🔄 Process N is waiting for input (detected:
 * "...")". A prompt was found anywhere in the last line of output, and generic
 * prompts such as "... " (Python's continuation prompt), "> " or "       "
 * (Julia's continuation) are ordinary text inside a longer line.
 *
 * Checks the issue's own output (fixtures/pytest-196.js; only the reporter's path
 * replaced with a neutral one) against the detection,
 * then through start_process; and that real prompts are still detected: a REPL's
 * prompt as the whole last line, the prompts a REPL wrote one after another to
 * stderr (">>> ... "), a named prompt ("done>>> ") or a shell prompt
 * ("user@Mac project % ") at its end, and the prompts real Windows shells print
 * (fixtures/windows-shell-prompts.js: powershell.exe, pwsh, cmd.exe, captured from
 * real sessions; only the working directory in them was replaced with a neutral
 * one). Then interact_with_process in a real shell session returns at its
 * prompt: PowerShell on Windows, bash on macOS and Linux (the pwsh preinstalled
 * on GitHub's Ubuntu runner wraps its prompt in terminal codes).
 *
 * Node 24's continuation prompt, "| " (fixtures/node-repl-prompts.js, captured
 * from node -i on Windows and macOS), is a prompt too, the way #196 counts a
 * generic one: in a last line made of prompts ("> | "). A session left at it
 * wasn't detected as waiting, so interact_with_process waited out its timeout.
 * A markdown table's lines ("| a | b |") are not prompts.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeProcessState } from '../dist/utils/process-detection.js';
import { startProcess, readProcessOutput, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { PYTEST_COLLECTING, PYTEST_PROGRESS_LINE } from './fixtures/pytest-196.js';
import { WINDOWS_SHELL_PROMPTS } from './fixtures/windows-shell-prompts.js';
import { NODE_24_SESSIONS } from './fixtures/node-repl-prompts.js';
import { runIfMain } from './helpers/run-if-main.js';

// node -i's captured output: its session at the continuation prompt after "function f() {", and the lines of the
// markdown table it printed (each as the last line, before its newline)
const NODE_24_CONTINUATION = NODE_24_SESSIONS.map(([os, banner, exchanges]) =>
  [`node -i (${os}) at its continuation prompt`, banner + exchanges[0][1]]);
const TABLE_LINES = NODE_24_SESSIONS[0][2][4][1].split('\n').slice(0, 3);

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pytest-196.js');
const SPLIT_LINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'split-line.js');
// The shell answers "echo hi" within a second or two; missing its prompt runs to
// the timeout, well past the limit, which a loaded machine still meets (under
// the 50 s wait ceiling, which would end the wait first)
const INTERACT_TIMEOUT_MS = 45_000;
const PROMPT_WITHIN_MS = 20_000;
// Deadline of a start that ends at the shell's or REPL's prompt
const START_DEADLINE_MS = 30_000;
// start_process waits these out: the processes print no prompt. A wait that
// ended before the output it judges came (a loaded machine) proves nothing, so
// that case runs once more, waiting four times as long.
const COLLECTING_WAIT_MS = 1_500;
const SPLIT_LINE_WAIT_MS = 3_000;

// Output that ends in ordinary text, not a prompt
const NOT_PROMPTS = [
  ['pytest -v while it collects (#196)', PYTEST_COLLECTING],
  ['a pytest progress line before its newline (padding, then "[100%]")', PYTEST_PROGRESS_LINE],
  ...TABLE_LINES.map((line) => [`a markdown table's line before its newline (${line})`, line]),
  // The first piece of a line, before the rest of it arrives (fixtures/split-line.js)
  ['a piece of a line ending in ">"', '<div>'],
  ['a piece of a line ending in "$"', 'costs 5$'],
  ['a piece of a line ending in "#"', 'see issue #'],
];

// Output that ends in a prompt
const PROMPTS = [
  ['python', 'x = 1\n>>> '],
  ['python continuation', 'def f():\n... '],
  ['python, after output without a newline', 'done>>> '],
  // A REPL that writes its prompts to stderr and doesn't echo input leaves them on one line there
  ['python -i prompts on stderr', '>>> >>> ... '],
  ['a shell\'s prompts on stderr', '$ $ '],
  ['node', '1\n> '],
  ...NODE_24_CONTINUATION,
  ['R continuation', '+ '],
  ['shell', '$ '],
  ['bash default', 'bash-5.2$ '],
  ['bash -i prompts on stderr', 'bash-5.2$ bash-5.2$ '],
  ['bash with user@host', 'user@host:~/project$ '],
  ['root shell', 'root@box:/# '],
  ['zsh default on macOS', 'user@Mac project % '],
  ['mysql', 'mysql> '],
  ['julia', 'julia> '],
  ['psql', 'postgres=# '],
  ...WINDOWS_SHELL_PROMPTS,
];

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
const failures = [];
function check(ok, message) {
  if (!ok) {
    failures.push(message);
    console.log(`❌ ${message}`);
  }
}

function testDetection() {
  console.log('\n--- detection: the issue\'s output is not a prompt ---');
  for (const [name, output] of NOT_PROMPTS) {
    const state = analyzeProcessState(output);
    check(!state.isWaitingForInput,
      `${name}: output ending in ${JSON.stringify(output.slice(-40))} was taken for a prompt (detected: ${JSON.stringify(state.detectedPrompt)})`);
  }
  console.log('\n--- detection: real prompts are still detected ---');
  for (const [name, output] of PROMPTS) {
    check(analyzeProcessState(output).isWaitingForInput, `${name}: the prompt ${JSON.stringify(output.split('\n').pop())} was not detected`);
  }
}

async function testStartProcess() {
  console.log('\n--- start_process + read_process_output: pytest collecting (#196) ---');
  for (const waitMs of [COLLECTING_WAIT_MS, COLLECTING_WAIT_MS * 4]) {
    const started = await startProcess({ command: 'node "' + FIXTURE + '"', timeout_ms: waitMs });
    const pid = started.structuredContent?.pid;
    try {
      check(pid > 0, 'start_process should return a PID, got: ' + started.content[0].text);
      check(started.structuredContent?.status === 'running',
        'spawn-only start_process should return running, got: ' + started.structuredContent?.status);
      const result = await readProcessOutput({ pid, timeout_ms: waitMs });
      const output = result.content[0].text;
      if (!output.includes('collecting ... ') && waitMs === COLLECTING_WAIT_MS) {
        console.log('the output came after the ' + waitMs + 'ms read; retrying with a longer read');
        continue;
      }
      check(output.includes('collecting ... '),
        'read_process_output should return pytest collection output, got: ' + output.slice(-200));
      check(!output.includes('waiting for input'),
        'pytest collection output is not a prompt, got: ' + output.slice(-160));
      return;
    } finally {
      if (pid > 0) await forceTerminate({ pid });
    }
  }
}
/**
 * A line that arrives in two pieces, the first ending like a prompt ("<div>",
 * "costs 5$", "see issue #"), is not a prompt: start_process must not end its
 * wait on that piece (it did, testing each output chunk on its own).
 */
async function testStartProcessOnAPieceOfALine() {
  console.log('\n--- read_process_output: a piece of a line that ends like a prompt ---');
  await Promise.all(['markup', 'dollar', 'hash'].map(async (piece) => {
    for (const waitMs of [SPLIT_LINE_WAIT_MS, SPLIT_LINE_WAIT_MS * 4]) {
      const started = await startProcess({ command: 'node "' + SPLIT_LINE + '" ' + piece, timeout_ms: waitMs });
      const pid = started.structuredContent?.pid;
      try {
        const first = await readProcessOutput({ pid, timeout_ms: waitMs });
        const firstText = first.content[0].text;
        const firstPiece = { markup: '<div>', dollar: 'costs 5$', hash: 'see issue #' }[piece];
        if (!firstText.includes(firstPiece) && waitMs === SPLIT_LINE_WAIT_MS) {
          console.log('"' + piece + '": first output came after ' + waitMs + 'ms; retrying');
          continue;
        }
        check(firstText.includes(firstPiece), 'the first piece should be returned, got: ' + JSON.stringify(firstText));
        check(!firstText.includes('waiting for input'), 'a partial line is not a prompt, got: ' + JSON.stringify(firstText));
        let combined = firstText;
        if (!combined.includes('and the rest of the line')) {
          const rest = await readProcessOutput({ pid, timeout_ms: waitMs * 4 });
          combined += '\n' + rest.content[0].text;
        }
        check(combined.includes('and the rest of the line'),
          'read_process_output should return the rest of the line after the prompt-like piece, got: ' + JSON.stringify(combined));
        return;
      } finally {
        if (pid > 0) await forceTerminate({ pid });
      }
    }
  }));
}
async function testInteractWithShell() {
  const [name, command] = process.platform === 'win32' ? ['PowerShell', 'powershell -NoLogo'] : ['bash', 'bash --norc --noprofile -i'];
  console.log(`\n--- interact_with_process: a real ${name} session ---`);
  const started = await startProcess({ command, timeout_ms: START_DEADLINE_MS });
  const pid = started.structuredContent?.pid;
  try {
    await readUntilPrompt(pid, START_DEADLINE_MS, name);
    check(started.structuredContent?.status === 'running',
      `start_process should report ${name} waiting at its prompt, got ${started.structuredContent?.status}: ${started.content[0].text.slice(-160)}`);
    const startedAt = Date.now();
    const answer = await interactWithProcess({ pid, input: 'echo hi', timeout_ms: INTERACT_TIMEOUT_MS });
    const ms = Date.now() - startedAt;
    const text = answer.content[0].text;
    check(ms < PROMPT_WITHIN_MS,
      `interact_with_process should return at ${name}'s prompt, took ${ms}ms (timeout ${INTERACT_TIMEOUT_MS}ms): ${text.slice(-160)}`);
    check(answer.structuredContent?.status === 'waiting_for_input', `status should be waiting_for_input, got ${answer.structuredContent?.status}`);
    check(text.includes('hi'), `${name}'s answer should be returned, got: ${text.slice(-160)}`);
  } finally {
    if (pid > 0) {
      // "exit" ends the shell session; force_terminate then ends whatever is left
      await interactWithProcess({ pid, input: 'exit', wait_for_prompt: false });
      await forceTerminate({ pid });
    }
  }
}

async function testInteractAtNodeContinuation() {
  console.log('\n--- interact_with_process: node -i at its continuation prompt ---');
  const started = await startProcess({ command: 'node -i', timeout_ms: START_DEADLINE_MS });
  const pid = started.structuredContent?.pid;
  try {
    await readUntilPrompt(pid, START_DEADLINE_MS, 'Node REPL');
    // [input, what the answer shows]: a statement typed a line at a time, then its result
    for (const [input, output] of [['function f() {', null], ['  return 1;', null], ['}', 'undefined'], ['f()', '1']]) {
      const startedAt = Date.now();
      const answer = await interactWithProcess({ pid, input, timeout_ms: INTERACT_TIMEOUT_MS });
      const ms = Date.now() - startedAt;
      const text = answer.content[0].text;
      check(ms < PROMPT_WITHIN_MS && answer.structuredContent?.status === 'waiting_for_input',
        `interact_with_process ${JSON.stringify(input)} should return at node's prompt, took ${ms}ms (timeout ${INTERACT_TIMEOUT_MS}ms), status ${answer.structuredContent?.status}: ${JSON.stringify(text)}`);
      check(output === null ? text.includes('📭 (No output produced)') : text.includes(`📤 Output:\n${output}\n`),
        `interact_with_process ${JSON.stringify(input)} should answer ${output === null ? 'with no output' : JSON.stringify(output)}, got: ${JSON.stringify(text)}`);
    }
  } finally {
    if (pid > 0) await forceTerminate({ pid });
  }
}

async function runTests() {
  testDetection();
  await testStartProcess();
  await testStartProcessOnAPieceOfALine();
  await testInteractAtNodeContinuation();
  await testInteractWithShell();
  console.log(failures.length === 0
    ? '\n✅ prompt detection tests passed'
    : `\n❌ ${failures.length} prompt detection checks failed`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);

export default runTests;
