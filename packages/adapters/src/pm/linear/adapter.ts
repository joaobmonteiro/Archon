/**
 * Linear platform adapter — triggers workflows when issues move to "In Progress".
 * Webhook-driven (no polling), follows the forge adapter pattern (GitHub, Gitea).
 */
import { LinearClient } from '@linear/sdk';
import type { IPlatformAdapter, MessageMetadata, Conversation } from '@archon/core';
import type { IsolationHints } from '@archon/isolation';
import { IsolationBlockedError } from '@archon/isolation';
import { ConversationLockManager } from '@archon/core';
import { createWorkflowDeps } from '@archon/core/workflows/store-adapter';
import { validateAndResolveIsolation } from '@archon/core/orchestrator';
import * as db from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import { loadConfig } from '@archon/core';
import { executeWorkflow } from '@archon/workflows/executor';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName } from '@archon/workflows/router';
import { getArchonHome } from '@archon/paths';
import { createLogger } from '@archon/paths';
import { verifyLinearSignature, isTargetAssignee } from './auth';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import type { LinearWebhookPayload, LinearIssueData } from './types';
import { isIssueData } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.linear');
  return cachedLog;
}

/** Max comment length (Linear has no strict limit, but keep comments reasonable) */
const MAX_LENGTH = 65000;

/** Hidden marker added to bot comments to prevent self-triggering loops */
const BOT_RESPONSE_MARKER = '<!-- archon-bot-response -->';

/** Map Linear priority numbers to human-readable labels */
const PRIORITY_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

export class LinearAdapter implements IPlatformAdapter {
  private readonly linearClient: LinearClient;
  private readonly webhookSecret: string;
  private readonly lockManager: ConversationLockManager;
  private readonly targetAssignee: string;
  private readonly defaultWorkflow: string;
  private readonly teamCodebaseMap: Map<string, string>;
  /** Maps conversationId → Linear issue ID (UUID) for comment posting */
  private readonly issueIdMap = new Map<string, string>();

  constructor(
    apiKey: string,
    webhookSecret: string,
    lockManager: ConversationLockManager,
    targetAssignee = 'archon',
    defaultWorkflow = 'implement',
    teamCodebaseMap: Map<string, string> = new Map()
  ) {
    this.linearClient = new LinearClient({ apiKey });
    this.webhookSecret = webhookSecret;
    this.lockManager = lockManager;
    this.targetAssignee = targetAssignee;
    this.defaultWorkflow = defaultWorkflow;
    this.teamCodebaseMap = teamCodebaseMap;
  }

  // ─── IPlatformAdapter ───────────────────────────────────────────────────────

  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    const issueId = this.issueIdMap.get(conversationId);
    if (!issueId) {
      getLog().warn({ conversationId }, 'linear.send_message_no_issue_id');
      return;
    }

