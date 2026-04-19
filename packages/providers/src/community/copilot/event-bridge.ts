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
    return String(result);
  }
}

/**
 * Pull `toolName`/`args`/`callId` from a Copilot tool event in a
 * structurally-defensive way. The SDK's exact event shape isn't strongly
 * typed in @github/copilot-sdk's public types (it varies by tool kind);
 * this helper keeps the assumption-points in one place.
 */
function extractToolEventFields(event: unknown): {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolCallId: string | undefined;
  result?: unknown;
  isError?: boolean;
} {
  const e = (event ?? {}) as Record<string, unknown>;
  const toolName =
    typeof e.toolName === 'string'
      ? e.toolName
      : typeof e.name === 'string'
        ? e.name
        : 'unknown';
  const args = e.args ?? e.arguments ?? e.input ?? {};
  const toolInput =
    typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  const toolCallId =
    typeof e.toolCallId === 'string'
      ? e.toolCallId
      : typeof e.id === 'string'
        ? e.id
        : undefined;
  const result = e.result;
  const isError = typeof e.isError === 'boolean' ? e.isError : undefined;
  return {
    toolName,
    toolInput,
    toolCallId,
    ...(result !== undefined ? { result } : {}),
    ...(isError !== undefined ? { isError } : {}),
  };
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
  const on = (
    event: string,
    handler: (payload: unknown) => void
  ): void => {
    (session as unknown as {
      on(event: string, handler: (payload: unknown) => void): void;
    }).on(event, handler);
  };

  const off = (
    event: string,
    handler: (payload: unknown) => void
  ): void => {
    const sess = session as unknown as {
      off?(event: string, handler: (payload: unknown) => void): void;
      removeListener?(event: string, handler: (payload: unknown) => void): void;
    };
    if (sess.off) sess.off(event, handler);
    else if (sess.removeListener) sess.removeListener(event, handler);
  };

  const handlers: Array<[string, (payload: unknown) => void]> = [];
  const register = (event: string, handler: (payload: unknown) => void): void => {
    handlers.push([event, handler]);
    on(event, handler);
  };

  let lastSessionId: string | undefined =
    typeof (session as unknown as { id?: unknown }).id === 'string'
      ? ((session as unknown as { id: string }).id)
      : undefined;
  let lastTokens: TokenUsage | undefined;

  // Streaming text deltas — accumulate into 'assistant' chunks per delta.
  register('assistant.message_delta', payload => {
    try {
      const e = (payload ?? {}) as { deltaContent?: unknown };
      if (typeof e.deltaContent === 'string' && e.deltaContent.length > 0) {
        queue.push({ kind: 'chunk', chunk: { type: 'assistant', content: e.deltaContent } });
      }
    } catch (err) {
      queue.push({ kind: 'error', error: err as Error });
    }
  });

  // Reasoning / chain-of-thought deltas.
  register('assistant.reasoning_delta', payload => {
    try {
      const e = (payload ?? {}) as { deltaContent?: unknown };
      if (typeof e.deltaContent === 'string' && e.deltaContent.length > 0) {
        queue.push({ kind: 'chunk', chunk: { type: 'thinking', content: e.deltaContent } });
      }
    } catch (err) {
      queue.push({ kind: 'error', error: err as Error });
    }
  });

  // Tool execution start → 'tool' chunk.
  register('tool.execution_start', payload => {
    try {
      const fields = extractToolEventFields(payload);
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
      const fields = extractToolEventFields(payload);
      if (fields.isError) {
        queue.push({
          kind: 'chunk',
          chunk: { type: 'system', content: `⚠️ Tool ${fields.toolName} failed` },
        });
      }
      queue.push({
        kind: 'chunk',
        chunk: {
          type: 'tool_result',
          toolName: fields.toolName,
          toolOutput: serializeToolResult(fields.result),
          ...(fields.toolCallId !== undefined ? { toolCallId: fields.toolCallId } : {}),
        },
      });
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

  // Session idle = end of turn. Pull session id + token usage if surfaced.
  register('session.idle', payload => {
    try {
      const e = (payload ?? {}) as {
        sessionId?: unknown;
        usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown };
      };
      if (typeof e.sessionId === 'string') lastSessionId = e.sessionId;
      if (e.usage && typeof e.usage === 'object') {
        const u = e.usage;
        const input = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
        const output = typeof u.outputTokens === 'number' ? u.outputTokens : 0;
        const total = typeof u.totalTokens === 'number' ? u.totalTokens : input + output;
        lastTokens = { input, output, total };
      }
      queue.push({ kind: 'done', sessionId: lastSessionId, tokens: lastTokens });
    } catch (err) {
      queue.push({ kind: 'error', error: err as Error });
    }
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
