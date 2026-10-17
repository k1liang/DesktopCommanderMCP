#!/usr/bin/env node
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
const DEFAULT_SEARCH_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_STALL_THRESHOLD_MS = 1_500;
const DEFAULT_MESSAGE_GAP_THRESHOLD_MS = 10_000;
const DEFAULT_SEQUENCE_BLOCK_SIZE = 1_024n;
const DEFAULT_TOOL_EVENT_HISTORY_LIMIT = 2_048;
const DEFAULT_TOOL_EVENT_PAGE_LIMIT = 256;
const DEFAULT_DIAGNOSTICS_DIR = path.join(os.homedir(), '.claude-server-commander', 'tunnel-diagnostics');
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

type CachedSearchSession = {
  externalSessionId: string;
  childSessionId: string;
  generation: number;
  startMessage: JsonObject;
  expiresAt: number;
  rehydrations: number;
};

type MessageStamp = {
  seq: bigint;
  processIndex: number;
  sincePreviousMessageMs: number | null;
  previousSeq: bigint | null;
  previousMethod: string | null;
  previousTool: string | null;
};

type ToolLifecycleOutcome = 'success' | 'error' | 'canceled';

type ToolLifecycleEvent = {
  version: 1;
  seq: number;
  request_id: string | null;
  jsonrpc_id: JsonRpcId;
  tool_name: string;
  phase: 'started' | 'completed';
  at: string;
  started_at: string;
  pending_tool_calls: number;
  generation: number;
  result_returned_at?: string;
  duration_ms?: number;
  outcome?: ToolLifecycleOutcome;
  response_bytes?: number;
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
  searchSessionTtlMs?: number;
  stallThresholdMs?: number;
  messageGapThresholdMs?: number;
  diagnosticsDir?: string;
  sequenceBlockSize?: bigint;
  toolEventHistoryLimit?: number;
};

class ProxyDiagnostics {
  readonly directory: string;
  readonly stallLogPath: string;
  readonly stallThresholdMs: number;
  readonly messageGapThresholdMs: number;
  readonly toolEventHistoryLimit: number;

  private readonly sequenceStatePath: string;
  private readonly sequenceBlockSize: bigint;
  private sequence = 0n;
  private reservedUntil = 0n;
  private sequencePersistenceAvailable = true;
  private processIndex = 0;
  private previousMessageAt: number | null = null;
  private previousMessageSeq: bigint | null = null;
  private previousMessageMethod: string | null = null;
  private previousMessageTool: string | null = null;
  private lastCompletedToolAt: number | null = null;
  private lastCompletedToolSeq: bigint | null = null;
  private lastCompletedToolName: string | null = null;
  private lastCompletedToolDurationMs: number | null = null;
  private lastStallSeq: bigint | null = null;
  private toolEventSequence = 0;
  private readonly toolEvents: ToolLifecycleEvent[] = [];

  constructor(options: ResilientMcpProxyOptions) {
    this.directory = options.diagnosticsDir ?? DEFAULT_DIAGNOSTICS_DIR;
    this.stallLogPath = path.join(this.directory, 'stalls.jsonl');
    this.sequenceStatePath = path.join(this.directory, 'message-sequence.txt');
    this.stallThresholdMs = Math.max(0, Math.floor(options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS));
    this.messageGapThresholdMs = Math.max(0, Math.floor(options.messageGapThresholdMs ?? DEFAULT_MESSAGE_GAP_THRESHOLD_MS));
    this.toolEventHistoryLimit = Math.max(1, Math.floor(options.toolEventHistoryLimit ?? DEFAULT_TOOL_EVENT_HISTORY_LIMIT));
    this.sequenceBlockSize = options.sequenceBlockSize && options.sequenceBlockSize > 0n
      ? options.sequenceBlockSize
      : DEFAULT_SEQUENCE_BLOCK_SIZE;

    mkdirSync(this.directory, { recursive: true });
    this.reserveSequenceBlock();
  }