    const chunks = splitIntoParagraphChunks(message, MAX_LENGTH);
    for (const chunk of chunks) {
      const body = `${BOT_RESPONSE_MARKER}\n${chunk}`;
      try {
        await this.linearClient.createComment({ issueId, body });
      } catch (error) {
        getLog().error(
          { err: error as Error, issueId, conversationId },
          'linear.comment_create_failed'
        );
      }
    }
  }

  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    // Linear issues are inherently threaded — no-op
    return originalConversationId;
  }

  getStreamingMode(): 'stream' | 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return 'linear';
  }

  async start(): Promise<void> {
    getLog().info('linear_adapter_started');
  }

  stop(): void {
    getLog().info('linear_adapter_stopped');
  }

  // ─── Webhook Processing ─────────────────────────────────────────────────────

  async handleWebhook(payload: string, signature: string): Promise<void> {
    // 1. Verify signature
    if (!verifyLinearSignature(payload, signature, this.webhookSecret)) {
      getLog().error('linear.signature_verification_failed');
      return;
    }

    // 2. Parse payload
    let event: LinearWebhookPayload;
    try {
      event = JSON.parse(payload) as LinearWebhookPayload;
    } catch {
      getLog().error('linear.payload_parse_failed');
      return;
    }

    // 3. Only process issue update events where the state changed
    if (event.action !== 'update' || !isIssueData(event) || !event.updatedFrom?.stateId) {
      return;
    }

    const issue = event.data;

    // 4. Only trigger when state transitions to "started" (In Progress)
    if (issue.state.type !== 'started') {
      return;
    }

    // 5. Only trigger if assigned to the configured target
    if (!isTargetAssignee(issue.assignee?.displayName, this.targetAssignee)) {
      return;
    }

    getLog().info(
      {
        issueId: issue.identifier,
        team: issue.team.key,
        assignee: issue.assignee?.displayName,
      },
      'linear.issue_triggered'
    );

    // 6. Dispatch within conversation lock
    const conversationId = `linear/${issue.team.key}/${issue.identifier}`;

    await this.lockManager.acquireLock(conversationId, async () => {
      await this.processIssue(conversationId, issue);
    });
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async processIssue(conversationId: string, issue: LinearIssueData): Promise<void> {
    // Track issue ID for comment posting
    this.issueIdMap.set(conversationId, issue.id);

    // Resolve codebase from team mapping
    const codebaseName = this.teamCodebaseMap.get(issue.team.key);
    if (!codebaseName) {
      getLog().warn(
        { teamKey: issue.team.key, issueId: issue.identifier },
        'linear.no_team_mapping'
      );
      await this.postErrorComment(
        issue.id,
        `No codebase mapping found for team **${issue.team.key}**. ` +
          'Configure `linear.mappings` in `~/.archon/config.yaml`.'
      );
      return;
    }

    const codebase = await codebaseDb.findCodebaseByName(codebaseName);
    if (!codebase) {
      getLog().error(
        { codebaseName, teamKey: issue.team.key, issueId: issue.identifier },
        'linear.codebase_not_found'
      );
      await this.postErrorComment(
        issue.id,
        `Codebase **${codebaseName}** not found. Register it first via the web UI or \`/clone\`.`
      );
      return;
    }

    // Get or create conversation
    const conversation = await db.getOrCreateConversation('linear', conversationId);
    await db.updateConversation(conversation.id, { codebase_id: codebase.id });

    // Discover workflows and find the configured one
    const cwd = codebase.default_cwd;
    const { workflows: workflowEntries } = await discoverWorkflowsWithConfig(cwd, loadConfig, {
      globalSearchPath: getArchonHome(),
    });
    const allWorkflows = workflowEntries.map(w => w.workflow);
    const workflow = resolveWorkflowName(this.defaultWorkflow, allWorkflows);

    if (!workflow) {
      getLog().error(
        { workflowName: this.defaultWorkflow, issueId: issue.identifier },
        'linear.workflow_not_found'
      );
      await this.postErrorComment(
        issue.id,
        `Workflow **${this.defaultWorkflow}** not found. ` +
          'Check `.archon/workflows/` in the repository or Archon defaults.'
      );
      return;
    }

    // Resolve isolation (worktree)
    const isolationHints: IsolationHints = {
      workflowType: 'issue',
      workflowId: issue.identifier,
    };

    let resolvedCwd: string;
    try {
      const result = await validateAndResolveIsolation(
        { ...conversation, codebase_id: codebase.id } as Conversation,
        codebase,
        this,
        conversationId,
        isolationHints
      );
      resolvedCwd = result.cwd;
    } catch (error) {
      if (error instanceof IsolationBlockedError) {
        getLog().warn(
          { reason: error.reason, conversationId, issueId: issue.identifier },
          'linear.isolation_blocked'
        );
        return; // User already notified via sendMessage → Linear comment
      }
      throw error;
    }

    // Build context message
    const contextMessage = this.buildContextMessage(issue);

    // Notify that work is starting
    await this.sendMessage(
      conversationId,
      `Starting workflow **${workflow.name}** for this issue.`
    );

    // Execute workflow
    try {
      const result = await executeWorkflow(
        createWorkflowDeps(),
        this,
        conversationId,
        resolvedCwd,
        workflow,
        contextMessage,
        conversation.id,
        codebase.id
      );

      if (!result.success) {
        await this.sendMessage(
          conversationId,
          `Workflow **${workflow.name}** failed: ${result.error}`
        );
      } else if (!('paused' in result) && result.summary) {
        await this.sendMessage(conversationId, result.summary);
      }
    } catch (error) {
      getLog().error(
        { err: error as Error, workflowName: workflow.name, issueId: issue.identifier },
        'linear.workflow_execution_failed'
      );
      await this.sendMessage(
        conversationId,
        `Workflow **${workflow.name}** failed unexpectedly. Check Archon logs for details.`
      );
    }
  }

  private buildContextMessage(issue: LinearIssueData): string {
    const priority = PRIORITY_LABELS[issue.priority] ?? `Priority ${issue.priority}`;
    const labels = issue.labels.map(l => l.name).join(', ') || 'none';
    const description = issue.description?.trim() || '(No description provided)';

    return [
      `## Linear Issue: ${issue.identifier}`,
      '',
      `**Title:** ${issue.title}`,
      `**Team:** ${issue.team.name}`,
      `**Priority:** ${priority}`,
      `**Labels:** ${labels}`,
      '',
      '### Description',
      '',
      description,
      '',
      '---',
      '',
      'Implement the changes described in this Linear issue.',
    ].join('\n');
  }

  private async postErrorComment(issueId: string, message: string): Promise<void> {
    try {
      await this.linearClient.createComment({
        issueId,
        body: `${BOT_RESPONSE_MARKER}\n${message}`,
      });
    } catch (error) {
      getLog().error({ err: error as Error, issueId }, 'linear.error_comment_failed');
    }
  }
}
