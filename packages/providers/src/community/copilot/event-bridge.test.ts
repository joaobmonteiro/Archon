import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Import AFTER mocks.
import {
  AsyncQueue,
  bridgeCopilotSession,
  serializeToolResult,
  type BridgeQueueItem,
} from './event-bridge';

// ─── Fake session ────────────────────────────────────────────────────────
//
// Minimal EventEmitter-style stub matching the subset of CopilotSession the
// bridge consumes: `on`, `off`, `send`, `disconnect`. Tests script events
// by calling `fireEvent(name, payload)` after `bridgeCopilotSession` has
// subscribed, then resolving the prompt.

interface FakeSession {
  id: string;
  on: ReturnType<typeof mock>;
  off: ReturnType<typeof mock>;
  send: ReturnType<typeof mock>;
  disconnect: ReturnType<typeof mock>;
  emit: (event: string, payload?: unknown) => void;
}

function makeFakeSession(): FakeSession {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const session: FakeSession = {
    id: 'sess-uuid-1',
    on: mock((event: string, h: (payload: unknown) => void) => {
      let bucket = handlers.get(event);
      if (!bucket) {
        bucket = new Set();
        handlers.set(event, bucket);
      }
      bucket.add(h);
    }),
    off: mock((event: string, h: (payload: unknown) => void) => {
      handlers.get(event)?.delete(h);
    }),
    send: mock(async () => undefined),
    disconnect: mock(async () => undefined),
    emit: (event, payload) => {
      const bucket = handlers.get(event);
      if (!bucket) return;
      for (const h of bucket) h(payload);
    },
  };
  return session;
}

async function consume(
  generator: AsyncGenerator<unknown>
): Promise<{ chunks: unknown[]; error?: Error }> {
  const chunks: unknown[] = [];
  try {
    for await (const chunk of generator) chunks.push(chunk);
    return { chunks };
  } catch (err) {
    return { chunks, error: err as Error };
  }
}

// ─── AsyncQueue tests ────────────────────────────────────────────────────

describe('AsyncQueue', () => {
  test('delivers buffered items in order', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    const out: number[] = [];
    for await (const n of q) {
      out.push(n);
      if (out.length === 3) break;
    }
    expect(out).toEqual([1, 2, 3]);
  });

  test('throws if iterated twice', () => {
    const q = new AsyncQueue<number>();
    void q[Symbol.asyncIterator]();
    expect(() => q[Symbol.asyncIterator]()).toThrow('single-consumer invariant');
  });
});

// ─── serializeToolResult ─────────────────────────────────────────────────

describe('serializeToolResult', () => {
  test('passes strings through', () => {
    expect(serializeToolResult('hello')).toBe('hello');
  });
  test('JSON-encodes objects', () => {
    expect(serializeToolResult({ a: 1 })).toBe('{"a":1}');
  });
  test('handles null/undefined', () => {
    expect(serializeToolResult(null)).toBe('');
    expect(serializeToolResult(undefined)).toBe('');
  });
  test('falls back to String() for non-serializable values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serializeToolResult(circular)).toBe('[object Object]');
  });
});

// ─── bridgeCopilotSession ────────────────────────────────────────────────

