// --- Types ---
export type {
  IsolationProviderType,
  IsolationWorkflowType,
  EnvironmentStatus,
  IssueIsolationRequest,
  PRIsolationRequest,
  ReviewIsolationRequest,
  ThreadIsolationRequest,
  TaskIsolationRequest,
  IsolationRequest,
  AdoptedWorktreeMetadata,
  CreatedWorktreeMetadata,
  WorktreeMetadata,
  WorktreeEnvironment,
  SbxEnvironment,
  SbxEnvironmentMetadata,
  IsolatedEnvironment,
  DestroyOptions,
  WorktreeDestroyOptions,
  DestroyResult,
  IIsolationProvider,
  IsolationHints,
  IsolationBlockReason,
  IsolationEnvironmentRow,
  WorktreeCreateConfig,
  RepoConfigLoader,
  WorktreeStatusBreakdown,
  CreateEnvironmentParams,
  ResolveRequest,
  ResolutionMethod,
  IsolationResolution,
} from './types';

// --- Config (.archon/config.yaml shapes) ---
export type { IsolationConfig, SbxConfig } from './config';

export { isPRIsolationRequest } from './types';

// --- Store ---
export type { IIsolationStore } from './store';

// --- Errors ---
export { IsolationBlockedError, classifyIsolationError } from './errors';

// --- Factory ---
export {
  getIsolationProvider,
  configureIsolation,
  setIsolationProviderType,
  resetIsolationProvider,
} from './factory';

// --- Resolver ---
export { IsolationResolver } from './resolver';
export type { IsolationResolverDeps } from './resolver';

// --- Provider ---
export { WorktreeProvider } from './providers/worktree';
export { SbxProvider, SbxNotImplementedError } from './providers/sbx';

// --- PR state lookup ---
export { getPrState } from './pr-state';
export type { PrState } from './pr-state';

// --- Worktree copy utility ---
export {
  copyWorktreeFiles,
  copyWorktreeFile,
  parseCopyFileEntry,
  isPathWithinRoot,
} from './worktree-copy';
export type { CopyFileEntry } from './worktree-copy';