  nextMessage(message: JsonObject): MessageStamp {
    if (this.sequence >= this.reservedUntil) this.reserveSequenceBlock();

    this.sequence += 1n;
    this.processIndex += 1;
    const now = Date.now();
    const sincePreviousMessageMs = this.previousMessageAt === null ? null : now - this.previousMessageAt;
    const previousSeq = this.previousMessageSeq;
    const previousMethod = this.previousMessageMethod;
    const previousTool = this.previousMessageTool;
    const method = String(message?.method ?? 'unknown');
    const tool = method === 'tools/call' ? String(message?.params?.name ?? 'unknown') : null;

    const idleAfterCompletedToolMs = this.lastCompletedToolAt === null ? null : now - this.lastCompletedToolAt;
    if (idleAfterCompletedToolMs !== null && idleAfterCompletedToolMs >= this.messageGapThresholdMs) {
      const previousStallSeq = this.lastStallSeq;
      const messagesSincePreviousStall = previousStallSeq === null ? null : this.sequence - previousStallSeq;
      this.lastStallSeq = this.sequence;
      this.appendStallEvent({
        kind: 'continuation_gap_candidate',
        time: new Date(now).toISOString(),
        previous_seq: previousSeq?.toString() ?? null,
        seq: this.sequence.toString(),
        arrival_gap_ms: sincePreviousMessageMs,
        idle_after_completed_tool_ms: idleAfterCompletedToolMs,
        threshold_ms: this.messageGapThresholdMs,
        previous_method: previousMethod,
        previous_tool: previousTool,
        last_completed_tool_seq: this.lastCompletedToolSeq?.toString() ?? null,
        last_completed_tool: this.lastCompletedToolName,
        last_completed_tool_duration_ms: this.lastCompletedToolDurationMs,
        method,
        tool,
        process_message_index: this.processIndex,
        previous_stall_seq: previousStallSeq?.toString() ?? null,
        messages_since_previous_stall: messagesSincePreviousStall?.toString() ?? null,
      });
    }

    this.previousMessageAt = now;
    this.previousMessageSeq = this.sequence;
    this.previousMessageMethod = method;
    this.previousMessageTool = tool;
    return {
      seq: this.sequence,
      processIndex: this.processIndex,
      sincePreviousMessageMs,
      previousSeq,
      previousMethod,
      previousTool,
    };
  }

  recordToolCall(meta: {
    stamp: MessageStamp;
    toolName: string;
    durationMs: number;
    outcome: string;
    responseBytes: number;
    paged: boolean;
    active: number;
    generation: number;
  }): void {
    const { stamp } = meta;
    const completedAt = Date.now();
    this.lastCompletedToolAt = completedAt;
    this.lastCompletedToolSeq = stamp.seq;
    this.lastCompletedToolName = meta.toolName;
    this.lastCompletedToolDurationMs = meta.durationMs;

    process.stderr.write(
      `[resilient-mcp-proxy] INFO tools/call seq=${stamp.seq} tool=${meta.toolName} duration_ms=${meta.durationMs} ` +
      `outcome=${meta.outcome} response_bytes=${meta.responseBytes} paged=${meta.paged} active=${meta.active} ` +
      `generation=${meta.generation}\n`,
    );

    if (meta.durationMs < this.stallThresholdMs) return;

    const previousStallSeq = this.lastStallSeq;
    const messagesSincePreviousStall = previousStallSeq === null ? null : stamp.seq - previousStallSeq;
    this.lastStallSeq = stamp.seq;
    this.appendStallEvent({
      kind: 'tool_stall',
      time: new Date().toISOString(),
      seq: stamp.seq.toString(),
      process_message_index: stamp.processIndex,
      previous_stall_seq: previousStallSeq?.toString() ?? null,
      messages_since_previous_stall: messagesSincePreviousStall?.toString() ?? null,
      since_previous_message_ms: stamp.sincePreviousMessageMs,
      previous_message_seq: stamp.previousSeq?.toString() ?? null,
      previous_message_method: stamp.previousMethod,
      previous_message_tool: stamp.previousTool,
      tool: meta.toolName,
      duration_ms: meta.durationMs,
      threshold_ms: this.stallThresholdMs,
      outcome: meta.outcome,
      response_bytes: meta.responseBytes,
      paged: meta.paged,
      active: meta.active,
      generation: meta.generation,
      expected_process_poll: (meta.toolName === 'read_process_output' || meta.toolName === 'interact_with_process')
        && meta.durationMs >= 4_500,
    });
  }

  recordToolLifecycleStarted(meta: {
    requestId: string | null;
    jsonrpcId: JsonRpcId;
    toolName: string;
    startedAt: number;
    pendingToolCalls: number;
    generation: number;
  }): void {
    const startedAt = new Date(meta.startedAt).toISOString();
    this.pushToolLifecycleEvent({
      request_id: meta.requestId,
      jsonrpc_id: meta.jsonrpcId,
      tool_name: meta.toolName,
      phase: 'started',
      at: startedAt,
      started_at: startedAt,
      pending_tool_calls: meta.pendingToolCalls,
      generation: meta.generation,
    });
  }

