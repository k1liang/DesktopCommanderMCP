#!/usr/bin/env node
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const DEFAULT_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;
const DEFAULT_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_RESULT_PAGE_BYTES = 32 * 1024;
const DEFAULT_RESULT_PAGE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RESULT_PAGE_MAX_ENTRIES = 64;
const RESULT_PAGE_TOOL_NAME = 'get_result_page';

type JsonRpcId = string | number | null;
type JsonObject = Record<string, any>;

type PendingRequest = {
  resolve: (message: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type CachedPagedResult = {
  pages: string[];
  expiresAt: number;
  originalTool: string;
};

export type ResilientMcpProxyOptions = {
  host?: string;
  port?: number;
  childEntry?: string;
  childArgs?: string[];
  requestTimeoutMs?: number;
  initTimeoutMs?: number;
  maxBodyBytes?: number;
  resultPageBytes?: number;
  resultPageTtlMs?: number;
  resultPageMaxEntries?: number;
};

class ChildDisconnectedError extends Error {
  readonly dispatched: boolean;

  constructor(message: string, dispatched: boolean) {
    super(message);
    this.name = 'ChildDisconnectedError';
    this.dispatched = dispatched;
  }
}

const KNOWN_READ_ONLY_TOOLS = new Set([
  'get_config',
  'read_file',
  'read_multiple_files',
  'list_directory',
  'get_file_info',
  'list_processes',
  'list_sessions',
  'read_process_output',
  'get_usage_stats',
  'get_recent_tool_calls',
  'list_searches',
  'get_more_search_results',
  RESULT_PAGE_TOOL_NAME,
]);

const RESULT_PAGE_TOOL = {
  name: RESULT_PAGE_TOOL_NAME,
  description:
    'Continue a Desktop Commander result that was automatically paginated by the resilient proxy. ' +
    'When another tool result says has_more=true, call this tool with next_cursor before making any conclusion that depends on omitted content.',
  inputSchema: {
    type: 'object',
    properties: {
      cursor: {
        type: 'string',
        description: 'Opaque next_cursor returned by a previously paginated tool result.',
      },
    },
    required: ['cursor'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

function splitUtf8Pages(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];

  const pages: string[] = [];
  let start = 0;
  let end = 0;
  let bytes = 0;

  while (end < text.length) {
    const codePoint = text.codePointAt(end) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    const charBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;

    if (bytes + charBytes > maxBytes && end > start) {
      pages.push(text.slice(start, end));
      start = end;
      bytes = 0;
      continue;
    }

    bytes += charBytes;
    end += width;
  }

  if (start < text.length) pages.push(text.slice(start));
  return pages;
}

function paginationFooter(meta: {
  page: number;
  totalPages: number;
  nextCursor: string | null;
  originalTool: string;
}): string {
  const hasMore = meta.nextCursor !== null;
  return [
    '',
    '',
    '[Desktop Commander result pagination]',
    hasMore
      ? `This response is incomplete: page ${meta.page}/${meta.totalPages} from ${meta.originalTool}.`
      : `This is the final page ${meta.page}/${meta.totalPages} from ${meta.originalTool}.`,
    `pagination: {"has_more":${hasMore},"next_cursor":${meta.nextCursor ? JSON.stringify(meta.nextCursor) : 'null'},"page":${meta.page},"total_pages":${meta.totalPages}}`,
    hasMore
      ? `Call ${RESULT_PAGE_TOOL_NAME} with next_cursor before assuming omitted content is absent. If that tool is unavailable in this conversation, call read_file with path=result-page://${meta.nextCursor}.`
      : 'No more pages remain.',
  ].join('\n');
}

function isRequest(message: JsonObject): boolean {
  return Object.prototype.hasOwnProperty.call(message, 'id');
}

function isInitializationRequired(response: JsonObject): boolean {
  const code = response?.error?.code;
  const message = String(response?.error?.message ?? '').toLowerCase();
  return code === -32002 && message.includes('not initialized');
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: JsonObject): JsonObject {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
}

function toolFailure(id: JsonRpcId, message: string): JsonObject {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: message }],
      isError: true,
    },
  };
}

