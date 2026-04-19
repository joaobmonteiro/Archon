import type { NodeConfig } from '../../types';

// ─── Reasoning effort ──────────────────────────────────────────────────────

/**
 * Copilot SDK accepts `reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh'`.
 *
 * Archon's surface mixes Codex's `'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`
 * (with `off` from Codex's `modelReasoningEffort`) and Claude's `EffortLevel`
 * enum (`low | medium | high | max`, where `max` is Claude-only). Map to
 * Copilot's vocabulary:
 *   - 'off'                → undefined (no explicit effort)
 *   - 'max'                → 'xhigh'
 *   - 'minimal'            → 'low'   (Copilot has no minimal tier)
 *   - 'low'/'medium'/'high'/'xhigh' → pass through
 */
export type CopilotEffort = 'low' | 'medium' | 'high' | 'xhigh';

const COPILOT_NATIVE_EFFORTS: ReadonlySet<CopilotEffort> = new Set<CopilotEffort>([
  'low',
  'medium',
  'high',
  'xhigh',
]);

function normalizeToCopilotEffort(v: unknown): CopilotEffort | undefined {
  if (typeof v !== 'string') return undefined;
  if (v === 'max') return 'xhigh';
  if (v === 'minimal') return 'low';
  if (COPILOT_NATIVE_EFFORTS.has(v as CopilotEffort)) return v as CopilotEffort;
  return undefined;
}

export interface ResolvedCopilotEffort {
  /** Effort to pass to Copilot, or undefined for SDK default. */
  effort: CopilotEffort | undefined;
  /** Human-readable warning to surface as a system chunk, if input wasn't usable. */
  warning?: string;
}

/**
 * Resolve Archon's `effort` / `thinking` node fields → Copilot's `reasoningEffort`.
 *
 * Precedence: `effort` > `thinking` (mirroring Codex's behavior — Copilot
 * doesn't separate them, so we collapse to one knob).
 * 'off' on either field → undefined (no explicit effort sent).
 * Object-form `thinking` (Claude shape) → warning, not applied.
 */
export function resolveCopilotEffort(
  nodeConfig?: NodeConfig,
  configDefault?: CopilotEffort
): ResolvedCopilotEffort {
  if (!nodeConfig) {
    return { effort: configDefault };
  }

  const { thinking, effort } = nodeConfig;

  if (effort === 'off' || thinking === 'off') {
    return { effort: undefined };
  }

  const fromEffort = normalizeToCopilotEffort(effort);
  if (fromEffort) return { effort: fromEffort };

  const fromThinking = normalizeToCopilotEffort(thinking);
  if (fromThinking) return { effort: fromThinking };

  // Claude's `{ type: 'enabled', budget_tokens: N }` shape — Copilot doesn't
  // understand it. Surface so users can fix YAML.
  if (thinking !== undefined && thinking !== null && typeof thinking === 'object') {
    return {
      effort: configDefault,
      warning:
        'Copilot ignored `thinking` (object form is Claude-specific). Use `effort: low|medium|high|max` (max → xhigh on Copilot).',
    };
  }

  // Unknown string (e.g. 'ultra') — warn so users fix it.
  if (typeof thinking === 'string' || typeof effort === 'string') {
    const offender = typeof effort === 'string' ? effort : thinking;
    return {
      effort: configDefault,
      warning: `Copilot ignored unknown effort level '${String(offender)}'. Valid: low, medium, high, xhigh, max, minimal, off.`,
    };
  }

  return { effort: configDefault };
}

// ─── Environment injection ─────────────────────────────────────────────────

/**
 * Build the env map handed to the spawned `copilot` CLI process.
 *
 * Precedence (later wins on key collision):
 *   1. process.env (inherited)
 *   2. assistantConfig env (if any — currently not surfaced via Copilot config)
 *   3. requestOptions.env (per-codebase env vars from .archon/config.yaml `env:`)
 *
 * We do NOT pass `process.env` ourselves — the spawned child inherits it
 * automatically. We only pass the *additional* / overriding keys, matching
 * the Claude provider's pattern.
 */
export function resolveCopilotEnv(
  requestEnv?: Record<string, string>
): Record<string, string> | undefined {
  if (!requestEnv || Object.keys(requestEnv).length === 0) return undefined;
  return { ...requestEnv };
}
