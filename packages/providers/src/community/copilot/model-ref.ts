/**
 * Registry-level `isModelCompatible` check for Copilot.
 *
 * The Copilot SDK accepts named model strings (`gpt-5`, `claude-sonnet-4.5`,
 * `gpt-4.1`, …) and also lets callers point at custom BYOK provider/model
 * strings. The catalog moves quickly and is best validated at runtime by
 * the SDK itself (which surfaces a clear error for unknown models).
 *
 * Archon's compatibility check is therefore *syntactic only*: any non-empty
 * string is accepted. Provider inference from model name is unreliable for
 * Copilot anyway (its model strings overlap with Codex's), so workflows that
 * want Copilot should set `provider: copilot` explicitly on the node.
 */
export function isCopilotModelCompatible(model: string): boolean {
  return typeof model === 'string' && model.length > 0;
}
