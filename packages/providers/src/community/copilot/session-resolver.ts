import type { CopilotClient, CopilotSession, SessionConfig } from '@github/copilot-sdk';

/**
 * Result of resolving an Archon `resumeSessionId` against Copilot's session store.
 */
export interface ResolvedCopilotSession {
  /** The Copilot session — fresh or resumed. */
  session: CopilotSession;
  /**
   * True when a resumeSessionId was provided but resume failed (session not
   * found, or SDK threw). Caller surfaces a system warning before continuing.
   * Mirrors the Pi/Codex provider fallback pattern.
   */
  resumeFailed: boolean;
}

/**
 * Resolve a Copilot session for a sendQuery call.
 *
 * Behavior:
 *  - No resumeSessionId → `client.createSession(config)`.
 *  - resumeSessionId provided → `client.resumeSession(id, config)`. On failure,
 *    fall back to a fresh session and report `resumeFailed: true`.
 *
 * Copilot persists session state (plan.md, checkpoints/, files/) under
 * `~/.copilot/session-state/<sessionId>/`. Archon holds the opaque session
 * ID and passes it back as `resumeSessionId` on the next call.
 */
export async function resolveCopilotSession(
  client: CopilotClient,
  resumeSessionId: string | undefined,
  config: SessionConfig
): Promise<ResolvedCopilotSession> {
  if (!resumeSessionId) {
    return { session: await client.createSession(config), resumeFailed: false };
  }

  try {
    const resumed = await client.resumeSession(resumeSessionId, config);
    return { session: resumed, resumeFailed: false };
  } catch {
    // Resume failed (most often: session ID not found in ~/.copilot/session-state/).
    // Fall through to a fresh session and let the caller surface a warning.
    return { session: await client.createSession(config), resumeFailed: true };
  }
}
