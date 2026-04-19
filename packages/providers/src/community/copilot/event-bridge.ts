import { createLogger } from '@archon/paths';
import type { CopilotSession } from '@github/copilot-sdk';

import type { MessageChunk, TokenUsage } from '../../types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot.event-bridge');
  return cachedLog;
}

/**
 * Single-producer / single-consumer async queue. Bridges Copilot's
 * EventEmitter API into an async generator.
 *
 * Same shape as Pi's AsyncQueue (kept duplicated rather than extracted to a
 * shared util — see CLAUDE.md "DRY + Rule of Three": only one extra caller
 * so far, not enough to justify the abstraction).
 *
 * Single-consumer is a hard invariant — a second iterator would race over
 * the buffer and waiters list, silently dropping items. Throws synchronously
 * on the second `Symbol.asyncIterator` call so the mistake surfaces loudly.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: ((item: T) => void)[] = [];
  private consumed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.buffer.push(item);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) {
      throw new Error(
        'AsyncQueue: a single queue can only be iterated once (single-consumer invariant). Create a new queue for each consumer.'
      );
    }
    this.consumed = true;
    return this.iterate();
  }

  private async *iterate(): AsyncGenerator<T> {
    while (true) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      const item = await new Promise<T>(resolve => {
        this.waiters.push(resolve);
      });
      yield item;
    }
  }
}

export type BridgeQueueItem =
  | { kind: 'chunk'; chunk: MessageChunk }
  | { kind: 'done'; sessionId?: string; tokens?: TokenUsage }
  | { kind: 'error'; error: Error };

/**
 * Serialize a tool-execution result payload to a stable string. Strings pass
 * through; objects are JSON-serialized; non-serializable values fall back to
 * String() so we always emit a textual `tool_result` chunk.
 */
export function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined || result === null) return '';
  try {
    return JSON.stringify(result);
  } catch {
    // JSON.stringify can throw on circular refs or BigInt. Objects' default
    // toString yields '[object Object]', which isn't useful — but it's the
    // best we can offer without a dedicated inspector, and the caller is
    // already consuming a malformed tool result.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(result);
  }
}

/**
 * Every Copilot SDK session event wraps its payload under a `data` property:
 * `{ type: 'tool.execution_start', data: { toolCallId, toolName, arguments } }`.
 * Unwrap it in one place so every handler reads at the right nesting level.
 *
 * See `@github/copilot-sdk/dist/generated/session-events.d.ts` for the full
 * schema — every union member declares `type` + `data`.
 */
function unwrapEventData(event: unknown): Record<string, unknown> {
  if (event === null || typeof event !== 'object') return {};
  const data = (event as { data?: unknown }).data;
  if (data !== null && typeof data === 'object') return data as Record<string, unknown>;
  return {};
}

/**
 * Pull `toolName`, `arguments`, and `toolCallId` from a `tool.execution_start`
 * payload. The SDK guarantees these fields on start events, but defensively
 * fall back to `unknown` / `{}` / `undefined` so a malformed event can't crash
 * the bridge.
 */
function extractToolStartFields(event: unknown): {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolCallId: string | undefined;
} {
  const data = unwrapEventData(event);
  const toolName = typeof data.toolName === 'string' ? data.toolName : 'unknown';
  const rawArgs = data.arguments;
  const toolInput =
    rawArgs !== null && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
  const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
  return { toolName, toolInput, toolCallId };
}

/**
 * Pull `toolCallId`, success flag, and flattened `result` text from a
 * `tool.execution_complete` payload. The SDK's result is an object
 * (`{ content, detailedContent?, contents? }`) — prefer `detailedContent`
 * (full output for UI/timeline) over `content` (truncated LLM-facing text).
 * Completion events do NOT carry `toolName`; callers map `toolCallId` back
 * via the per-session map built on start events.
 */
function extractToolCompleteFields(event: unknown): {
  toolCallId: string | undefined;
  resultText: string;
  isError: boolean;
} {
  const data = unwrapEventData(event);
  const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
  const success = data.success;
  const isError = typeof success === 'boolean' ? !success : false;

  const result = data.result;
  let resultText = '';
  if (typeof result === 'string') {
    resultText = result;
  } else if (result !== null && typeof result === 'object') {
    const r = result as { detailedContent?: unknown; content?: unknown };
    if (typeof r.detailedContent === 'string') {
      resultText = r.detailedContent;
    } else if (typeof r.content === 'string') {
      resultText = r.content;
    } else {
      resultText = serializeToolResult(result);
    }
  }
  return { toolCallId, resultText, isError };
}

