import { isRegisteredProvider, registerProvider } from '../../registry';

import { COPILOT_CAPABILITIES } from './capabilities';
import { isCopilotModelCompatible } from './model-ref';
import { CopilotProvider } from './provider';

/**
 * Register the GitHub Copilot community provider.
 *
 * Idempotent — safe to call multiple times, so process entrypoints (CLI,
 * server, config-loader) can each call it without coordination. Same Phase 2
 * contract as Pi: `builtIn: false` is load-bearing while the SDK is in public
 * preview; promote to built-in only once the integration is proven stable.
 */
export function registerCopilotProvider(): void {
  if (isRegisteredProvider('copilot')) return;
  registerProvider({
    id: 'copilot',
    displayName: 'GitHub Copilot (community)',
    factory: () => new CopilotProvider(),
    capabilities: COPILOT_CAPABILITIES,
    isModelCompatible: isCopilotModelCompatible,
    builtIn: false,
  });
}
