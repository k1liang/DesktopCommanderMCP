#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_RESTART_DELAY_MS = 1500;
const DEFAULT_PROXY_HOST = '127.0.0.1';
const DEFAULT_PROXY_PORT = 8765;

function parseNonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    process.stderr.write(`[tunnel-supervisor] invalid ${name}=${raw}; using ${fallback}\n`);
    return fallback;
  }
  return value;
}

function envEnabled(name) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

const restartDelayMs = parseNonNegativeInt('TUNNEL_SUPERVISOR_RESTART_DELAY_MS', DEFAULT_RESTART_DELAY_MS);
const maxRestarts = parseNonNegativeInt('TUNNEL_SUPERVISOR_MAX_RESTARTS', 0);
const [executable, ...args] = process.argv.slice(2);

if (!executable) {
  process.stderr.write('Usage: node tools/tunnel-supervisor.mjs <tunnel-client> <command> [args...]\n');
  process.exit(2);
}

const oneShot = envEnabled('TUNNEL_SUPERVISOR_ONESHOT');
const resilientProxyEnabled = envEnabled('TUNNEL_RESILIENT_PROXY');
const proxyHost = process.env.DC_RESILIENT_MCP_HOST || DEFAULT_PROXY_HOST;
const proxyPort = parseNonNegativeInt('DC_RESILIENT_MCP_PORT', DEFAULT_PROXY_PORT);

let child = null;
let proxy = null;
let stopping = false;
let restartCount = 0;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function startProxy() {
  if (!resilientProxyEnabled || proxy) return;

  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const repoDir = path.resolve(toolsDir, '..');
  const moduleUrl = pathToFileURL(path.join(repoDir, 'dist', 'resilient-mcp-proxy.js')).href;
  const { startResilientMcpProxy } = await import(moduleUrl);

  proxy = await startResilientMcpProxy({
    host: proxyHost,
    port: proxyPort,
  });

  process.stderr.write(`[tunnel-supervisor] resilient MCP proxy ready at ${proxy.url}\n`);
}

async function stopProxy() {
  const current = proxy;
  proxy = null;
  if (!current) return;
  try {
    await current.close();
  } catch (error) {
    process.stderr.write(`[tunnel-supervisor] proxy shutdown warning: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function requestStop(signal) {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill(signal); } catch {}
  }
}

process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

async function runOnce() {
  return await new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child = spawn(executable, args, {
      env: process.env,
      stdio: 'inherit',
      windowsHide: false,
    });

    child.once('error', error => settle({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => settle({ code, signal, error: null }));
  });
}

try {
  await startProxy();

  for (;;) {
    const attempt = restartCount + 1;
    process.stderr.write(`[tunnel-supervisor] starting tunnel-client (attempt ${attempt})\n`);
    const result = await runOnce();
    child = null;

    if (stopping) {
      process.exitCode = result.code ?? 0;
      break;
    }

    if (!result.error && result.code === 0) {
      process.exitCode = 0;
      break;
    }

    if (oneShot) {
      const reason = result.error?.message ?? `exit code ${result.code ?? 'null'}, signal ${result.signal ?? 'none'}`;
      process.stderr.write(`[tunnel-supervisor] tunnel-client stopped (${reason}); one-shot mode\n`);
      process.exitCode = result.code ?? 1;
      break;
    }

    if (maxRestarts > 0 && restartCount >= maxRestarts) {
      const reason = result.error?.message ?? `exit code ${result.code ?? 'null'}, signal ${result.signal ?? 'none'}`;
      process.stderr.write(`[tunnel-supervisor] tunnel-client stopped (${reason}); restart limit reached\n`);
      process.exitCode = result.code ?? 1;
      break;
    }

    restartCount += 1;
    const reason = result.error?.message ?? `exit code ${result.code ?? 'null'}, signal ${result.signal ?? 'none'}`;
    process.stderr.write(`[tunnel-supervisor] tunnel-client stopped (${reason}); restarting in ${restartDelayMs}ms\n`);
    await sleep(restartDelayMs);
  }
} catch (error) {
  process.stderr.write(`[tunnel-supervisor] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await stopProxy();
}
