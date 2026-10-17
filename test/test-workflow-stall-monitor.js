import assert from 'node:assert/strict';
import { WorkflowStallTracker } from '../tools/workflow-stall-monitor.mjs';
import { runIfMain } from './helpers/run-if-main.js';

function event(time, workflow, suffix, extra = {}) {
  return {
    time,
    message: 'dispatcher received command from control plane',
    attrs: {
      cmd_request_id: `${workflow}/${suffix}`,
      request_id: `cmd_${workflow}_${suffix}`,
      ...extra,
    },
  };
}

function forwardedEvent(time, workflow, suffix) {
  return {
    time,
    message: 'dispatcher forwarded command to MCP server',
    attrs: {
      cmd_request_id: `${workflow}/${suffix}`,
      request_id: `cmd_${workflow}_${suffix}`,
    },
  };
}

function lifecycleEvent(time, message, workflow, suffix, extra = {}) {
  return {
    time,
    message,
    attrs: {
      cmd_request_id: `${workflow}/${suffix}`,
      request_id: `cmd_${workflow}_${suffix}`,
      channel: 'main',
      rpc_method: 'tools/call',
      ...extra,
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

  const precise = [];
  const lifecycle = [];
  const preciseTracker = new WorkflowStallTracker({
    stallMs: 10_000,
    appendEvent: value => precise.push(value),
    appendLifecycleEvent: value => lifecycle.push(value),
  });
  const p0 = t0 + 30_000;
  preciseTracker.observe({
    logs: { events: [
      event(new Date(p0).toISOString(), workflowA, 'p1'),
      event(new Date(p0 + 1_000).toISOString(), workflowB, 'pb1'),
    ] },
    health,
    now: p0 + 2_000,
  });
  preciseTracker.observe({
    logs: { events: [
      event(new Date(p0).toISOString(), workflowA, 'p1'),
      event(new Date(p0 + 1_000).toISOString(), workflowB, 'pb1'),
      lifecycleEvent(new Date(p0 + 2_000).toISOString(), 'dispatcher received terminal response from MCP server', workflowA, 'p1', { status_code: 200 }),
      lifecycleEvent(new Date(p0 + 2_100).toISOString(), 'dispatcher posting terminal response to control plane', workflowA, 'p1'),
      lifecycleEvent(new Date(p0 + 2_200).toISOString(), 'dispatcher terminal response accepted by control plane', workflowA, 'p1', { tunnel_request_id: 'tsr_1' }),
      event(new Date(p0 + 9_000).toISOString(), workflowB, 'pb2'),
    ] },
    health,
    now: p0 + 13_000,
  });

  const postFinalOpen = precise.find(value => value.kind === 'post_final_stall_open' && value.workflow === workflowA);
  assert.ok(postFinalOpen, 'workflow A should emit a post-final stall after the accepted final response');
  assert.equal(postFinalOpen.post_final_gap_ms_at_detection, 10_800);
  assert.equal(postFinalOpen.tunnel_request_id, 'tsr_1');
  assert.ok(lifecycle.some(value => value.kind === 'workflow_mcp_final_received'));
  assert.ok(lifecycle.some(value => value.kind === 'workflow_final_post_started'));
  assert.ok(lifecycle.some(value => value.kind === 'workflow_final_post_accepted'));

  preciseTracker.observe({
    logs: { events: [
      event(new Date(p0).toISOString(), workflowA, 'p1'),
      event(new Date(p0 + 1_000).toISOString(), workflowB, 'pb1'),
      lifecycleEvent(new Date(p0 + 2_000).toISOString(), 'dispatcher received terminal response from MCP server', workflowA, 'p1', { status_code: 200 }),
      lifecycleEvent(new Date(p0 + 2_100).toISOString(), 'dispatcher posting terminal response to control plane', workflowA, 'p1'),
      lifecycleEvent(new Date(p0 + 2_200).toISOString(), 'dispatcher terminal response accepted by control plane', workflowA, 'p1', { tunnel_request_id: 'tsr_1' }),
      event(new Date(p0 + 9_000).toISOString(), workflowB, 'pb2'),
      forwardedEvent(new Date(p0 + 14_000).toISOString(), workflowA, 'p2'),
    ] },
    health,
    now: p0 + 14_100,
  });
  assert.equal(precise.some(value => value.kind === 'post_final_stall_recovered' && value.workflow === workflowA), false,
    'legacy forwarded-command event must not close a post-final stall');

  preciseTracker.observe({
    logs: { events: [
      event(new Date(p0).toISOString(), workflowA, 'p1'),
      event(new Date(p0 + 1_000).toISOString(), workflowB, 'pb1'),
      lifecycleEvent(new Date(p0 + 2_000).toISOString(), 'dispatcher received terminal response from MCP server', workflowA, 'p1', { status_code: 200 }),
      lifecycleEvent(new Date(p0 + 2_100).toISOString(), 'dispatcher posting terminal response to control plane', workflowA, 'p1'),
      lifecycleEvent(new Date(p0 + 2_200).toISOString(), 'dispatcher terminal response accepted by control plane', workflowA, 'p1', { tunnel_request_id: 'tsr_1' }),
      event(new Date(p0 + 9_000).toISOString(), workflowB, 'pb2'),
      forwardedEvent(new Date(p0 + 14_000).toISOString(), workflowA, 'p2'),
      event(new Date(p0 + 15_000).toISOString(), workflowA, 'p2', { polled_at: new Date(p0 + 14_500).toISOString() }),
    ] },
    health,
    now: p0 + 15_100,
  });

  const postFinalRecovered = precise.find(value => value.kind === 'post_final_stall_recovered' && value.workflow === workflowA);
  assert.ok(postFinalRecovered, 'workflow A should recover the post-final stall on the next command');
  assert.equal(postFinalRecovered.post_final_gap_ms, 12_300);
  assert.equal(postFinalRecovered.next_command_time, new Date(p0 + 14_500).toISOString());
  const nextLifecycle = lifecycle.find(value => value.kind === 'workflow_next_command_arrived' && value.workflow === workflowA);
  assert.ok(nextLifecycle, 'next workflow command should be persisted with the post-final gap');
  assert.equal(nextLifecycle.post_final_gap_ms, 12_300);

  console.log('PASS: workflow stall tracker records open/recovered and exact post-final gaps');
  return true;
}

runIfMain(import.meta.url, runTests);
