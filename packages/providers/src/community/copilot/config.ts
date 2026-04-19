import type { CopilotProviderDefaults } from '../../types';

export type { CopilotProviderDefaults };

const VALID_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
type CopilotReasoningEffort = (typeof VALID_EFFORT_LEVELS)[number];

function isCopilotReasoningEffort(v: unknown): v is CopilotReasoningEffort {
  return typeof v === 'string' && (VALID_EFFORT_LEVELS as readonly string[]).includes(v);
}

/**
 * Parse raw YAML-derived config into typed Copilot defaults.
 * Defensive: invalid fields are dropped silently (matches parsePiConfig and
 * parseClaudeConfig — never throws, so broken user config can't prevent
 * provider registration or workflow discovery).
 */
export function parseCopilotConfig(raw: Record<string, unknown>): CopilotProviderDefaults {
  const result: CopilotProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }
  if (typeof raw.cliPath === 'string') {
    result.cliPath = raw.cliPath;
  }
  if (typeof raw.githubToken === 'string') {
    result.githubToken = raw.githubToken;
  }
  if (isCopilotReasoningEffort(raw.reasoningEffort)) {
    result.reasoningEffort = raw.reasoningEffort;
  }

  return result;
}
