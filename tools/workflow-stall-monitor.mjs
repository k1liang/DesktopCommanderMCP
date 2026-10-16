import fs from 'node:fs';
import path from 'node:path';

function workflowId(cmdRequestId) {
  const value = String(cmdRequestId ?? '');
  const slash = value.indexOf('/');
  return slash > 0 ? value.slice(0, slash) : value || null;
}

function commandEvents(logPayload) {
  return (logPayload?.events ?? [])
    .filter(event => event?.message === 'dispatcher forwarded command to MCP server')
    .map(event => {
      const attrs = event.attrs ?? {};
      const cmdRequestId = String(attrs.cmd_request_id ?? '');
      const workflow = workflowId(cmdRequestId);
      const at = Date.parse(event.time);
      if (!workflow || !Number.isFinite(at)) return null;
      return {
        key: `${event.time}|${cmdRequestId}|${attrs.request_id ?? ''}`,
        at,
        time: event.time,
        workflow,
        cmdRequestId,
        requestId: attrs.request_id ?? null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

function healthSummary(health) {
  const components = health?.components ?? {};
  const dispatcher = components.dispatcher?.details ?? {};
  const queue = components.queue?.details ?? {};
  const delivery = components['response-delivery']?.details ?? {};
  const control = components['control-plane']?.details ?? {};
  return {
    dispatcher_active: dispatcher.active ?? null,
    dispatcher_pool_limit: dispatcher.pool_limit ?? null,
    dispatcher_failures: dispatcher.failures ?? null,
    dispatcher_timeouts: dispatcher.timeouts ?? null,
    queue_depth: queue.depth ?? null,
    queue_backpressure_seconds: queue.backpressure_seconds ?? null,
    response_in_progress: delivery.in_progress ?? null,
    response_retries: delivery.retries ?? null,
    response_terminal_failures: delivery.terminal_failures ?? null,
    control_plane_consecutive_failures: control.consecutive_failures ?? null,
  };
}

export class WorkflowStallTracker {
  constructor({ stallMs = 10_000, appendEvent = () => {} } = {}) {
    this.stallMs = stallMs;
    this.appendEvent = appendEvent;
    this.states = new Map();
    this.recentCommands = [];
    this.seen = new Set();
    this.seenOrder = [];
    this.bootstrapped = false;
  }

  reset() {
    this.states.clear();
    this.recentCommands = [];
    this.seen.clear();
    this.seenOrder = [];
    this.bootstrapped = false;
  }

  observe({ logs, health, now = Date.now() }) {
    const events = commandEvents(logs);
    if (!this.bootstrapped) {
      for (const event of events) {
        this.remember(event);
        this.states.set(event.workflow, {
          lastCommandAt: event.at,
          lastCommandTime: event.time,
          lastCmdRequestId: event.cmdRequestId,
          lastRequestId: event.requestId,
          commandCount: (this.states.get(event.workflow)?.commandCount ?? 0) + 1,
          eligible: now - event.at < this.stallMs,
          open: null,
        });
      }
      this.bootstrapped = true;
    } else {
      for (const event of events) {
        if (this.seen.has(event.key)) continue;
        this.remember(event);
        const previous = this.states.get(event.workflow);
        if (previous?.open) {
          const others = this.otherCommandsBetween(event.workflow, previous.lastCommandAt, event.at);
          this.appendEvent({
            kind: 'workflow_stall_recovered',
            time: new Date(event.at).toISOString(),
            workflow: event.workflow,
            previous_command_time: previous.lastCommandTime,
            previous_cmd_request_id: previous.lastCmdRequestId,
            previous_request_id: previous.lastRequestId,
            next_command_time: event.time,
            next_cmd_request_id: event.cmdRequestId,
            next_request_id: event.requestId,
            gap_ms: event.at - previous.lastCommandAt,
            open_detected_at: previous.open.detectedAt,
            other_commands_during_gap: others.length,
            other_workflows_during_gap: new Set(others.map(item => item.workflow)).size,
            ...healthSummary(health),
          });
        }
        this.states.set(event.workflow, {
          lastCommandAt: event.at,
          lastCommandTime: event.time,
          lastCmdRequestId: event.cmdRequestId,
          lastRequestId: event.requestId,
          commandCount: (previous?.commandCount ?? 0) + 1,
          eligible: true,
          open: null,
        });
      }
    }

    for (const [workflow, state] of this.states) {
      if (!state.eligible || state.open || now - state.lastCommandAt < this.stallMs) continue;
      const others = this.otherCommandsBetween(workflow, state.lastCommandAt, now);
      if (others.length === 0) continue;
      const open = {
        detectedAt: new Date(now).toISOString(),
      };
      state.open = open;
      this.appendEvent({
        kind: 'workflow_stall_open',
        time: open.detectedAt,
        workflow,
        previous_command_time: state.lastCommandTime,
        previous_cmd_request_id: state.lastCmdRequestId,
        previous_request_id: state.lastRequestId,
        gap_ms_at_detection: now - state.lastCommandAt,
        threshold_ms: this.stallMs,
        command_count: state.commandCount,
        other_commands_since_previous: others.length,
        other_workflows_since_previous: new Set(others.map(item => item.workflow)).size,
        candidate_only: true,
        ...healthSummary(health),
      });
    }

    const cutoff = now - Math.max(this.stallMs * 30, 10 * 60_000);
    this.recentCommands = this.recentCommands.filter(event => event.at >= cutoff);
  }

  remember(event) {
    this.seen.add(event.key);
    this.seenOrder.push(event.key);
    this.recentCommands.push(event);
    while (this.seenOrder.length > 10_000) {
      this.seen.delete(this.seenOrder.shift());
    }
  }

  otherCommandsBetween(workflow, fromExclusive, toExclusive) {
    return this.recentCommands.filter(event =>
      event.workflow !== workflow &&
      event.at > fromExclusive &&
      event.at < toExclusive
    );
  }
}

export class WorkflowStallMonitor {
  constructor({
    healthUrlFile,
    logPath,
    stallMs = 10_000,
    intervalMs = 2_000,
    logLimit = 1_000,
    fetchImpl = globalThis.fetch,
  }) {
    this.healthUrlFile = healthUrlFile;
    this.logPath = logPath;
    this.intervalMs = intervalMs;
    this.logLimit = logLimit;
    this.fetchImpl = fetchImpl;
    this.running = false;
    this.timer = null;
    this.inSample = false;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    this.tracker = new WorkflowStallTracker({
      stallMs,
      appendEvent: event => {
        fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n', 'utf8');
      },
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.sample();
    this.timer = setInterval(() => { void this.sample(); }, this.intervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tracker.reset();
  }

  async sample() {
    if (!this.running || this.inSample) return;
    this.inSample = true;
    try {
      let baseUrl;
      try {
        baseUrl = fs.readFileSync(this.healthUrlFile, 'utf8').trim().replace(/\/$/, '');
      } catch {
        return;
      }
      if (!baseUrl) return;

      const [logsResponse, healthResponse] = await Promise.all([
        this.fetchImpl(`${baseUrl}/api/logs?limit=${this.logLimit}`),
        this.fetchImpl(`${baseUrl}/health?details=true`),
      ]);
      if (!logsResponse.ok || !healthResponse.ok) return;
      const [logs, health] = await Promise.all([logsResponse.json(), healthResponse.json()]);
      this.tracker.observe({ logs, health, now: Date.now() });
    } catch (error) {
      process.stderr.write(`[tunnel-supervisor] workflow monitor warning: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      this.inSample = false;
    }
  }
}

export { commandEvents, healthSummary, workflowId };