  recordToolLifecycleCompleted(meta: {
    requestId: string | null;
    jsonrpcId: JsonRpcId;
    toolName: string;
    startedAt: number;
    completedAt: number;
    outcome: ToolLifecycleOutcome;
    responseBytes: number;
    pendingToolCalls: number;
    generation: number;
  }): void {
    const completedAt = new Date(meta.completedAt).toISOString();
    this.pushToolLifecycleEvent({
      request_id: meta.requestId,
      jsonrpc_id: meta.jsonrpcId,
      tool_name: meta.toolName,
      phase: 'completed',
      at: completedAt,
      started_at: new Date(meta.startedAt).toISOString(),
      result_returned_at: completedAt,
      duration_ms: Math.max(0, meta.completedAt - meta.startedAt),
      outcome: meta.outcome,
      response_bytes: meta.responseBytes,
      pending_tool_calls: meta.pendingToolCalls,
      generation: meta.generation,
    });
  }

  getToolEvents(after: number, limit: number): JsonObject {
    const latestSeq = this.toolEventSequence;
    const oldestSeq = this.toolEvents[0]?.seq ?? (latestSeq + 1);
    const truncated = this.toolEvents.length > 0 && after < oldestSeq - 1;
    const effectiveAfter = truncated ? oldestSeq - 1 : after;
    const boundedLimit = Math.max(1, Math.min(
      Math.floor(limit),
      DEFAULT_TOOL_EVENT_PAGE_LIMIT,
      this.toolEventHistoryLimit,
    ));
    const events = this.toolEvents
      .filter(event => event.seq > effectiveAfter)
      .slice(0, boundedLimit);
    const nextAfter = events.at(-1)?.seq ?? effectiveAfter;

    return {
      version: 1,
      events,
      after,
      next_after: nextAfter,
      oldest_seq: this.toolEvents[0]?.seq ?? null,
      latest_seq: latestSeq,
      has_more: nextAfter < latestSeq,
      truncated,
      retention_limit: this.toolEventHistoryLimit,
    };
  }

  recordEvent(kind: string, fields: JsonObject): void {
    this.appendStallEvent({
      kind,
      time: new Date().toISOString(),
      ...fields,
    });
  }

  private pushToolLifecycleEvent(event: Omit<ToolLifecycleEvent, 'version' | 'seq'>): void {
    this.toolEventSequence += 1;
    this.toolEvents.push({
      version: 1,
      seq: this.toolEventSequence,
      ...event,
    });
    const excess = this.toolEvents.length - this.toolEventHistoryLimit;
    if (excess > 0) this.toolEvents.splice(0, excess);
  }

