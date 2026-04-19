/**
 * Unit tests for Linear adapter.
 *
 * Runs in its own bun test batch to avoid mock.module() pollution.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createHmac } from 'crypto';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const mockGetOrCreateConversation = mock(async () => ({
  id: 'conv-linear-test',
  platform_type: 'linear',
  platform_conversation_id: 'linear/ENG/ENG-123',
  codebase_id: null,
  cwd: null,
  isolation_env_id: null,
  ai_assistant_type: 'claude',
  title: null,
  hidden: false,
  deleted_at: null,
  last_activity_at: null,
  created_at: new Date(),
  updated_at: new Date(),
}));
const mockUpdateConversation = mock(async () => {});

mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  updateConversation: mockUpdateConversation,
}));

const mockFindCodebaseByName = mock(async () => ({
  id: 'codebase-test',
  name: 'my-org/my-repo',
  repository_url: 'https://github.com/my-org/my-repo',
  default_cwd: '/tmp/test-repo',
  ai_assistant_type: 'claude',
  allow_env_keys: false,
  commands: {},
  created_at: new Date(),
  updated_at: new Date(),
}));

mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByName: mockFindCodebaseByName,
}));

// `handleMessage` is the canonical orchestrator entry point. The adapter
// must route through it (not directly into the workflow executor).
const mockHandleMessage = mock(async () => undefined);

class MockConversationLockManager {}

mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  ConversationLockManager: MockConversationLockManager,
}));

const mockCreateComment = mock(async () => ({ success: true }));
const mockIssue = mock(async (identifier: string) => ({ id: `uuid-for-${identifier}` }));
const MockLinearClient = mock(() => ({
  createComment: mockCreateComment,
  issue: mockIssue,
}));

mock.module('@linear/sdk', () => ({
  LinearClient: MockLinearClient,
}));

import { LinearAdapter } from './adapter';
import { ConversationLockManager } from '@archon/core';

const WEBHOOK_SECRET = 'test-webhook-secret';

function signPayload(payload: string, secret = WEBHOOK_SECRET): string {
  const hmac = createHmac('sha256', secret);
  return hmac.update(payload).digest('hex');
}

function buildIssuePayload(
  overrides?: Partial<{
    action: string;
    type: string;
    stateType: string;
    assigneeName: string;
    teamKey: string;
    identifier: string;
    updatedFrom: Record<string, unknown> | undefined;
  }>
): string {
  const defaults = {
    action: 'update',
    type: 'Issue',
    stateType: 'started',
    assigneeName: 'archon',
    teamKey: 'ENG',
    identifier: 'ENG-123',
    updatedFrom: { stateId: 'old-state-id' },
  };
  const opts = { ...defaults, ...overrides };

  return JSON.stringify({
    action: opts.action,
    type: opts.type,
    data: {
      id: 'issue-uuid-123',
      identifier: opts.identifier,
      title: 'Implement user authentication',
      description: 'Add JWT-based auth to the API.',
      priority: 1,
      state: { id: 'state-1', name: 'In Progress', type: opts.stateType },
      assignee: opts.assigneeName
        ? { id: 'user-1', name: opts.assigneeName, displayName: opts.assigneeName }
        : undefined,
      team: { id: 'team-1', key: opts.teamKey, name: 'Engineering' },
      labels: [{ id: 'label-1', name: 'backend' }],
      url: `https://linear.app/my-org/issue/${opts.identifier}`,
    },
    updatedFrom: opts.updatedFrom,
    createdAt: new Date().toISOString(),
    organizationId: 'org-1',
  });
}

const mockLockManager = {
  acquireLock: mock(async (_id: string, handler: () => Promise<void>) => {
    await handler();
    return { status: 'started' };
  }),
  getStats: () => ({
    active: 0,
    queuedTotal: 0,
    queuedByConversation: [],
    maxConcurrent: 10,
    activeConversationIds: [],
  }),
} as unknown as ConversationLockManager;

function createAdapter(
  teamMappings: Record<string, string> = { ENG: 'my-org/my-repo' }
): LinearAdapter {
  return new LinearAdapter('fake-api-key', WEBHOOK_SECRET, mockLockManager, {
    assignee: 'archon',
    workflow: 'implement',
    mappings: teamMappings,
  });
}

describe('LinearAdapter', () => {
  beforeEach(() => {
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockCreateComment.mockClear();
    mockIssue.mockClear();
    mockGetOrCreateConversation.mockClear();
    mockUpdateConversation.mockClear();
    mockFindCodebaseByName.mockClear();
    mockHandleMessage.mockClear();
    (mockLockManager.acquireLock as ReturnType<typeof mock>).mockClear();
  });

  describe('platform interface', () => {
    test('returns batch streaming mode', () => {
      expect(createAdapter().getStreamingMode()).toBe('batch');
    });

    test('returns linear platform type', () => {
      expect(createAdapter().getPlatformType()).toBe('linear');
    });

    test('ensureThread returns same conversation ID', async () => {
      const id = await createAdapter().ensureThread('linear/ENG/ENG-123');
      expect(id).toBe('linear/ENG/ENG-123');
    });
  });

  describe('signature verification', () => {
    test('rejects invalid signature silently', async () => {
      const adapter = createAdapter();
      await adapter.handleWebhook(buildIssuePayload(), 'invalid-signature');

      expect(mockLogger.error).toHaveBeenCalledWith('linear.signature_verification_failed');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('accepts valid signature', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      await adapter.handleWebhook(payload, signPayload(payload));

      expect(mockLogger.error).not.toHaveBeenCalledWith('linear.signature_verification_failed');
    });
  });

  describe('event filtering', () => {
    test('ignores non-update actions', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload({ action: 'create' });
      await adapter.handleWebhook(payload, signPayload(payload));
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('ignores non-Issue types', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload({ type: 'Comment' });
      await adapter.handleWebhook(payload, signPayload(payload));
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('ignores updates without state change', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload({ updatedFrom: { title: 'Old title' } });
      await adapter.handleWebhook(payload, signPayload(payload));
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('ignores state changes that are not to "started"', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload({ stateType: 'completed' });
      await adapter.handleWebhook(payload, signPayload(payload));
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('ignores issues not assigned to target user', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload({ assigneeName: 'someone-else' });
      await adapter.handleWebhook(payload, signPayload(payload));
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('assignee matching is case-insensitive', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload({ assigneeName: 'Archon' });
      await adapter.handleWebhook(payload, signPayload(payload));
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('codebase resolution', () => {
    test('logs warning and posts comment when no team mapping exists', async () => {
      const adapter = createAdapter({ OTHER: 'other-repo' });
      const payload = buildIssuePayload({ teamKey: 'ENG' });
      await adapter.handleWebhook(payload, signPayload(payload));

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockCreateComment).toHaveBeenCalled();
      const body = mockCreateComment.mock.calls[0]?.[0] as { body: string };
      expect(body.body).toContain('No codebase mapping found');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test('logs error and posts comment when codebase not found in DB', async () => {
      mockFindCodebaseByName.mockResolvedValueOnce(null);
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      await adapter.handleWebhook(payload, signPayload(payload));

      expect(mockLogger.error).toHaveBeenCalled();
      expect(mockCreateComment).toHaveBeenCalled();
      const body = mockCreateComment.mock.calls[0]?.[0] as { body: string };
      expect(body.body).toContain('not found');
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });
  });

  describe('orchestrator dispatch', () => {
    test('calls handleMessage with synthesized slash command and rich issueContext', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      await adapter.handleWebhook(payload, signPayload(payload));

      expect(mockGetOrCreateConversation).toHaveBeenCalledWith('linear', 'linear/ENG/ENG-123');
      expect(mockUpdateConversation).toHaveBeenCalled();
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);

      const args = mockHandleMessage.mock.calls[0] as unknown[];
      expect(args[0]).toBe(adapter);
      expect(args[1]).toBe('linear/ENG/ENG-123');
      expect(args[2]).toBe('/workflow run implement');

      const ctx = args[3] as {
        issueContext: string;
        isolationHints: { workflowType: string; workflowId: string };
      };
      expect(ctx.issueContext).toContain('ENG-123');
      expect(ctx.issueContext).toContain('Implement user authentication');
      expect(ctx.issueContext).toContain('Urgent');
      expect(ctx.issueContext).toContain('backend');
      expect(ctx.issueContext).toContain('JWT-based auth');
      expect(ctx.isolationHints).toEqual({
        workflowType: 'issue',
        workflowId: 'ENG-123',
      });
    });

    test('skips re-linking codebase when conversation already linked', async () => {
      mockGetOrCreateConversation.mockResolvedValueOnce({
        id: 'conv-linear-test',
        platform_type: 'linear',
        platform_conversation_id: 'linear/ENG/ENG-123',
        codebase_id: 'codebase-test',
        cwd: null,
        isolation_env_id: null,
        ai_assistant_type: 'claude',
        title: null,
        hidden: false,
        deleted_at: null,
        last_activity_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      await adapter.handleWebhook(payload, signPayload(payload));

      expect(mockUpdateConversation).not.toHaveBeenCalled();
      expect(mockHandleMessage).toHaveBeenCalled();
    });

    test('posts error comment when handleMessage throws', async () => {
      mockHandleMessage.mockRejectedValueOnce(new Error('Boom'));
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      await adapter.handleWebhook(payload, signPayload(payload));

      expect(mockLogger.error).toHaveBeenCalled();
      const lastCall = mockCreateComment.mock.calls[
        mockCreateComment.mock.calls.length - 1
      ]?.[0] as { body: string };
      expect(lastCall.body).toContain('Failed to dispatch workflow');
      expect(lastCall.body).toContain('Boom');
    });
  });

  describe('sendMessage', () => {
    test('resolves issue UUID via Linear SDK on demand and posts comment', async () => {
      const adapter = createAdapter();
      await adapter.sendMessage('linear/ENG/ENG-123', 'Test message');

      expect(mockIssue).toHaveBeenCalledWith('ENG-123');
      expect(mockCreateComment).toHaveBeenCalledTimes(1);
      const call = mockCreateComment.mock.calls[0]?.[0] as { issueId: string; body: string };
      expect(call.issueId).toBe('uuid-for-ENG-123');
      expect(call.body).toBe('Test message');
    });

    test('throws on malformed conversationId', async () => {
      const adapter = createAdapter();
      await expect(adapter.sendMessage('slack/C123', 'x')).rejects.toThrow(
        'Invalid Linear conversationId'
      );
      expect(mockCreateComment).not.toHaveBeenCalled();
    });

    test('propagates createComment errors instead of swallowing', async () => {
      mockCreateComment.mockRejectedValueOnce(new Error('Linear API down'));
      const adapter = createAdapter();
      await expect(adapter.sendMessage('linear/ENG/ENG-123', 'x')).rejects.toThrow(
        'Linear API down'
      );
    });
  });
});
