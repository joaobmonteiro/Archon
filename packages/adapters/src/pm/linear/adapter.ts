/**
 * Linear platform adapter — triggers a workflow when an issue assigned to the
 * configured user transitions to "In Progress". Routes through the standard
 * orchestrator entry point (`handleMessage`) so paused-run handling, slash
 * command processing, and any future orchestrator behaviour apply uniformly.
 */
import { LinearClient } from '@linear/sdk';
import type { IPlatformAdapter, MessageMetadata, LinearConfig } from '@archon/core';
import type { IsolationHints } from '@archon/isolation';
import { ConversationLockManager, handleMessage } from '@archon/core';
import * as db from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import { createLogger } from '@archon/paths';
import { verifyLinearSignature, isTargetAssignee } from './auth';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import type { LinearWebhookPayload, LinearIssueData } from './types';
import { isIssueData } from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.linear');
  return cachedLog;
}

const MAX_LENGTH = 65000;

const PRIORITY_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

const CONVERSATION_ID_PREFIX = 'linear/';

interface ParsedConversationId {
  team: string;
  identifier: string;
}

/**
 * Parse a `linear/{team}/{identifier}` conversationId. Returns undefined for
 * conversation IDs from other platforms or malformed strings.
 */
function parseConversationId(conversationId: string): ParsedConversationId | undefined {
  if (!conversationId.startsWith(CONVERSATION_ID_PREFIX)) return undefined;
  const rest = conversationId.slice(CONVERSATION_ID_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { team: rest.slice(0, slash), identifier: rest.slice(slash + 1) };
}

export class LinearAdapter implements IPlatformAdapter {
  private readonly linearClient: LinearClient;
  private readonly webhookSecret: string;
  private readonly lockManager: ConversationLockManager;
  private readonly targetAssignee: string;
  private readonly defaultWorkflow: string;
  private readonly teamCodebaseMap: ReadonlyMap<string, string>;

  constructor(
    apiKey: string,
    webhookSecret: string,
    lockManager: ConversationLockManager,
    config: LinearConfig = {}
  ) {
    this.linearClient = new LinearClient({ apiKey });
    this.webhookSecret = webhookSecret;
    this.lockManager = lockManager;
    this.targetAssignee = config.assignee ?? 'archon';
    this.defaultWorkflow = config.workflow ?? 'implement';
    this.teamCodebaseMap = new Map(Object.entries(config.mappings ?? {}));
  }

  // ─── IPlatformAdapter ───────────────────────────────────────────────────────

  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: MessageMetadata
  ): Promise<void> {
    const issueId = await this.resolveIssueUuid(conversationId);
    const chunks = splitIntoParagraphChunks(message, MAX_LENGTH);
    for (const chunk of chunks) {
      await this.linearClient.createComment({ issueId, body: chunk });
    }
  }

  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  getStreamingMode(): 'stream' | 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return 'linear';
  }

  async start(): Promise<void> {
    getLog().info('linear.adapter_started');
  }

  stop(): void {
    getLog().info('linear.adapter_stopped');
  }

  // ─── Webhook Processing ─────────────────────────────────────────────────────

  async handleWebhook(payload: string, signature: string): Promise<void> {
    if (!verifyLinearSignature(payload, signature, this.webhookSecret)) {
      getLog().error('linear.signature_verification_failed');
      return;
    }

    let event: LinearWebhookPayload;
    try {
      event = JSON.parse(payload) as LinearWebhookPayload;
    } catch {
      getLog().error('linear.payload_parse_failed');
      return;
    }

    // Only process issue update events with a state transition.
    if (event.action !== 'update' || !isIssueData(event) || !event.updatedFrom?.stateId) {
      return;
    }

    const issue = event.data;

    // Only trigger when state transitions to "started" (In Progress).
    if (issue.state.type !== 'started') return;

    if (!isTargetAssignee(issue.assignee?.displayName, this.targetAssignee)) return;

    getLog().info(
      {
        issueId: issue.identifier,
        team: issue.team.key,
        assignee: issue.assignee?.displayName,
      },
      'linear.issue_triggered'
    );

    const conversationId = `${CONVERSATION_ID_PREFIX}${issue.team.key}/${issue.identifier}`;

    await this.lockManager.acquireLock(conversationId, async () => {
      await this.processIssue(conversationId, issue);
    });
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  private async processIssue(conversationId: string, issue: LinearIssueData): Promise<void> {
    const codebaseName = this.teamCodebaseMap.get(issue.team.key);
    if (!codebaseName) {
      getLog().warn(
        { teamKey: issue.team.key, issueId: issue.identifier },
        'linear.no_team_mapping'
      );
      await this.sendMessage(
        conversationId,
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
      await this.sendMessage(
        conversationId,
        `Codebase **${codebaseName}** not found. Register it first via the web UI or \`/clone\`.`
      );
      return;
    }

    // Link conversation → codebase BEFORE handing off to the orchestrator,
    // mirroring the GitHub adapter pattern (forge/github/adapter.ts).
    const conversation = await db.getOrCreateConversation('linear', conversationId);
    if (conversation.codebase_id !== codebase.id) {
      await db.updateConversation(conversation.id, { codebase_id: codebase.id });
    }

    const isolationHints: IsolationHints = {
      workflowType: 'issue',
      workflowId: issue.identifier,
    };

    const issueContext = this.buildIssueContext(issue);
    const finalMessage = `/workflow run ${this.defaultWorkflow}`;

    try {
      await handleMessage(this, conversationId, finalMessage, {
        issueContext,
        isolationHints,
      });
    } catch (error) {
      getLog().error(
        { err: error as Error, issueId: issue.identifier, workflow: this.defaultWorkflow },
        'linear.handle_message_failed'
      );
      await this.sendMessage(
        conversationId,
        `Failed to dispatch workflow **${this.defaultWorkflow}**: ${(error as Error).message}`
      );
    }
  }

  private buildIssueContext(issue: LinearIssueData): string {
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

  /**
   * Resolve a Linear issue UUID from a conversationId. Linear's `issue` query
   * accepts either the UUID or the human identifier (e.g. "ENG-123"), so we
   * derive it on demand from the conversationId rather than caching in memory
   * (which would break across restarts).
   */
  private async resolveIssueUuid(conversationId: string): Promise<string> {
    const parsed = parseConversationId(conversationId);
    if (!parsed) {
      throw new Error(`Invalid Linear conversationId: ${conversationId}`);
    }
    const issue = await this.linearClient.issue(parsed.identifier);
    return issue.id;
  }
}
