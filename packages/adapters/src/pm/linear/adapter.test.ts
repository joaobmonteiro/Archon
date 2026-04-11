/**
 * Unit tests for Linear adapter
 *
 * Runs in its own bun test batch to avoid mock.module() pollution.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createHmac } from 'crypto';

// Mock logger before importing anything that uses it
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
  getArchonHome: mock(() => '/tmp/archon-test'),
}));

// Mock database modules
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

// Mock workflow execution dependencies
const mockExecuteWorkflow = mock(async () => ({
  success: true as const,
  workflowRunId: 'run-123',
  summary: 'Workflow completed successfully.',
}));

mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));

const mockResolveWorkflowName = mock((_name: string) => ({
  name: 'implement',
  description: 'Implement changes',
  nodes: [],
}));

mock.module('@archon/workflows/router', () => ({
  resolveWorkflowName: mockResolveWorkflowName,
}));

const mockDiscoverWorkflowsWithConfig = mock(async () => ({
  workflows: [
    {
      workflow: { name: 'implement', description: 'Implement changes', nodes: [] },
      source: 'bundled' as const,
    },
  ],
  errors: [],
}));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflowsWithConfig,
}));

// Mock isolation resolution
const mockValidateAndResolveIsolation = mock(async () => ({
  cwd: '/tmp/test-worktree',
}));

mock.module('@archon/core/orchestrator', () => ({
  validateAndResolveIsolation: mockValidateAndResolveIsolation,
}));

// Mock workflow deps
mock.module('@archon/core/workflows/store-adapter', () => ({
  createWorkflowDeps: mock(() => ({
    store: {},
    getAssistantClient: mock(),
    loadConfig: mock(),
  })),
}));

// Mock config loader
mock.module('@archon/core', () => ({
  loadConfig: mock(async () => ({})),
}));

// Mock @linear/sdk
const mockCreateComment = mock(async () => ({ success: true }));
const MockLinearClient = mock(() => ({
  createComment: mockCreateComment,
}));

mock.module('@linear/sdk', () => ({
  LinearClient: MockLinearClient,
}));

// Mock @archon/isolation
mock.module('@archon/isolation', () => ({
  IsolationBlockedError: class IsolationBlockedError extends Error {
    reason: string;
    constructor(message: string, reason: string) {
      super(message);
      this.name = 'IsolationBlockedError';
      this.reason = reason;
    }
  },
}));

// Now import the adapter under test
import { LinearAdapter } from './adapter';
import { ConversationLockManager } from '@archon/core';

// ─── Helpers ───────────────────────────────────────────────────────────────

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

// Create a mock lock manager that immediately executes handlers
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
  return new LinearAdapter(
    'fake-api-key',
    WEBHOOK_SECRET,
    mockLockManager,
    'archon',
    'implement',
    new Map(Object.entries(teamMappings))
  );
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('LinearAdapter', () => {
  beforeEach(() => {
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockCreateComment.mockClear();
    mockGetOrCreateConversation.mockClear();
    mockUpdateConversation.mockClear();
    mockFindCodebaseByName.mockClear();
    mockExecuteWorkflow.mockClear();
    mockResolveWorkflowName.mockClear();
    mockDiscoverWorkflowsWithConfig.mockClear();
    mockValidateAndResolveIsolation.mockClear();
    (mockLockManager.acquireLock as ReturnType<typeof mock>).mockClear();
  });

  describe('platform interface', () => {
    test('returns batch streaming mode', () => {
      const adapter = createAdapter();
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('returns linear platform type', () => {
      const adapter = createAdapter();
      expect(adapter.getPlatformType()).toBe('linear');
    });

    test('ensureThread returns same conversation ID', async () => {
      const adapter = createAdapter();
      const id = await adapter.ensureThread('linear/ENG/ENG-123');
      expect(id).toBe('linear/ENG/ENG-123');
    });
  });

  describe('signature verification', () => {
    test('rejects invalid signature silently', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      await adapter.handleWebhook(payload, 'invalid-signature');

      expect(mockLogger.error).toHaveBeenCalledWith('linear.signature_verification_failed');
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });

    test('accepts valid signature', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      // Should proceed past signature verification
      expect(mockLogger.error).not.toHaveBeenCalledWith('linear.signature_verification_failed');
    });
  });

  describe('event filtering', () => {
    test('ignores non-update actions', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload({ action: 'create' });
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });

    test('ignores non-Issue types', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload({ type: 'Comment' });
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });

    test('ignores updates without state change', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload({ updatedFrom: { title: 'Old title' } });
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });

    test('ignores state changes that are not to "started"', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload({ stateType: 'completed' });
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });

    test('ignores issues not assigned to target user', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload({ assigneeName: 'someone-else' });
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });

    test('assignee matching is case-insensitive', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload({ assigneeName: 'Archon' });
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      // Should proceed to workflow execution
      expect(mockExecuteWorkflow).toHaveBeenCalled();
    });
  });

  describe('codebase resolution', () => {
    test('logs warning and posts comment when no team mapping exists', async () => {
      const adapter = createAdapter({ PLATFORM: 'other-repo' });
      const payload = buildIssuePayload({ teamKey: 'ENG' });
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockCreateComment).toHaveBeenCalled();
      const commentBody = mockCreateComment.mock.calls[0]?.[0] as { issueId: string; body: string };
      expect(commentBody.body).toContain('No codebase mapping found');
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });

    test('logs error and posts comment when codebase not found in DB', async () => {
      mockFindCodebaseByName.mockResolvedValueOnce(null);
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      expect(mockLogger.error).toHaveBeenCalled();
      expect(mockCreateComment).toHaveBeenCalled();
      const commentBody = mockCreateComment.mock.calls[0]?.[0] as { issueId: string; body: string };
      expect(commentBody.body).toContain('not found');
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('workflow resolution', () => {
    test('logs error when workflow not found', async () => {
      mockResolveWorkflowName.mockReturnValueOnce(
        undefined as unknown as ReturnType<typeof mockResolveWorkflowName>
      );
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      expect(mockLogger.error).toHaveBeenCalled();
      expect(mockCreateComment).toHaveBeenCalled();
      const commentBody = mockCreateComment.mock.calls[0]?.[0] as { issueId: string; body: string };
      expect(commentBody.body).toContain('not found');
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('workflow execution', () => {
    test('executes workflow on valid trigger', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      expect(mockGetOrCreateConversation).toHaveBeenCalledWith('linear', 'linear/ENG/ENG-123');
      expect(mockUpdateConversation).toHaveBeenCalled();
      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    });

    test('posts start notification before execution', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      // First comment: start notification, second: summary
      expect(mockCreateComment).toHaveBeenCalled();
      const firstCall = mockCreateComment.mock.calls[0]?.[0] as { body: string };
      expect(firstCall.body).toContain('Starting workflow');
    });

    test('posts summary on successful completion', async () => {
      mockExecuteWorkflow.mockResolvedValueOnce({
        success: true as const,
        workflowRunId: 'run-456',
        summary: 'All tasks completed.',
      });
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      // Last comment should be the summary
      const lastCall = mockCreateComment.mock.calls[
        mockCreateComment.mock.calls.length - 1
      ]?.[0] as { body: string };
      expect(lastCall.body).toContain('All tasks completed.');
    });

    test('posts error on workflow failure', async () => {
      mockExecuteWorkflow.mockResolvedValueOnce({
        success: false as const,
        error: 'Node "build" failed',
      });
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      const lastCall = mockCreateComment.mock.calls[
        mockCreateComment.mock.calls.length - 1
      ]?.[0] as { body: string };
      expect(lastCall.body).toContain('failed');
      expect(lastCall.body).toContain('Node "build" failed');
    });
  });

  describe('context message', () => {
    test('builds context with issue details', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      // The context message is the 6th argument to executeWorkflow
      const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
      const contextMessage = callArgs[5] as string;
      expect(contextMessage).toContain('ENG-123');
      expect(contextMessage).toContain('Implement user authentication');
      expect(contextMessage).toContain('Urgent');
      expect(contextMessage).toContain('backend');
      expect(contextMessage).toContain('JWT-based auth');
    });
  });

  describe('sendMessage', () => {
    test('posts comment with bot marker', async () => {
      const adapter = createAdapter();
      // Trigger a webhook to populate issueIdMap
      const payload = buildIssuePayload();
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      mockCreateComment.mockClear();
      await adapter.sendMessage('linear/ENG/ENG-123', 'Test message');

      expect(mockCreateComment).toHaveBeenCalledTimes(1);
      const call = mockCreateComment.mock.calls[0]?.[0] as { issueId: string; body: string };
      expect(call.issueId).toBe('issue-uuid-123');
      expect(call.body).toContain('<!-- archon-bot-response -->');
      expect(call.body).toContain('Test message');
    });

    test('warns when issue ID not found for conversation', async () => {
      const adapter = createAdapter();
      await adapter.sendMessage('linear/UNKNOWN/UNKNOWN-1', 'Test');

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockCreateComment).not.toHaveBeenCalled();
    });
  });

  describe('isolation', () => {
    test('passes correct isolation hints', async () => {
      const adapter = createAdapter();
      const payload = buildIssuePayload();
      const signature = signPayload(payload);
      await adapter.handleWebhook(payload, signature);

      const call = mockValidateAndResolveIsolation.mock.calls[0] as unknown[];
      const hints = call[4] as IsolationHints;
      expect(hints).toEqual({
        workflowType: 'issue',
        workflowId: 'ENG-123',
      });
    });
  });
});

// Type import for test assertions
import type { IsolationHints } from '@archon/isolation';