/**
 * Bridge a Copilot `CopilotSession` into Archon's `AsyncGenerator<MessageChunk>`.
 *
 * Behavior:
 *  - subscribe to streaming + lifecycle events before sending the prompt
 *  - yield mapped events in arrival order
 *  - terminal `result` chunk emitted on `session.idle`
 *  - throw on session error events or `send()` rejection
 *  - forward `abortSignal` to `session.disconnect()` fire-and-forget
 *  - always remove listeners in `finally` so a second `bridgeSession` on the
 *    same session (resume + new turn) doesn't accumulate handlers
 *
 * Why event-emitter → generator:
 *   The Copilot SDK is event-emitter based (`session.on('event', cb)`) but
 *   Archon's IAgentProvider contract is async-generator. We push every
 *   mapped chunk into an AsyncQueue and the consumer drains it.
 */
export async function* bridgeCopilotSession(
  session: CopilotSession,
  prompt: string,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  const queue = new AsyncQueue<BridgeQueueItem>();

  // Untyped `on` shim — the SDK's event names are documented but not all
  // strongly typed in the published .d.ts. Using a single typed indirection
  // keeps the cast auditable in one place.
  const on = (event: string, handler: (payload: unknown) => void): void => {
    (
      session as unknown as {
        on(event: string, handler: (payload: unknown) => void): void;
      }
    ).on(event, handler);
  };

  const off = (event: string, handler: (payload: unknown) => void): void => {
    const sess = session as unknown as {
      off?(event: string, handler: (payload: unknown) => void): void;
      removeListener?(event: string, handler: (payload: unknown) => void): void;
    };
    if (sess.off) sess.off(event, handler);
    else if (sess.removeListener) sess.removeListener(event, handler);
  };

  const handlers: [string, (payload: unknown) => void][] = [];
  const register = (event: string, handler: (payload: unknown) => void): void => {
    handlers.push([event, handler]);
    on(event, handler);
  };

  let lastSessionId: string | undefined =
    typeof (session as unknown as { id?: unknown }).id === 'string'
      ? (session as unknown as { id: string }).id
      : undefined;
  let lastTokens: TokenUsage | undefined;

  // Completion events don't carry `toolName` — only `toolCallId`. Track the
  // mapping from start events so `tool_result` chunks can report the real
  // tool name instead of "unknown".
  const toolCallIdToName = new Map<string, string>();

  // Session lifecycle: capture sessionId for resume support. The terminal
  // `session.idle` event does NOT carry sessionId — it's published on
  // `session.start` at the beginning of a turn.
  register('session.start', payload => {
    const data = unwrapEventData(payload);
    if (typeof data.sessionId === 'string') lastSessionId = data.sessionId;
  });

  // Per-turn token usage. The SDK emits this once per LLM API call; for a
  // multi-call turn we keep the latest. `session.usage_info` is *context
  // window* stats (different thing) — ignored here.
  register('assistant.usage', payload => {
    const data = unwrapEventData(payload);
    const input = typeof data.inputTokens === 'number' ? data.inputTokens : 0;
    const output = typeof data.outputTokens === 'number' ? data.outputTokens : 0;
    lastTokens = { input, output, total: input + output };
  });

  // Streaming text deltas — accumulate into 'assistant' chunks per delta.
  register('assistant.message_delta', payload => {
    try {
      const data = unwrapEventData(payload);
      if (typeof data.deltaContent === 'string' && data.deltaContent.length > 0) {
        queue.push({ kind: 'chunk', chunk: { type: 'assistant', content: data.deltaContent } });
      }
    } catch (err) {
      queue.push({ kind: 'error', error: err as Error });
    }
  });

  // Reasoning / chain-of-thought deltas.
  register('assistant.reasoning_delta', payload => {
    try {
      const data = unwrapEventData(payload);
      if (typeof data.deltaContent === 'string' && data.deltaContent.length > 0) {
        queue.push({ kind: 'chunk', chunk: { type: 'thinking', content: data.deltaContent } });
      }
    } catch (err) {
      queue.push({ kind: 'error', error: err as Error });
    }
  });

  // Tool execution start → 'tool' chunk. Also record the call-id → name
  // mapping so the matching completion event can report the real tool name.
  register('tool.execution_start', payload => {
    try {
      const fields = extractToolStartFields(payload);
      if (fields.toolCallId !== undefined) {
        toolCallIdToName.set(fields.toolCallId, fields.toolName);
      }
      queue.push({
        kind: 'chunk',
        chunk: {
          type: 'tool',
          toolName: fields.toolName,
          toolInput: fields.toolInput,
          ...(fields.toolCallId !== undefined ? { toolCallId: fields.toolCallId } : {}),
        },
      });
    } catch (err) {
      queue.push({ kind: 'error', error: err as Error });
    }
  });

  // Tool execution complete → 'tool_result' chunk (+ system warning if errored).
  register('tool.execution_complete', payload => {
    try {
      const fields = extractToolCompleteFields(payload);
      const toolName =
        (fields.toolCallId !== undefined ? toolCallIdToName.get(fields.toolCallId) : undefined) ??
        'unknown';
      if (fields.isError) {
        queue.push({
          kind: 'chunk',
          chunk: { type: 'system', content: `⚠️ Tool ${toolName} failed` },
        });
      }
      queue.push({
        kind: 'chunk',
        chunk: {
          type: 'tool_result',
          toolName,
          toolOutput: fields.resultText,
          ...(fields.toolCallId !== undefined ? { toolCallId: fields.toolCallId } : {}),
        },
      });
      // Free the map entry once we've reported the result.
      if (fields.toolCallId !== undefined) toolCallIdToName.delete(fields.toolCallId);
    } catch (err) {
      queue.push({ kind: 'error', error: err as Error });
    }
  });

  // Compaction is opaque to Archon — surface as a system message so users
  // notice but don't treat it as content.
  register('session.compaction_start', () => {
    queue.push({
      kind: 'chunk',
      chunk: { type: 'system', content: 'ℹ️ Copilot is compacting the context window…' },
    });
  });

  // Session idle = end of turn. SessionId/usage are captured from
  // `session.start`/`assistant.usage` respectively (they're not on idle).
  register('session.idle', () => {
    queue.push({ kind: 'done', sessionId: lastSessionId, tokens: lastTokens });
  });

  // SDK error event — propagate as a thrown error to the consumer.
  register('error', payload => {
    const e = (payload ?? {}) as { message?: unknown };
    const msg = typeof e.message === 'string' ? e.message : 'Copilot session error';
    queue.push({ kind: 'error', error: new Error(msg) });
  });

  // Abort wiring — best-effort disconnect; the `finally` below also tears
  // down listeners regardless of outcome.
  const onAbort = (): void => {
    void (session as unknown as { disconnect: () => Promise<void> })
      .disconnect()
      .catch((err: unknown) => {
        getLog().debug({ err }, 'copilot.event-bridge.abort_failed');
      });
  };
  if (abortSignal) {
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // Fire the prompt. `send()` returns when the SDK has accepted the prompt;
  // actual completion is signaled by `session.idle`. If `send()` rejects,
  // emit an error so the consumer throws.
  const sendPromise = (session as unknown as { send: (req: { prompt: string }) => Promise<void> })
    .send({ prompt })
    .catch((err: unknown) => {
      queue.push({ kind: 'error', error: err as Error });
    });

  try {
    for await (const item of queue) {
      if (item.kind === 'done') {
        yield {
          type: 'result',
          ...(item.sessionId ? { sessionId: item.sessionId } : {}),
          ...(item.tokens ? { tokens: item.tokens } : {}),
        };
        return;
      }
      if (item.kind === 'error') throw item.error;
      yield item.chunk;
    }
  } finally {
    for (const [event, handler] of handlers) {
      try {
        off(event, handler);
      } catch (err) {
        getLog().debug({ err, event }, 'copilot.event-bridge.unsubscribe_failed');
      }
    }
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    await sendPromise;
  }
}