  private reserveSequenceBlock(): void {
    let persistedHighWater = 0n;
    if (this.sequencePersistenceAvailable) {
      try {
        const raw = readFileSync(this.sequenceStatePath, 'utf8').trim();
        if (/^\d+$/.test(raw)) persistedHighWater = BigInt(raw);
      } catch {}
    }

    const start = persistedHighWater > this.reservedUntil ? persistedHighWater : this.reservedUntil;
    const nextHighWater = start + this.sequenceBlockSize;
    if (this.sequencePersistenceAvailable) {
      try {
        writeFileSync(this.sequenceStatePath, nextHighWater.toString() + '\n', 'utf8');
      } catch (error) {
        this.sequencePersistenceAvailable = false;
        process.stderr.write(
          `[resilient-mcp-proxy] sequence persistence disabled: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    this.sequence = start;
    this.reservedUntil = nextHighWater;
  }

  private appendStallEvent(event: JsonObject): void {
    try {
      appendFileSync(this.stallLogPath, JSON.stringify(event) + '\n', 'utf8');
    } catch (error) {
      process.stderr.write(
        `[resilient-mcp-proxy] stall log write failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

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
  'start_search',
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
  private readonly searchSessions = new Map<string, CachedSearchSession>();
  private stopping = false;

  readonly childEntry: string;
  readonly childArgs: string[];
  readonly requestTimeoutMs: number;
  readonly initTimeoutMs: number;
  readonly resultPageBytes: number;
  readonly resultPageTtlMs: number;
  readonly resultPageMaxEntries: number;
  readonly searchSessionTtlMs: number;

  constructor(options: ResilientMcpProxyOptions = {}, private readonly diagnostics?: ProxyDiagnostics) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..');
    this.childEntry = options.childEntry ?? path.join(repoRoot, 'dist', 'index.js');
    this.childArgs = options.childArgs ?? [];
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.resultPageBytes = Math.max(1024, Math.floor(options.resultPageBytes ?? DEFAULT_RESULT_PAGE_BYTES));
    this.resultPageTtlMs = Math.max(1000, Math.floor(options.resultPageTtlMs ?? DEFAULT_RESULT_PAGE_TTL_MS));
    this.resultPageMaxEntries = Math.max(1, Math.floor(options.resultPageMaxEntries ?? DEFAULT_RESULT_PAGE_MAX_ENTRIES));
    this.searchSessionTtlMs = Math.max(60_000, Math.floor(options.searchSessionTtlMs ?? DEFAULT_SEARCH_SESSION_TTL_MS));
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
    this.searchSessions.clear();
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
      if (toolName === 'start_search' || toolName === 'get_more_search_results' || toolName === 'stop_search') {
        return this.handleSearchToolCall(message);
      }

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

  private async handleSearchToolCall(message: JsonObject): Promise<JsonObject> {
    this.sweepSearchSessions();
    const toolName = String(message?.params?.name ?? '');

    if (toolName === 'start_search') {
      const response = await this.forwardRequestWithRecovery(message);
      const sessionId = this.searchSessionIdFromResponse(response);
      if (sessionId) {
        this.searchSessions.set(sessionId, {
          externalSessionId: sessionId,
          childSessionId: sessionId,
          generation: this.generation,
          startMessage: JSON.parse(JSON.stringify(message)),
          expiresAt: Date.now() + this.searchSessionTtlMs,
          rehydrations: 0,
        });
      }
      return response;
    }

    const externalSessionId = String(message?.params?.arguments?.sessionId ?? '');
    const cached = this.searchSessions.get(externalSessionId);
    if (!cached) return this.forwardRequestWithRecovery(message);

    cached.expiresAt = Date.now() + this.searchSessionTtlMs;
    await this.ensureReady();

    if (toolName === 'stop_search' && cached.generation !== this.generation) {
      this.searchSessions.delete(externalSessionId);
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{
            type: 'text',
            text: `Search session ${externalSessionId} terminated because its Desktop Commander child was already replaced.`,
          }],
        },
      };
    }

    if (cached.generation !== this.generation) await this.rehydrateSearchSession(cached);

    let forwarded = this.withChildSearchSessionId(message, cached.childSessionId);
    let response = await this.forwardRequestWithRecovery(forwarded);

    if (toolName === 'get_more_search_results' && this.isSearchSessionNotFound(response)) {
      await this.rehydrateSearchSession(cached);
      forwarded = this.withChildSearchSessionId(message, cached.childSessionId);
      response = await this.forwardRequestWithRecovery(forwarded);
    }

    if (toolName === 'stop_search' && response?.result?.isError !== true && !response?.error) {
      this.searchSessions.delete(externalSessionId);
    }

    return this.rewriteSearchSessionId(response, cached.childSessionId, externalSessionId);
  }

  private async rehydrateSearchSession(cached: CachedSearchSession): Promise<void> {
    await this.ensureReady();
    const response = await this.forwardRequestWithRecovery(cached.startMessage);
    const childSessionId = this.searchSessionIdFromResponse(response);
    if (!childSessionId || response?.result?.isError === true || response?.error) {
      throw new Error(`Failed to recover search session ${cached.externalSessionId} after child replacement`);
    }

    cached.childSessionId = childSessionId;
    cached.generation = this.generation;
    cached.expiresAt = Date.now() + this.searchSessionTtlMs;
    cached.rehydrations += 1;
    this.diagnostics?.recordEvent('search_session_rehydrated', {
      external_session_id: cached.externalSessionId,
      child_session_id: cached.childSessionId,
      generation: cached.generation,
      rehydrations: cached.rehydrations,
    });
  }

  private searchSessionIdFromResponse(response: JsonObject): string | null {
    const sessionId = response?.result?.structuredContent?.sessionId;
    if (typeof sessionId === 'string' && sessionId) return sessionId;

    const content = response?.result?.content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      const match = block.text.match(/(?:started .* search session:|search session:)\s*(search_[^\s]+)/i);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  private withChildSearchSessionId(message: JsonObject, childSessionId: string): JsonObject {
    return {
      ...message,
      params: {
        ...message.params,
        arguments: {
          ...message?.params?.arguments,
          sessionId: childSessionId,
        },
      },
    };
  }

  private rewriteSearchSessionId(response: JsonObject, childSessionId: string, externalSessionId: string): JsonObject {
    if (childSessionId === externalSessionId) return response;

    const result = response?.result;
    if (!result || typeof result !== 'object') return response;

    const content = Array.isArray(result.content)
      ? result.content.map((block: JsonObject) => (
        block?.type === 'text' && typeof block.text === 'string'
          ? { ...block, text: block.text.split(childSessionId).join(externalSessionId) }
          : block
      ))
      : result.content;
    const structuredContent = result.structuredContent && typeof result.structuredContent === 'object'
      ? { ...result.structuredContent, sessionId: externalSessionId }
      : result.structuredContent;

    return {
      ...response,
      result: {
        ...result,
        content,
        structuredContent,
      },
    };
  }

  private isSearchSessionNotFound(response: JsonObject): boolean {
    if (response?.result?.isError !== true) return false;
    const content = response?.result?.content;
    if (!Array.isArray(content)) return false;
    return content.some((block: JsonObject) => (
      block?.type === 'text' &&
      typeof block.text === 'string' &&
      /search session .* not found/i.test(block.text)
    ));
  }

  private sweepSearchSessions(): void {
    const now = Date.now();
    for (const [sessionId, cached] of this.searchSessions) {
      if (cached.expiresAt <= now) this.searchSessions.delete(sessionId);
    }
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
    this.diagnostics?.recordEvent('child_generation_started', { generation: this.generation });

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
    this.diagnostics?.recordEvent('child_generation_exited', {
      generation: this.generation,
      exit_code: code,
      signal: signal ?? null,
    });
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

function normalizeRequestIdHeader(req: IncomingMessage): string | null {
  const raw = req.headers['x-request-id'];
  if (Array.isArray(raw)) {
    const normalized = raw.map(value => value.trim()).filter(Boolean).join(', ');
    return normalized || null;
  }
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim();
  return normalized || null;
}

function parseNonNegativeInteger(value: string | null, fallback: number): number | null {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function responseByteLength(response: JsonObject | null): number {
  try {
    return response ? Buffer.byteLength(JSON.stringify(response), 'utf8') : 0;
  } catch {
    return 0;
  }
}

function lifecycleOutcome(response: JsonObject | null, error?: unknown): ToolLifecycleOutcome {
  const rpcCode = response?.error?.code;
  if ((error instanceof Error && error.name === 'AbortError') || rpcCode === -32800) return 'canceled';
  if (error || response?.error || response?.result?.isError === true) return 'error';
  return 'success';
}

function logToolCallDuration(
  diagnostics: ProxyDiagnostics,
  stamp: MessageStamp,
  message: JsonObject,
  response: JsonObject | null,
  startedAt: number,
  active: number,
  generation: number,
  error?: unknown,
): void {
  if (message.method !== 'tools/call') return;

  const toolName = String(message?.params?.name ?? 'unknown');
  const durationMs = Date.now() - startedAt;
  const outcome = error
    ? 'exception'
    : response?.error
      ? 'rpc_error'
      : response?.result?.isError === true
        ? 'tool_error'
        : 'ok';
  const paged = response?.result?.structuredContent?.pagination?.has_more === true;
  const responseBytes = responseByteLength(response);

  diagnostics.recordToolCall({
    stamp,
    toolName,
    durationMs,
    outcome,
    responseBytes,
    paged,
    active,
    generation,
  });
}

export async function startResilientMcpProxy(options: ResilientMcpProxyOptions = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const diagnostics = new ProxyDiagnostics(options);
  const session = new ResilientChildMcpSession(options, diagnostics);
  let activeToolCalls = 0;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);

      if (req.method === 'GET' && url.pathname === '/diagnostics/tool-events') {
        const after = parseNonNegativeInteger(url.searchParams.get('after'), 0);
        const limit = parseNonNegativeInteger(url.searchParams.get('limit'), DEFAULT_TOOL_EVENT_PAGE_LIMIT);
        if (after === null || limit === null || limit < 1) {
          return sendJson(res, 400, {
            error: 'after must be a non-negative integer and limit must be a positive integer',
          });
        }
        return sendJson(res, 200, diagnostics.getToolEvents(after, limit));
      }

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, {
          ok: true,
          childReady: session.isReady,
          generation: session.childGeneration,
          resultPageBytes: session.resultPageBytes,
          stallThresholdMs: diagnostics.stallThresholdMs,
          messageGapThresholdMs: diagnostics.messageGapThresholdMs,
          stallLogPath: diagnostics.stallLogPath,
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

      const requestId = normalizeRequestIdHeader(req);
      const incoming = await readJsonBody(req, maxBodyBytes);
      const messages = Array.isArray(incoming) ? incoming : [incoming];
      const responses: JsonObject[] = [];

      for (const message of messages) {
        const stamp = diagnostics.nextMessage(message);
        if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
          const id = message && typeof message === 'object' && 'id' in message ? (message.id as JsonRpcId) : null;
          responses.push(jsonRpcError(id, -32600, 'Invalid JSON-RPC request'));
          continue;
        }

        const toolCall = message.method === 'tools/call';
        const startedAt = Date.now();
        let toolResponse: JsonObject | null = null;
        let toolError: unknown;
        if (toolCall) {
          activeToolCalls += 1;
          diagnostics.recordToolLifecycleStarted({
            requestId,
            jsonrpcId: message.id as JsonRpcId,
            toolName: String(message?.params?.name ?? 'unknown'),
            startedAt,
            pendingToolCalls: activeToolCalls,
            generation: session.childGeneration,
          });
        }

        try {
          const response = await session.handle(message);
          toolResponse = response;
          if (toolCall) {
            logToolCallDuration(diagnostics, stamp, message, response, startedAt, activeToolCalls, session.childGeneration);
          }
          if (response) responses.push(response);
        } catch (error) {
          toolError = error;
          if (toolCall) {
            logToolCallDuration(diagnostics, stamp, message, null, startedAt, activeToolCalls, session.childGeneration, error);
          }
          throw error;
        } finally {
          if (toolCall) {
            activeToolCalls -= 1;
            diagnostics.recordToolLifecycleCompleted({
              requestId,
              jsonrpcId: message.id as JsonRpcId,
              toolName: String(message?.params?.name ?? 'unknown'),
              startedAt,
              completedAt: Date.now(),
              outcome: lifecycleOutcome(toolResponse, toolError),
              responseBytes: responseByteLength(toolResponse),
              pendingToolCalls: activeToolCalls,
              generation: session.childGeneration,
            });
          }
        }
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
    diagnostics,
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
  if (options.searchSessionTtlMs === undefined && process.env.DC_RESILIENT_MCP_SEARCH_SESSION_TTL_MS) {
    options.searchSessionTtlMs = Number(process.env.DC_RESILIENT_MCP_SEARCH_SESSION_TTL_MS);
  }
  if (options.stallThresholdMs === undefined && process.env.DC_RESILIENT_MCP_STALL_MS) {
    options.stallThresholdMs = Number(process.env.DC_RESILIENT_MCP_STALL_MS);
  }
  if (options.messageGapThresholdMs === undefined && process.env.DC_RESILIENT_MCP_GAP_MS) {
    options.messageGapThresholdMs = Number(process.env.DC_RESILIENT_MCP_GAP_MS);
  }
  if (options.toolEventHistoryLimit === undefined && process.env.DC_RESILIENT_MCP_TOOL_EVENT_HISTORY_LIMIT) {
    options.toolEventHistoryLimit = Number(process.env.DC_RESILIENT_MCP_TOOL_EVENT_HISTORY_LIMIT);
  }
  if (!options.diagnosticsDir && process.env.DC_RESILIENT_MCP_DIAGNOSTICS_DIR) {
    options.diagnosticsDir = path.resolve(process.env.DC_RESILIENT_MCP_DIAGNOSTICS_DIR);
  }

  startResilientMcpProxy(options)
    .then(proxy => {
      process.stderr.write(`[resilient-mcp-proxy] listening at ${proxy.url}\n`);
      process.stderr.write(
        `[resilient-mcp-proxy] stall diagnostics threshold_ms=${proxy.diagnostics.stallThresholdMs} gap_ms=${proxy.diagnostics.messageGapThresholdMs} log=${proxy.diagnostics.stallLogPath}\n`,
      );

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