export class ResilientChildMcpSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private pending = new Map<string, PendingRequest>();
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private generation = 0;
  private nextInternalId = 1;
  private initResult: JsonObject | null = null;
  private readonly readOnlyTools = new Map<string, boolean>();
  private readonly pagedResults = new Map<string, CachedPagedResult>();
  private stopping = false;

  readonly childEntry: string;
  readonly childArgs: string[];
  readonly requestTimeoutMs: number;
  readonly initTimeoutMs: number;
  readonly resultPageBytes: number;
  readonly resultPageTtlMs: number;
  readonly resultPageMaxEntries: number;

  constructor(options: ResilientMcpProxyOptions = {}) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..');
    this.childEntry = options.childEntry ?? path.join(repoRoot, 'dist', 'index.js');
    this.childArgs = options.childArgs ?? [];
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.resultPageBytes = Math.max(1024, Math.floor(options.resultPageBytes ?? DEFAULT_RESULT_PAGE_BYTES));
    this.resultPageTtlMs = Math.max(1000, Math.floor(options.resultPageTtlMs ?? DEFAULT_RESULT_PAGE_TTL_MS));
    this.resultPageMaxEntries = Math.max(1, Math.floor(options.resultPageMaxEntries ?? DEFAULT_RESULT_PAGE_MAX_ENTRIES));
  }

  get isReady(): boolean {
    return this.ready && !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  get childGeneration(): number {
    return this.generation;
  }

  async ensureReady(): Promise<void> {
    if (this.isReady) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = this.startAndInitialize().finally(() => {
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    const child = this.child;
    this.child = null;
    this.pagedResults.clear();
    this.rejectAllPending(new ChildDisconnectedError('Desktop Commander proxy is stopping', false));
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch {}
    }
  }

  async restart(): Promise<void> {
    this.ready = false;
    this.initResult = null;
    const child = this.child;
    this.child = null;
    this.rejectAllPending(new ChildDisconnectedError('Desktop Commander child session is restarting', true));

    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try { child.kill(); } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }

    await this.ensureReady();
  }

  async handle(message: JsonObject): Promise<JsonObject | null> {
    const method = String(message.method ?? '');

    if (method === 'tools/call' && isRequest(message)) {
      const toolName = String(message?.params?.name ?? '');
      if (toolName === RESULT_PAGE_TOOL_NAME) return this.handleResultPageCall(message);

      const legacyPagePath = toolName === 'read_file'
        ? String(message?.params?.arguments?.path ?? '')
        : '';
      if (legacyPagePath.startsWith('result-page://')) {
        return this.handleResultPageCall({
          ...message,
          params: {
            ...message.params,
            arguments: {
              cursor: legacyPagePath.slice('result-page://'.length),
            },
          },
        });
      }
    }

    if (method === 'initialize' && isRequest(message)) {
      await this.ensureReady();
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: this.initResult ?? {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          serverInfo: { name: 'desktop-commander', version: 'unknown' },
        },
      };
    }

    if (method === 'notifications/initialized') {
      await this.ensureReady();
      return null;
    }

    if (method === 'server/discover' && isRequest(message)) {
      await this.ensureReady();
      const init = this.initResult ?? {};
      const result: JsonObject = {
        supportedVersions: [MODERN_PROTOCOL_VERSION],
        capabilities: init.capabilities ?? {},
        _meta: {
          'io.modelcontextprotocol/serverInfo': init.serverInfo ?? {
            name: 'desktop-commander',
            version: 'unknown',
          },
        },
      };
      if (init.instructions !== undefined) result.instructions = init.instructions;
      return { jsonrpc: '2.0', id: message.id, result };
    }

    if (!isRequest(message)) {
      await this.ensureReady();
      if (method === 'notifications/cancelled') {
        // Incoming request IDs are remapped before reaching the child, so a
        // cancellation carrying the caller's ID cannot safely be forwarded.
        return null;
      }
      this.writeToChild({ ...message, jsonrpc: '2.0' });
      return null;
    }

    return this.forwardRequestWithRecovery(message);
  }

  private async forwardRequestWithRecovery(message: JsonObject): Promise<JsonObject> {
    const originalId = message.id as JsonRpcId;
    const replaySafe = this.isReplaySafe(message);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.ensureReady();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 0) continue;
        break;
      }

      try {
        const response = await this.sendChildRequest(message);
        if (isInitializationRequired(response) && attempt === 0) {
          await this.restart();
          continue;
        }

        const normalized = { ...response, id: originalId };
        this.observeResponse(message, normalized);
        return this.decorateResponse(message, normalized);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        lastError = normalized;
        const disconnected = normalized instanceof ChildDisconnectedError;

        if (attempt === 0 && (!disconnected || !normalized.dispatched || replaySafe)) {
          continue;
        }
        break;
      }
    }

    const detail = lastError?.message ?? 'unknown backend error';
    if (String(message.method) === 'tools/call') {
      const toolName = String(message?.params?.name ?? 'unknown');
      const replayNote = replaySafe
        ? 'The proxy already attempted one safe automatic replay.'
        : 'The call was not automatically replayed because it may have side effects; inspect state before retrying.';
      return toolFailure(
        originalId,
        `Desktop Commander backend was temporarily unavailable while running ${toolName}. ${replayNote} Backend detail: ${detail}`,
      );
    }

    return jsonRpcError(originalId, -32001, 'Desktop Commander backend temporarily unavailable', {
      origin: 'desktop-commander-resilient-proxy',
      transient: true,
      detail,
    });
  }

  private decorateResponse(request: JsonObject, response: JsonObject): JsonObject {
    if (request.method === 'tools/list' && Array.isArray(response?.result?.tools)) {
      const tools = response.result.tools;
      if (tools.some((tool: JsonObject) => tool?.name === RESULT_PAGE_TOOL_NAME)) return response;
      return {
        ...response,
        result: {
          ...response.result,
          tools: [...tools, RESULT_PAGE_TOOL],
        },
      };
    }

    if (request.method === 'tools/call') return this.paginateToolResponse(request, response);
    return response;
  }

  private paginateToolResponse(request: JsonObject, response: JsonObject): JsonObject {
    if (response.error || response?.result?.isError === true) return response;

    const result = response?.result;
    const content = result?.content;
    if (!Array.isArray(content) || content.length !== 1 || result?.structuredContent !== undefined) return response;

    const block = content[0];
    if (block?.type !== 'text' || typeof block.text !== 'string') return response;

    const totalBytes = Buffer.byteLength(block.text, 'utf8');
    if (totalBytes <= this.resultPageBytes) return response;

    // Leave enough headroom for the pagination footer so the wire response stays
    // close to the configured page target instead of exceeding it by a full footer.
    const textPageBytes = Math.max(512, this.resultPageBytes - 1024);
    const pages = splitUtf8Pages(block.text, textPageBytes);
    if (pages.length <= 1) return response;

    this.sweepPagedResults();
    while (this.pagedResults.size >= this.resultPageMaxEntries) {
      const oldest = this.pagedResults.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pagedResults.delete(oldest);
    }

    const token = randomUUID();
    const originalTool = String(request?.params?.name ?? 'unknown');
    this.pagedResults.set(token, {
      pages,
      expiresAt: Date.now() + this.resultPageTtlMs,
      originalTool,
    });

    const nextCursor = `${token}:1`;
    const meta = {
      has_more: true,
      next_cursor: nextCursor,
      page: 1,
      total_pages: pages.length,
      original_tool: originalTool,
      total_bytes: totalBytes,
    };

    process.stderr.write(
      `[resilient-mcp-proxy] paged ${originalTool} result: ${totalBytes} bytes -> ${pages.length} pages\n`,
    );

    return {
      ...response,
      result: {
        ...result,
        content: [{
          ...block,
          text: pages[0] + paginationFooter({
            page: 1,
            totalPages: pages.length,
            nextCursor,
            originalTool,
          }),
        }],
        structuredContent: { pagination: meta },
      },
    };
  }

  private handleResultPageCall(message: JsonObject): JsonObject {
    this.sweepPagedResults();

    const cursor = String(message?.params?.arguments?.cursor ?? '');
    const separator = cursor.lastIndexOf(':');
    const token = separator > 0 ? cursor.slice(0, separator) : '';
    const pageIndex = separator > 0 ? Number(cursor.slice(separator + 1)) : Number.NaN;
    const cached = token ? this.pagedResults.get(token) : undefined;

    if (!cached || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= cached.pages.length) {
      return toolFailure(
        message.id as JsonRpcId,
        'Invalid or expired result-page cursor. Re-run the original tool only if it is safe/read-only; for side-effecting calls inspect state before retrying.',
      );
    }

    const nextCursor = pageIndex + 1 < cached.pages.length ? `${token}:${pageIndex + 1}` : null;
    const meta = {
      has_more: nextCursor !== null,
      next_cursor: nextCursor,
      page: pageIndex + 1,
      total_pages: cached.pages.length,
      original_tool: cached.originalTool,
    };

    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{
          type: 'text',
          text: cached.pages[pageIndex] + paginationFooter({
            page: pageIndex + 1,
            totalPages: cached.pages.length,
            nextCursor,
            originalTool: cached.originalTool,
          }),
        }],
        structuredContent: { pagination: meta },
      },
    };
  }

  private sweepPagedResults(): void {
    const now = Date.now();
    for (const [token, cached] of this.pagedResults) {
      if (cached.expiresAt <= now) this.pagedResults.delete(token);
    }
  }

  private isReplaySafe(message: JsonObject): boolean {
    const method = String(message.method ?? '');
    if (method !== 'tools/call') {
      return new Set([
        'ping',
        'tools/list',
        'resources/list',
        'resources/read',
        'resources/templates/list',
        'prompts/list',
        'prompts/get',
        'completion/complete',
      ]).has(method);
    }

    const toolName = String(message?.params?.name ?? '');
    const learned = this.readOnlyTools.get(toolName);
    return learned ?? KNOWN_READ_ONLY_TOOLS.has(toolName);
  }

  private observeResponse(request: JsonObject, response: JsonObject): void {
    if (request.method !== 'tools/list') return;
    const tools = response?.result?.tools;
    if (!Array.isArray(tools)) return;

    for (const tool of tools) {
      const name = typeof tool?.name === 'string' ? tool.name : '';
      if (!name) continue;
      const readOnly = tool?.annotations?.readOnlyHint;
      if (typeof readOnly === 'boolean') this.readOnlyTools.set(name, readOnly);
    }
  }

  private async startAndInitialize(): Promise<void> {
    if (this.stopping) throw new Error('Resilient MCP proxy is stopping');

    const stale = this.child;
    if (stale && stale.exitCode === null && stale.signalCode === null) {
      try { stale.kill(); } catch {}
    }

    this.ready = false;
    this.initResult = null;
    this.stdoutBuffer = '';
    this.generation += 1;

    const child = spawn(process.execPath, [this.childEntry, ...this.childArgs], {
      cwd: path.dirname(path.dirname(this.childEntry)),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout.on('data', chunk => this.onStdout(chunk));
    child.stderr.on('data', chunk => {
      process.stderr.write(`[desktop-commander-child] ${chunk.toString()}`);
    });
    child.once('exit', (code, signal) => this.onChildExit(child, code, signal));
    child.once('error', error => {
      if (this.child === child) {
        this.ready = false;
        this.rejectAllPending(new ChildDisconnectedError(`Desktop Commander child error: ${error.message}`, false));
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });

    const initResponse = await this.sendChildRequest(
      {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            // Preserve Desktop Commander's OpenAI-specific behavior while the
            // proxy owns the transport-level lifecycle on behalf of Tunnel.
            name: 'openai-mcp',
            version: '1.0.0',
          },
        },
      },
      this.initTimeoutMs,
      true,
    );

    if (initResponse.error) {
      throw new Error(`Desktop Commander initialize failed: ${JSON.stringify(initResponse.error)}`);
    }

    this.initResult = initResponse.result ?? null;
    this.writeToChild({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    this.ready = true;
  }

  private async sendChildRequest(message: JsonObject, timeoutMs = this.requestTimeoutMs, allowBeforeReady = false): Promise<JsonObject> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new ChildDisconnectedError('Desktop Commander child is not running', false);
    }
    if (!allowBeforeReady && !this.ready) {
      throw new ChildDisconnectedError('Desktop Commander child is not initialized', false);
    }

    const internalId = `proxy-${this.generation}-${this.nextInternalId++}`;
    const outbound = { ...message, jsonrpc: '2.0', id: internalId };
    const pendingKey = String(internalId);

    return await new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new ChildDisconnectedError(`Desktop Commander request timed out after ${timeoutMs}ms`, true));
      }, timeoutMs);

      this.pending.set(pendingKey, { resolve, reject, timer });

      child.stdin.write(JSON.stringify(outbound) + '\n', error => {
        if (!error) return;
        const pending = this.pending.get(pendingKey);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(pendingKey);
        pending.reject(new ChildDisconnectedError(`Failed to write to Desktop Commander child: ${error.message}`, false));
      });
    });
  }

  private writeToChild(message: JsonObject): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin.write(JSON.stringify(message) + '\n');
    } catch {}
  }

  private onStdout(chunk: Buffer | string): void {
    this.stdoutBuffer += chunk.toString();

    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;

      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let message: JsonObject;
      try {
        message = JSON.parse(line);
      } catch {
        process.stderr.write(`[resilient-mcp-proxy] ignored non-JSON child stdout: ${line.slice(0, 500)}\n`);
        continue;
      }

      this.onChildMessage(message);
    }
  }

  private onChildMessage(message: JsonObject): void {
    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.resolve(message);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
      // Desktop Commander currently does not use sampling/elicitation/roots
      // callbacks. Fail unexpected server->client requests promptly rather than
      // leaving its request pending forever.
      this.writeToChild(jsonRpcError(message.id as JsonRpcId, -32601, `Unsupported client callback: ${message.method}`));
    }
  }

  private onChildExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    this.initResult = null;
    this.rejectAllPending(
      new ChildDisconnectedError(
        `Desktop Commander child exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
        true,
      ),
    );
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<JsonObject | JsonObject[]> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) {
      throw new Error(`Request body exceeds ${maxBodyBytes} bytes`);
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

export async function startResilientMcpProxy(options: ResilientMcpProxyOptions = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const session = new ResilientChildMcpSession(options);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, {
          ok: true,
          childReady: session.isReady,
          generation: session.childGeneration,
          resultPageBytes: session.resultPageBytes,
        });
      }

      if (req.method === 'GET' && url.pathname === '/readyz') {
        try {
          await session.ensureReady();
          return sendJson(res, 200, {
            ok: true,
            childReady: true,
            generation: session.childGeneration,
            resultPageBytes: session.resultPageBytes,
          });
        } catch (error) {
          return sendJson(res, 503, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (req.method !== 'POST' || url.pathname !== '/mcp') {
        res.statusCode = 404;
        return res.end('not found');
      }

      const incoming = await readJsonBody(req, maxBodyBytes);
      const messages = Array.isArray(incoming) ? incoming : [incoming];
      const responses: JsonObject[] = [];

      for (const message of messages) {
        if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
          const id = message && typeof message === 'object' && 'id' in message ? (message.id as JsonRpcId) : null;
          responses.push(jsonRpcError(id, -32600, 'Invalid JSON-RPC request'));
          continue;
        }

        const response = await session.handle(message);
        if (response) responses.push(response);
      }

      if (responses.length === 0) {
        res.statusCode = 202;
        return res.end();
      }

      return sendJson(res, 200, Array.isArray(incoming) ? responses : responses[0]);
    } catch (error) {
      return sendJson(res, 400, jsonRpcError(null, -32700, 'Invalid MCP request', {
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  try {
    await session.ensureReady();
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await session.stop();
    throw error;
  }

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}/mcp`;

  return {
    server,
    session,
    host,
    port: actualPort,
    url,
    close: async () => {
      await session.stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function parseCliArgs(argv: string[]): ResilientMcpProxyOptions {
  const options: ResilientMcpProxyOptions = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--host' && next) {
      options.host = next;
      i += 1;
    } else if (arg === '--port' && next) {
      options.port = Number(next);
      i += 1;
    } else if (arg === '--child-entry' && next) {
      options.childEntry = path.resolve(next);
      i += 1;
    } else if (arg === '--result-page-bytes' && next) {
      options.resultPageBytes = Number(next);
      i += 1;
    }
  }

  return options;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const self = path.resolve(fileURLToPath(import.meta.url));

if (entry === self) {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options.host && process.env.DC_RESILIENT_MCP_HOST) options.host = process.env.DC_RESILIENT_MCP_HOST;
  if (options.port === undefined && process.env.DC_RESILIENT_MCP_PORT) options.port = Number(process.env.DC_RESILIENT_MCP_PORT);
  if (options.resultPageBytes === undefined && process.env.DC_RESILIENT_MCP_RESULT_PAGE_BYTES) {
    options.resultPageBytes = Number(process.env.DC_RESILIENT_MCP_RESULT_PAGE_BYTES);
  }
  if (options.resultPageTtlMs === undefined && process.env.DC_RESILIENT_MCP_RESULT_PAGE_TTL_MS) {
    options.resultPageTtlMs = Number(process.env.DC_RESILIENT_MCP_RESULT_PAGE_TTL_MS);
  }
  if (options.resultPageMaxEntries === undefined && process.env.DC_RESILIENT_MCP_RESULT_PAGE_MAX_ENTRIES) {
    options.resultPageMaxEntries = Number(process.env.DC_RESILIENT_MCP_RESULT_PAGE_MAX_ENTRIES);
  }

  startResilientMcpProxy(options)
    .then(proxy => {
      process.stderr.write(`[resilient-mcp-proxy] listening at ${proxy.url}\n`);

      let closing = false;
      const close = async () => {
        if (closing) return;
        closing = true;
        await proxy.close();
      };

      process.on('SIGINT', () => void close());
      process.on('SIGTERM', () => void close());
    })
    .catch(error => {
      process.stderr.write(`[resilient-mcp-proxy] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
