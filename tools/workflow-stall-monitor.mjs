import fs from 'node:fs';
import path from 'node:path';

function workflowId(cmdRequestId) {
  const value = String(cmdRequestId ?? '');
  const slash = value.indexOf('/');
  return slash > 0 ? value.slice(0, slash) : value || null;
}

const WORKFLOW_EVENT_STAGES = new Map([
  ['dispatcher received command from control plane', 'command_arrived'],
  ['dispatcher received terminal response from MCP server', 'mcp_final_received'],
  ['dispatcher posting terminal response to control plane', 'final_post_started'],
  ['dispatcher terminal response accepted by control plane', 'final_post_accepted'],
]);

function lifecycleEvents(logPayload) {
  return (logPayload?.events ?? [])
    .map(event => {
      const stage = WORKFLOW_EVENT_STAGES.get(event?.message);
      if (!stage) return null;
      const attrs = event.attrs ?? {};
      const cmdRequestId = String(attrs.cmd_request_id ?? '');
      const workflow = workflowId(cmdRequestId);
      const observedAt = Date.parse(event.time);
      const polledAt = stage === 'command_arrived' ? Date.parse(attrs.polled_at ?? '') : NaN;
      const at = Number.isFinite(polledAt) ? polledAt : observedAt;
      if (!workflow || !Number.isFinite(at) || !Number.isFinite(observedAt)) return null;
      const observedTime = new Date(observedAt).toISOString();
      return {
        key: `${stage}|${observedTime}|${cmdRequestId}|${attrs.request_id ?? ''}`,
        stage,
        at,
        time: new Date(at).toISOString(),
        observedTime,
        polledAt: Number.isFinite(polledAt) ? new Date(polledAt).toISOString() : null,
        workflow,
        cmdRequestId,
        requestId: attrs.request_id ?? null,
        tunnelServiceRequestId: attrs.tunnel_request_id ?? attrs.tunnel_service_request_id ?? null,
        channel: attrs.channel ?? null,
        rpcMethod: attrs.rpc_method ?? null,
        statusCode: attrs.status_code ?? null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

function commandEvents(logPayload) {
  return lifecycleEvents(logPayload).filter(event => event.stage === 'command_arrived');
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
  constructor({ stallMs = 10_000, appendEvent = () => {}, appendLifecycleEvent = () => {} } = {}) {
    this.stallMs = stallMs;
    this.appendEvent = appendEvent;
    this.appendLifecycleEvent = appendLifecycleEvent;
    this.states = new Map();
    this.finalStates = new Map();
    this.recentCommands = [];
    this.seen = new Set();
    this.seenOrder = [];
    this.bootstrapped = false;
  }

  reset() {
    this.states.clear();
    this.finalStates.clear();
    this.recentCommands = [];
    this.seen.clear();
    this.seenOrder = [];
    this.bootstrapped = false;
  }

  observe({ logs, health, now = Date.now() }) {
    const events = lifecycleEvents(logs);
    const emit = this.bootstrapped;

    for (const event of events) {
      if (this.seen.has(event.key)) continue;
      this.remember(event);

      if (event.stage === 'command_arrived') {
        const pendingFinal = this.finalStates.get(event.workflow);
        if (pendingFinal && event.at > pendingFinal.acceptedAt && event.cmdRequestId !== pendingFinal.cmdRequestId) {
          const others = this.otherCommandsBetween(event.workflow, pendingFinal.acceptedAt, event.at);
          const postFinalGapMs = event.at - pendingFinal.acceptedAt;
          if (emit) {
            this.appendLifecycleEvent({
              kind: 'workflow_next_command_arrived',
              time: event.time,
              workflow: event.workflow,
              previous_final_accepted_time: pendingFinal.acceptedTime,
              previous_cmd_request_id: pendingFinal.cmdRequestId,
              previous_request_id: pendingFinal.requestId,
              next_cmd_request_id: event.cmdRequestId,
              next_request_id: event.requestId,
              next_command_polled_time: event.polledAt,
              next_command_observed_time: event.observedTime,
              post_final_gap_ms: postFinalGapMs,
            });
            if (pendingFinal.open) {
              this.appendEvent({
                kind: 'post_final_stall_recovered',
                time: event.time,
                workflow: event.workflow,
                final_accepted_time: pendingFinal.acceptedTime,
                previous_cmd_request_id: pendingFinal.cmdRequestId,
                previous_request_id: pendingFinal.requestId,
                next_command_time: event.time,
                next_command_polled_time: event.polledAt,
                next_command_observed_time: event.observedTime,
                next_cmd_request_id: event.cmdRequestId,
                next_request_id: event.requestId,
                post_final_gap_ms: postFinalGapMs,
                open_detected_at: pendingFinal.open.detectedAt,
                other_commands_during_gap: others.length,
                other_workflows_during_gap: new Set(others.map(item => item.workflow)).size,
                ...healthSummary(health),
              });
            }
          }
          this.finalStates.delete(event.workflow);
        } else if (emit) {
          this.appendLifecycleEvent({
            kind: 'workflow_command_arrived',
            time: event.time,
            workflow: event.workflow,
            cmd_request_id: event.cmdRequestId,
            request_id: event.requestId,
          });
        }

        const previous = this.states.get(event.workflow);
        if (emit && previous?.open) {
          const others = this.otherCommandsBetween(event.workflow, previous.lastCommandAt, event.at);
          this.appendEvent({
            kind: 'workflow_stall_recovered',
            time: event.time,
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
          eligible: emit || now - event.at < this.stallMs,
          open: null,
        });
        continue;
      }

      if (emit) {
        this.appendLifecycleEvent({
          kind: 'workflow_' + event.stage,
          time: event.time,
          workflow: event.workflow,
          cmd_request_id: event.cmdRequestId,
          request_id: event.requestId,
          tunnel_request_id: event.tunnelServiceRequestId,
          channel: event.channel,
          rpc_method: event.rpcMethod,
          status_code: event.statusCode,
        });
      }

      if (event.stage === 'final_post_accepted') {
        this.finalStates.set(event.workflow, {
          acceptedAt: event.at,
          acceptedTime: event.time,
          cmdRequestId: event.cmdRequestId,
          requestId: event.requestId,
          tunnelServiceRequestId: event.tunnelServiceRequestId,
          commandCount: this.states.get(event.workflow)?.commandCount ?? 0,
          eligible: emit || now - event.at < this.stallMs,
          open: null,
        });
      }
    }
    this.bootstrapped = true;

    for (const [workflow, state] of this.states) {
      if (!state.eligible || state.open || now - state.lastCommandAt < this.stallMs) continue;
      const others = this.otherCommandsBetween(workflow, state.lastCommandAt, now);
      if (others.length === 0) continue;
      const open = { detectedAt: new Date(now).toISOString() };
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

    for (const [workflow, state] of this.finalStates) {
      if (!state.eligible || state.open || now - state.acceptedAt < this.stallMs) continue;
      const others = this.otherCommandsBetween(workflow, state.acceptedAt, now);
      if (others.length === 0) continue;
      const open = { detectedAt: new Date(now).toISOString() };
      state.open = open;
      this.appendEvent({
        kind: 'post_final_stall_open',
        time: open.detectedAt,
        workflow,
        final_accepted_time: state.acceptedTime,
        previous_cmd_request_id: state.cmdRequestId,
        previous_request_id: state.requestId,
        tunnel_request_id: state.tunnelServiceRequestId,
        post_final_gap_ms_at_detection: now - state.acceptedAt,
        threshold_ms: this.stallMs,
        command_count: state.commandCount,
        other_commands_since_final: others.length,
        other_workflows_since_final: new Set(others.map(item => item.workflow)).size,
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
    if (event.stage === 'command_arrived') this.recentCommands.push(event);
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
    lifecycleLogPath,
    stallMs = 10_000,
    intervalMs = 2_000,
    logLimit = 1_000,
    fetchImpl = globalThis.fetch,
  }) {
    this.healthUrlFile = healthUrlFile;
    this.logPath = logPath;
    this.lifecycleLogPath = lifecycleLogPath;
    this.intervalMs = intervalMs;
    this.logLimit = logLimit;
    this.fetchImpl = fetchImpl;
    this.running = false;
    this.timer = null;
    this.inSample = false;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (lifecycleLogPath) fs.mkdirSync(path.dirname(lifecycleLogPath), { recursive: true });
    this.tracker = new WorkflowStallTracker({
      stallMs,
      appendEvent: event => {
        fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n', 'utf8');
      },
      appendLifecycleEvent: event => {
        if (this.lifecycleLogPath) fs.appendFileSync(this.lifecycleLogPath, JSON.stringify(event) + '\n', 'utf8');
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

export { commandEvents, lifecycleEvents, healthSummary, workflowId };
