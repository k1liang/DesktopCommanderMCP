import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(message) {
  const id = message?.id;
  const method = String(message?.method ?? '');

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'request-correlation-fixture', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'ok', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, idempotentHint: true } },
          { name: 'fail', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, idempotentHint: true } },
          { name: 'large', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, idempotentHint: true } },
        ],
      },
    });
    return;
  }

  if (method !== 'tools/call') {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
    return;
  }

  const name = String(message?.params?.name ?? '');
  const args = message?.params?.arguments ?? {};

  if (name === 'ok') {
    const delayMs = Number(args.delay_ms ?? 0);
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: String(args.text ?? 'ok') }] },
    });
    return;
  }

  if (name === 'fail') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: 'fixture failure' }],
        isError: true,
      },
    });
    return;
  }

  if (name === 'large') {
    const size = Math.max(0, Number(args.size ?? 8192));
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: 'x'.repeat(size) }] },
    });
    return;
  }

  send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } });
}

rl.on('line', line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  void handle(message);
});
