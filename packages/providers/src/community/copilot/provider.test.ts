import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// ─── Mock @github/copilot-sdk ────────────────────────────────────────────
//
// CopilotClient is constructed per-call: `new CopilotClient(opts)` then
// `start()`, then `createSession`/`resumeSession`, then `stop()`. The
// session is a plain EventEmitter-shaped object the bridge subscribes to.

interface FakeSession {
  id: string;
  on: ReturnType<typeof mock>;
  off: ReturnType<typeof mock>;
  send: ReturnType<typeof mock>;
  disconnect: ReturnType<typeof mock>;
  emit: (event: string, payload?: unknown) => void;
}

function makeFakeSession(id: string): FakeSession {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    id,
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
    emit: (event, payload) => handlers.get(event)?.forEach(h => h(payload)),
  };
}

let lastClientOptions: unknown;
let fakeSession: FakeSession;
let createSessionImpl: (config: unknown) => Promise<FakeSession> = async () => fakeSession;
let resumeSessionImpl: (id: string, config: unknown) => Promise<FakeSession> = async () =>
  fakeSession;
let startImpl: () => Promise<void> = async () => undefined;

const mockClientStart = mock(async () => startImpl());
const mockClientStop = mock(async () => undefined);
const mockCreateSession = mock(async (config: unknown) => createSessionImpl(config));
const mockResumeSession = mock(async (id: string, config: unknown) => resumeSessionImpl(id, config));

class MockCopilotClient {
  constructor(opts: unknown) {
    lastClientOptions = opts;
  }
  start = mockClientStart;
  stop = mockClientStop;
  createSession = mockCreateSession;
  resumeSession = mockResumeSession;
}

const mockApproveAll = mock(() => 'approved');

mock.module('@github/copilot-sdk', () => ({
  CopilotClient: MockCopilotClient,
  approveAll: mockApproveAll,
}));

// Import AFTER mocks.
import { COPILOT_CAPABILITIES } from './capabilities';
import { CopilotProvider } from './provider';

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

describe('CopilotProvider', () => {
  beforeEach(() => {
    fakeSession = makeFakeSession('sess-1');
    lastClientOptions = undefined;
    createSessionImpl = async () => fakeSession;
    resumeSessionImpl = async () => fakeSession;
    startImpl = async () => undefined;
    mockClientStart.mockClear();
    mockClientStop.mockClear();
    mockCreateSession.mockClear();
    mockResumeSession.mockClear();
    mockApproveAll.mockClear();
    delete process.env.COPILOT_CLI_PATH;
    delete process.env.COPILOT_GITHUB_TOKEN;
  });

  test('getType returns "copilot"', () => {
    expect(new CopilotProvider().getType()).toBe('copilot');
  });

  test('getCapabilities matches COPILOT_CAPABILITIES constant', () => {
    expect(new CopilotProvider().getCapabilities()).toEqual(COPILOT_CAPABILITIES);
  });

  test('throws when no model is configured', async () => {
    const { error } = await consume(new CopilotProvider().sendQuery('hi', '/tmp'));
    expect(error?.message).toContain('Copilot provider requires a model');
  });

  test('passes cwd, model, and effort to the client + session', async () => {
    fakeSession.send.mockImplementation(async () => fakeSession.emit('session.idle', {}));
    const provider = new CopilotProvider();
    await consume(
      provider.sendQuery('hi', '/repo', undefined, {
        model: 'claude-sonnet-4.5',
        nodeConfig: { effort: 'high' },
      })
    );
    expect(lastClientOptions).toMatchObject({ cwd: '/repo' });
    expect(mockCreateSession.mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-sonnet-4.5',
      reasoningEffort: 'high',
      streaming: true,
    });
  });

  test('uses cliPath from assistantConfig and githubToken from env', async () => {
    process.env.COPILOT_GITHUB_TOKEN = 'ghp_test';
    fakeSession.send.mockImplementation(async () => fakeSession.emit('session.idle', {}));
    await consume(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        model: 'gpt-5',
        assistantConfig: { cliPath: '/opt/copilot' },
      })
    );
    expect(lastClientOptions).toMatchObject({
      cwd: '/repo',
      cliPath: '/opt/copilot',
      githubToken: 'ghp_test',
    });
  });

  test('passes per-call env to the client', async () => {
    fakeSession.send.mockImplementation(async () => fakeSession.emit('session.idle', {}));
    await consume(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        model: 'gpt-5',
        env: { ACME_TOKEN: 'secret', LOG_LEVEL: 'debug' },
      })
    );
    expect(lastClientOptions).toMatchObject({
      env: { ACME_TOKEN: 'secret', LOG_LEVEL: 'debug' },
    });
  });

  test('uses approveAll for permission requests', async () => {
    fakeSession.send.mockImplementation(async () => fakeSession.emit('session.idle', {}));
    await consume(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, { model: 'gpt-5' })
    );
    const config = mockCreateSession.mock.calls[0]?.[0] as { onPermissionRequest?: unknown };
    expect(config.onPermissionRequest).toBe(mockApproveAll);
  });

  test('streams a result chunk with sessionId after idle', async () => {
    fakeSession.send.mockImplementation(async () => {
      fakeSession.emit('assistant.message_delta', { deltaContent: 'hi!' });
      fakeSession.emit('session.idle', {
        sessionId: 'sess-uuid-42',
        usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      });
    });
    const { chunks, error } = await consume(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, { model: 'gpt-5' })
    );
    expect(error).toBeUndefined();
    expect(chunks).toEqual([
      { type: 'assistant', content: 'hi!' },
      {
        type: 'result',
        sessionId: 'sess-uuid-42',
        tokens: { input: 3, output: 1, total: 4 },
      },
    ]);
  });

  test('emits resume_failed warning when resume throws', async () => {
    resumeSessionImpl = async () => {
      throw new Error('not found');
    };
    fakeSession.send.mockImplementation(async () => fakeSession.emit('session.idle', {}));
    const { chunks } = await consume(
      new CopilotProvider().sendQuery('hi', '/repo', 'missing-id', { model: 'gpt-5' })
    );
    expect(chunks[0]).toMatchObject({
      type: 'system',
      content: expect.stringContaining('resume Copilot session'),
    });
  });

  test('emits effort warning for unknown effort string', async () => {
    fakeSession.send.mockImplementation(async () => fakeSession.emit('session.idle', {}));
    const { chunks } = await consume(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, {
        model: 'gpt-5',
        nodeConfig: { effort: 'ultra' },
      })
    );
    expect(chunks[0]).toMatchObject({
      type: 'system',
      content: expect.stringContaining('ultra'),
    });
  });

  test('throws actionable error when client.start() fails (CLI missing)', async () => {
    startImpl = async () => {
      throw new Error('spawn copilot ENOENT');
    };
    const { error } = await consume(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, { model: 'gpt-5' })
    );
    expect(error?.message).toContain('Failed to start Copilot client');
    expect(error?.message).toContain('gh extension install github/gh-copilot');
  });

  test('always calls client.stop() and session.disconnect() in finally', async () => {
    fakeSession.send.mockImplementation(async () => fakeSession.emit('session.idle', {}));
    await consume(
      new CopilotProvider().sendQuery('hi', '/repo', undefined, { model: 'gpt-5' })
    );
    expect(mockClientStop.mock.calls.length).toBe(1);
    expect(fakeSession.disconnect.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
