import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(testDir, '..');
const supervisor = path.join(repo, 'tools', 'tunnel-supervisor.mjs');
const fixture = path.join(testDir, 'fixtures', 'tunnel-supervisor-child.js');

const windowsRun = fs.readFileSync(path.join(repo, 'tools', 'windows', 'tunnel-run.bat'), 'utf8');
const windowsInit = fs.readFileSync(path.join(repo, 'tools', 'windows', 'tunnel-init.bat'), 'utf8');
const macRun = fs.readFileSync(path.join(repo, 'tools', 'mac', 'tunnel-run.sh'), 'utf8');
const macInit = fs.readFileSync(path.join(repo, 'tools', 'mac', 'tunnel-init.sh'), 'utf8');

assert.match(windowsRun, /TUNNEL_RESILIENT_PROXY=1/, 'Windows run script must enable the resilient HTTP proxy');
assert.match(windowsRun, /tunnel-supervisor\.mjs/, 'Windows run script must launch tunnel-client through the supervisor');
assert.doesNotMatch(windowsRun, /mcp\.stdio-send-initialized-notification/, 'Windows run must not use the stdio lifecycle guard');
assert.match(windowsInit, /sample_mcp_remote_no_auth/, 'Windows tunnel profile must use an HTTP MCP sample');
assert.match(windowsInit, /--mcp-server-url/, 'Windows tunnel profile must target the local HTTP proxy');
assert.match(windowsInit, /init --force /, 'Windows init must replace the existing stdio profile during migration');
assert.match(windowsInit, /--health-listen-addr \"127\.0\.0\.1:0\"/, 'Windows init must avoid colliding with an already-running Tunnel health listener');

assert.match(macRun, /TUNNEL_RESILIENT_PROXY=1/, 'Mac run script must enable the resilient HTTP proxy');
assert.match(macRun, /tunnel-supervisor\.mjs/, 'Mac run script must launch tunnel-client through the supervisor');
assert.doesNotMatch(macRun, /mcp\.stdio-send-initialized-notification/, 'Mac run must not use the stdio lifecycle guard');
assert.match(macInit, /sample_mcp_remote_no_auth/, 'Mac init must use an HTTP MCP sample');
assert.match(macInit, /--mcp-server-url/, 'Mac init must target the local HTTP proxy');
assert.match(macInit, /init --force /, 'Mac init must replace the existing stdio profile');
assert.match(macInit, /TUNNEL_SUPERVISOR_ONESHOT=1/, 'Mac init doctor must run through a one-shot proxy supervisor');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-tunnel-supervisor-'));
const statePath = path.join(tempDir, 'attempts.txt');

try {
  const result = spawnSync(process.execPath, [supervisor, process.execPath, fixture, statePath, '2'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      TUNNEL_SUPERVISOR_RESTART_DELAY_MS: '10',
      TUNNEL_SUPERVISOR_MAX_RESTARTS: '3',
      TUNNEL_RESILIENT_PROXY: '0',
    },
    timeout: 10000,
  });

  assert.equal(result.status, 0, `supervisor failed: ${result.stderr}`);
  assert.equal(fs.readFileSync(statePath, 'utf8'), '3', 'child should run twice unsuccessfully and then succeed');
  assert.equal((result.stderr.match(/restarting in/g) ?? []).length, 2, 'expected two restart messages');
  assert.match(result.stderr, /starting tunnel-client \(attempt 3\)/);
  console.log('PASS: tunnel supervisor preserves restart behavior and Windows/macOS use resilient HTTP MCP');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
