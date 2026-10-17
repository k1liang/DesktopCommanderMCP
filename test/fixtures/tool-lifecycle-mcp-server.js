#!/usr/bin/env node
import readline from 'node:readline';

const PROTOCOL_VERSION = '2025-11-25';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

readline.createInterface({ input: process.stdin }).on('line', async line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'tool-lifecycle-fixture', version: '1.0.0' },
      },
    });
    return;
  }

  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          { name: 'ok', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          { name: 'error', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          { name: 'delay', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          { name: 'large', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        ],
      },
    });
    return;
  }

  if (message.method === 'tools/call') {
    const name = String(message.params?.name ?? '');
    const args = message.params?.arguments ?? {};
    if (name === 'delay') await sleep(Math.max(0, Number(args.ms ?? 100)));
    if (name === 'error') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text: 'fixture-error' }] },
      });
      return;
    }
    if (name === 'large') {
      const bytes = Math.max(1, Number(args.bytes ?? 8192));
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'x'.repeat(bytes) }] },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'fixture-ok' }] },
    });
    return;
  }

  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
});
