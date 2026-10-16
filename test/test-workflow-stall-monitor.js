import assert from 'node:assert/strict';
import { WorkflowStallTracker } from '../tools/workflow-stall-monitor.mjs';
import { runIfMain } from './helpers/run-if-main.js';

function event(time, workflow, suffix) {
  return {
    time,
    message: 'dispatcher forwarded command to MCP server',
    attrs: {
      cmd_request_id: `${workflow}/${suffix}`,
      request_id: `cmd_${workflow}_${suffix}`,
    },
  };
}

async function runTests() {
  const emitted = [];
  const tracker = new WorkflowStallTracker({
    stallMs: 10_000,
    appendEvent: value => emitted.push(value),
  });

  const t0 = Date.parse('2026-10-16T10:00:00.000Z');
  const workflowA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const workflowB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const health = {
    components: {
      dispatcher: { details: { active: 1, pool_limit: 8, failures: 0, timeouts: 0 } },
      queue: { details: { depth: 0, backpressure_seconds: 0 } },
      'response-delivery': { details: { in_progress: 0, retries: 0, terminal_failures: 0 } },
      'control-plane': { details: { consecutive_failures: 0 } },
    },
  };

  tracker.observe({
    logs: { events: [
      event(new Date(t0).toISOString(), workflowA, 'a1'),
      event(new Date(t0 + 1_000).toISOString(), workflowB, 'b1'),
    ] },
    health,
    now: t0 + 2_000,
  });

  tracker.observe({
    logs: { events: [
      event(new Date(t0).toISOString(), workflowA, 'a1'),
      event(new Date(t0 + 1_000).toISOString(), workflowB, 'b1'),
      event(new Date(t0 + 9_000).toISOString(), workflowB, 'b2'),
    ] },
    health,
    now: t0 + 11_000,
  });

  const open = emitted.find(value => value.kind === 'workflow_stall_open' && value.workflow === workflowA);
  assert.ok(open, 'workflow A should be marked as an open stall candidate');
  assert.equal(open.other_commands_since_previous, 2);
  assert.equal(open.other_workflows_since_previous, 1);
  assert.equal(open.queue_depth, 0);
  assert.equal(emitted.some(value => value.kind === 'workflow_stall_open' && value.workflow === workflowB), false);

  tracker.observe({
    logs: { events: [
      event(new Date(t0).toISOString(), workflowA, 'a1'),
      event(new Date(t0 + 1_000).toISOString(), workflowB, 'b1'),
      event(new Date(t0 + 9_000).toISOString(), workflowB, 'b2'),
      event(new Date(t0 + 15_000).toISOString(), workflowA, 'a2'),
    ] },
    health,
    now: t0 + 15_100,
  });

  const recovered = emitted.find(value => value.kind === 'workflow_stall_recovered' && value.workflow === workflowA);
  assert.ok(recovered, 'workflow A should emit a recovery event');
  assert.equal(recovered.gap_ms, 15_000);
  assert.equal(recovered.other_commands_during_gap, 2);
  assert.equal(recovered.other_workflows_during_gap, 1);

  console.log('PASS: workflow stall tracker records open and recovered per-workflow gaps');
  return true;
}

runIfMain(import.meta.url, runTests);