describe('bridgeCopilotSession', () => {
  let session: FakeSession;

  beforeEach(() => {
    session = makeFakeSession();
  });

  test('emits assistant chunks from message_delta events and ends on idle', async () => {
    // Override `send` to fire scripted events then resolve.
    session.send.mockImplementation(async () => {
      session.emit('assistant.message_delta', { deltaContent: 'Hello ' });
      session.emit('assistant.message_delta', { deltaContent: 'world' });
      session.emit('session.idle', {
        sessionId: 'sess-uuid-1',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
    });

    const { chunks, error } = await consume(
      bridgeCopilotSession(session as never, 'hi')
    );
    expect(error).toBeUndefined();
    expect(chunks).toEqual([
      { type: 'assistant', content: 'Hello ' },
      { type: 'assistant', content: 'world' },
      {
        type: 'result',
        sessionId: 'sess-uuid-1',
        tokens: { input: 10, output: 5, total: 15 },
      },
    ]);
  });

  test('emits thinking chunks from reasoning_delta events', async () => {
    session.send.mockImplementation(async () => {
      session.emit('assistant.reasoning_delta', { deltaContent: 'pondering…' });
      session.emit('session.idle', {});
    });
    const { chunks } = await consume(bridgeCopilotSession(session as never, 'hi'));
    expect(chunks[0]).toEqual({ type: 'thinking', content: 'pondering…' });
  });

  test('emits tool + tool_result chunks from execution events', async () => {
    session.send.mockImplementation(async () => {
      session.emit('tool.execution_start', {
        toolName: 'shell',
        args: { cmd: 'ls' },
        toolCallId: 'call-1',
      });
      session.emit('tool.execution_complete', {
        toolName: 'shell',
        result: 'file.txt',
        toolCallId: 'call-1',
      });
      session.emit('session.idle', {});
    });
    const { chunks } = await consume(bridgeCopilotSession(session as never, 'hi'));
    expect(chunks).toEqual([
      { type: 'tool', toolName: 'shell', toolInput: { cmd: 'ls' }, toolCallId: 'call-1' },
      {
        type: 'tool_result',
        toolName: 'shell',
        toolOutput: 'file.txt',
        toolCallId: 'call-1',
      },
      { type: 'result' },
    ]);
  });

  test('prepends a system warning when a tool errors', async () => {
    session.send.mockImplementation(async () => {
      session.emit('tool.execution_complete', {
        toolName: 'shell',
        result: 'error: permission denied',
        toolCallId: 'call-1',
        isError: true,
      });
      session.emit('session.idle', {});
    });
    const { chunks } = await consume(bridgeCopilotSession(session as never, 'hi'));
    expect(chunks[0]).toMatchObject({ type: 'system', content: expect.stringContaining('failed') });
    expect(chunks[1]).toMatchObject({ type: 'tool_result', toolName: 'shell' });
  });

  test('throws when an error event is emitted', async () => {
    session.send.mockImplementation(async () => {
      session.emit('error', { message: 'rate limited' });
    });
    const { error } = await consume(bridgeCopilotSession(session as never, 'hi'));
    expect(error?.message).toBe('rate limited');
  });

  test('throws when send() rejects', async () => {
    session.send.mockImplementation(async () => {
      throw new Error('connection refused');
    });
    const { error } = await consume(bridgeCopilotSession(session as never, 'hi'));
    expect(error?.message).toBe('connection refused');
  });

  test('removes listeners on completion', async () => {
    session.send.mockImplementation(async () => {
      session.emit('session.idle', {});
    });
    await consume(bridgeCopilotSession(session as never, 'hi'));
    // Each registered handler should have been removed.
    expect(session.off.mock.calls.length).toBeGreaterThan(0);
  });

  test('forwards aborted signal to disconnect()', async () => {
    const ac = new AbortController();
    session.send.mockImplementation(async () => {
      ac.abort();
      session.emit('session.idle', {});
    });
    await consume(bridgeCopilotSession(session as never, 'hi', ac.signal));
    expect(session.disconnect.mock.calls.length).toBeGreaterThan(0);
  });

  test('emits compaction_start as a system message', async () => {
    session.send.mockImplementation(async () => {
      session.emit('session.compaction_start', {});
      session.emit('session.idle', {});
    });
    const { chunks } = await consume(bridgeCopilotSession(session as never, 'hi'));
    expect(chunks[0]).toMatchObject({ type: 'system', content: expect.stringContaining('compact') });
  });

  test('drops empty deltaContent', async () => {
    session.send.mockImplementation(async () => {
      session.emit('assistant.message_delta', { deltaContent: '' });
      session.emit('assistant.message_delta', { deltaContent: 'x' });
      session.emit('session.idle', {});
    });
    const { chunks } = await consume(bridgeCopilotSession(session as never, 'hi'));
    expect(chunks).toEqual([
      { type: 'assistant', content: 'x' },
      { type: 'result' },
    ]);
  });
});

// Type-only check — exists to keep `BridgeQueueItem` in the public surface.
const _typeCheck: BridgeQueueItem | undefined = undefined;
void _typeCheck;
