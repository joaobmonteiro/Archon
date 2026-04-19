import type { ProviderCapabilities } from '../../types';

/**
 * Copilot v1 capabilities — intentionally conservative. Each `true` flag
 * MUST correspond to wired-up behavior; the dag-executor surfaces warnings
 * for any nodeConfig field a provider declares as unsupported. Honest
 * under-declaration beats silent ignoring.
 *
 * v1 wires:
 *   - sessionResume: SDK exposes listSessions / resumeSession / getLastSessionId
 *   - effortControl: SDK supports `reasoningEffort: low|medium|high|xhigh`
 *   - envInjection:  per-codebase env vars are passed into the spawned CLI
 *
 * Roadmap (flip per follow-up PR as plumbing lands):
 *   - mcp:                permission type 'mcp' exists; configuration path TBD
 *   - toolRestrictions:   map allowed_tools / denied_tools to Copilot's gate model
 *   - skills:             if Copilot exposes a system-prompt or skill slot
 *   - structuredOutput:   if SDK adds JSON-schema response support
 *   - thinkingControl:    distinct from effort; not exposed in current SDK
 *   - costControl:        SDK doesn't surface per-request cost in current docs
 *   - hooks / sandbox:    no SDK equivalents in current docs
 */
export const COPILOT_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
