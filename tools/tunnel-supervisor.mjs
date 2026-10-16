#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkflowStallMonitor } from './workflow-stall-monitor.mjs';

const DEFAULT_RESTART_DELAY_MS = 1500;
const DEFAULT_PROXY_HOST = '127.0.0.1';
const DEFAULT_PROXY_PORT = 8765;
const DEFAULT_WORKFLOW_STALL_MS = 10_000;
const DEFAULT_WORKFLOW_MONITOR_INTERVAL_MS = 2_000;
const DEFAULT_WORKFLOW_LOG_LIMIT = 1_000;
const DEFAULT_DIAGNOSTICS_DIR = path.join(os.homedir(), '.claude-server-commander', 'tunnel-diagnostics');

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
const workflowMonitorEnabled = resilientProxyEnabled && !envEnabled('TUNNEL_WORKFLOW_MONITOR_DISABLE');
const proxyHost = process.env.DC_RESILIENT_MCP_HOST || DEFAULT_PROXY_HOST;
const proxyPort = parseNonNegativeInt('DC_RESILIENT_MCP_PORT', DEFAULT_PROXY_PORT);
const workflowStallMs = parseNonNegativeInt('TUNNEL_WORKFLOW_STALL_MS', DEFAULT_WORKFLOW_STALL_MS);
const workflowMonitorIntervalMs = Math.max(500, parseNonNegativeInt('TUNNEL_WORKFLOW_MONITOR_INTERVAL_MS', DEFAULT_WORKFLOW_MONITOR_INTERVAL_MS));
const workflowLogLimit = Math.max(100, parseNonNegativeInt('TUNNEL_WORKFLOW_LOG_LIMIT', DEFAULT_WORKFLOW_LOG_LIMIT));
const diagnosticsDir = process.env.DC_RESILIENT_MCP_DIAGNOSTICS_DIR || DEFAULT_DIAGNOSTICS_DIR;
const healthUrlFile = process.env.HEALTH_URL_FILE || path.join(diagnosticsDir, 'tunnel-health-url.txt');
const workflowStallLog = path.join(diagnosticsDir, 'workflow-stalls.jsonl');

let child = null;
let proxy = null;
let workflowMonitor = null;
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

function startWorkflowMonitor() {
  if (!workflowMonitorEnabled || workflowMonitor) return;
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  workflowMonitor = new WorkflowStallMonitor({
    healthUrlFile,
    logPath: workflowStallLog,
    stallMs: workflowStallMs,
    intervalMs: workflowMonitorIntervalMs,
    logLimit: workflowLogLimit,
  });
  workflowMonitor.start();
  process.stderr.write(`[tunnel-supervisor] workflow stall monitor -> ${workflowStallLog}\n`);
}

function stopWorkflowMonitor() {
  const current = workflowMonitor;
  workflowMonitor = null;
  current?.stop();
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
      stopWorkflowMonitor();
      resolve(result);
    };

    if (workflowMonitorEnabled) {
      fs.mkdirSync(diagnosticsDir, { recursive: true });
      try { fs.rmSync(healthUrlFile, { force: true }); } catch {}
    }

    child = spawn(executable, args, {
      env: {
        ...process.env,
        ...(workflowMonitorEnabled ? { HEALTH_URL_FILE: healthUrlFile } : {}),
      },
      stdio: 'inherit',
      windowsHide: false,
    });
    startWorkflowMonitor();

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
  stopWorkflowMonitor();
  await stopProxy();
}
