import { describe, expect, mock, test } from 'bun:test';

import { resolveCopilotSession } from './session-resolver';

interface FakeClient {
  createSession: ReturnType<typeof mock>;
  resumeSession: ReturnType<typeof mock>;
}

function makeClient(opts?: {
  createReturns?: unknown;
  resumeImpl?: (id: string) => Promise<unknown>;
}): FakeClient {
  return {
    createSession: mock(async () => opts?.createReturns ?? { __kind: 'fresh' }),
    resumeSession: mock(opts?.resumeImpl ?? (async () => ({ __kind: 'resumed' }))),
  };
}

describe('resolveCopilotSession', () => {
  const config = { model: 'gpt-5', onPermissionRequest: () => 'approved' as const };

  test('creates a fresh session when no resumeSessionId provided', async () => {
    const client = makeClient();
    const out = await resolveCopilotSession(client as never, undefined, config as never);
    expect(out.resumeFailed).toBe(false);
    expect(client.createSession.mock.calls.length).toBe(1);
    expect(client.resumeSession.mock.calls.length).toBe(0);
  });

  test('resumes an existing session', async () => {
    const client = makeClient();
    const out = await resolveCopilotSession(client as never, 'sess-1', config as never);
    expect(out.resumeFailed).toBe(false);
    expect(client.resumeSession.mock.calls.length).toBe(1);
    expect(client.createSession.mock.calls.length).toBe(0);
  });

  test('falls back to fresh session when resume throws (resumeFailed: true)', async () => {
    const client = makeClient({
      resumeImpl: async () => {
        throw new Error('session not found');
      },
    });
    const out = await resolveCopilotSession(client as never, 'missing-id', config as never);
    expect(out.resumeFailed).toBe(true);
    expect(client.createSession.mock.calls.length).toBe(1);
    expect(client.resumeSession.mock.calls.length).toBe(1);
  });
});
