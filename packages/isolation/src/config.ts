/**
 * User-facing config shapes for the isolation system.
 *
 * Lives in `@archon/isolation` (not `@archon/core`) so the provider layer can
 * own its own contract. `@archon/core/config` re-exports `IsolationConfig`
 * into `RepoConfig` so users can write `isolation: { provider: 'sbx', ... }`
 * in `.archon/config.yaml`.
 */

import type { IsolationProviderType } from './types';

/**
 * `sbx` (Docker AI Sandbox) provider config.
 *
 * Active only when `isolation.provider: 'sbx'`. `SbxProvider` itself is a
 * stub pending the Phase 0 feasibility spike (see
 * `docs/research/sbx-feasibility.md`); these fields define the eventual
 * surface so callers can opt in via config today and the implementation
 * lights up when it lands.
 */
export interface SbxConfig {
  /**
   * `sbx` agent preset to launch (e.g. `claude`, `codex`, `generic`).
   * Maps directly to `sbx run <agent>`. Default chosen at provider-create
   * time when undefined.
   */
  agent?: string;

  /**
   * Network policy applied to the sandbox.
   * - `open`: all outbound traffic allowed
   * - `balanced`: common dev sites allowed (recommended)
   * - `locked-down`: deny by default; only explicit allows
   */
  networkPolicy?: 'open' | 'balanced' | 'locked-down';

  /**
   * Optional custom sandbox image. When omitted, sbx uses its agent-preset
   * default.
   */
  image?: string;

  /**
   * Use sbx's `--branch` mode (per-branch isolated worktree under `.sbx/`).
   * Defaults to `true`; set to `false` for shared-FS sandboxes.
   */
  branchMode?: boolean;
}

/**
 * Top-level isolation config block in `.archon/config.yaml`.
 *
 * @example
 * ```yaml
 * isolation:
 *   provider: sbx
 *   sbx:
 *     agent: claude
 *     networkPolicy: balanced
 * ```
 *
 * When omitted, `WorktreeProvider` is used (preserving today's behavior).
 */
export interface IsolationConfig {
  /**
   * Which isolation strategy to use for this repository.
   * @default 'worktree'
   */
  provider?: IsolationProviderType;

  /** sbx-specific options. Ignored unless `provider === 'sbx'`. */
  sbx?: SbxConfig;
}
