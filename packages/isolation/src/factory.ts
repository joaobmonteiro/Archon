/**
 * Isolation Provider Factory
 *
 * Centralized factory for isolation providers with config injection.
 * Defaults to `WorktreeProvider`. `SbxProvider` (Docker AI Sandboxes) is
 * opt-in via `setIsolationProviderType('sbx', sbxConfig)` — typically driven
 * by `.archon/config.yaml`'s `isolation:` block.
 */

import type { IIsolationProvider, IsolationProviderType, RepoConfigLoader } from './types';
import type { SbxConfig } from './config';
import { WorktreeProvider } from './providers/worktree';
import { SbxProvider } from './providers/sbx';

let provider: IIsolationProvider | null = null;
let configuredLoader: RepoConfigLoader = () => Promise.resolve(null);
let configuredProviderType: IsolationProviderType = 'worktree';
let configuredSbxConfig: SbxConfig = {};

/**
 * Configure the isolation system with a repo config loader.
 * Must be called before getIsolationProvider() for full functionality.
 * If not called, WorktreeProvider uses a no-op loader (no custom baseBranch, copyFiles, or path).
 */
export function configureIsolation(loader: RepoConfigLoader): void {
  configuredLoader = loader;
  provider = null; // Reset singleton so it picks up new loader
}

/**
 * Select which isolation provider the factory should instantiate.
 *
 * Call this after reading `.archon/config.yaml` for the active repo and
 * before invoking `getIsolationProvider()`. Resets the singleton so the
 * next call returns a fresh provider of the requested type.
 *
 * Currently supported: `'worktree'` (default) and `'sbx'`. Other values
 * defined on `IsolationProviderType` (`'container'`, `'vm'`, `'remote'`)
 * are reserved and will throw until implemented.
 */
export function setIsolationProviderType(
  type: IsolationProviderType,
  sbxConfig: SbxConfig = {}
): void {
  configuredProviderType = type;
  configuredSbxConfig = sbxConfig;
  provider = null;
}

/**
 * Get the isolation provider instance (singleton). Defaults to
 * `WorktreeProvider`; returns `SbxProvider` if `setIsolationProviderType`
 * selected sbx.
 */
export function getIsolationProvider(): IIsolationProvider {
  if (provider) return provider;

  switch (configuredProviderType) {
    case 'worktree':
      provider = new WorktreeProvider(configuredLoader);
      return provider;
    case 'sbx':
      provider = new SbxProvider(configuredSbxConfig);
      return provider;
    case 'container':
    case 'vm':
    case 'remote':
      throw new Error(
        `Isolation provider '${configuredProviderType}' is reserved but not yet implemented. ` +
          "Use 'worktree' (default) or 'sbx'."
      );
  }
}

/**
 * Reset the isolation provider (for testing). Also clears the configured
 * provider type back to the default.
 */
export function resetIsolationProvider(): void {
  provider = null;
  configuredProviderType = 'worktree';
  configuredSbxConfig = {};
}
