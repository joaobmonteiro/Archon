/**
 * Linear webhook event type definitions.
 * Based on Linear's webhook API: https://linear.app/docs/webhooks
 */

export interface LinearWebhookPayload {
  action: 'create' | 'update' | 'remove';
  type: 'Issue' | 'Comment' | (string & {});
  data: LinearIssueData | LinearCommentData;
  /** Previous values for updated fields (only present on 'update' actions) */
  updatedFrom?: Record<string, unknown>;
  createdAt: string;
  organizationId: string;
}

export interface LinearIssueState {
  id: string;
  name: string;
  /** Linear state type — 'started' corresponds to "In Progress" */
  type: string;
}

export interface LinearAssignee {
  id: string;
  name: string;
  displayName: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearLabel {
  id: string;
  name: string;
}

export interface LinearIssueData {
  id: string;
  /** Human-readable identifier, e.g. "ENG-123" */
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: LinearIssueState;
  assignee?: LinearAssignee;
  team: LinearTeam;
  labels: LinearLabel[];
  url: string;
  project?: { id: string; name: string };
}

export interface LinearCommentData {
  id: string;
  body: string;
  issueId: string;
  userId: string;
  issue: { id: string; identifier: string };
}

/**
 * Type guard: check if webhook data is an issue payload. Performs a structural
 * check so a malformed payload with `type: 'Issue'` but the wrong shape does
 * not slip past discriminator checks downstream.
 */
export function isIssueData(
  payload: LinearWebhookPayload
): payload is LinearWebhookPayload & { data: LinearIssueData } {
  if (payload.type !== 'Issue') return false;
  const data = payload.data as Partial<LinearIssueData> | null | undefined;
  if (!data || typeof data !== 'object') return false;
  return (
    typeof data.id === 'string' &&
    typeof data.identifier === 'string' &&
    typeof data.state === 'object' &&
    data.state !== null &&
    typeof data.state.type === 'string' &&
    typeof data.team === 'object' &&
    data.team !== null &&
    typeof data.team.key === 'string'
  );
}
