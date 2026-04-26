/**
 * SbxProvider — Docker AI Sandboxes (`sbx`) isolation.
 *
 * **Status: stub.** Phase 0 of the implementation plan
 * (`/home/archon/.claude/plans/plan-make-workflows-run-piped-karp.md`)
 * requires a hands-on feasibility spike against a real `sbx` host before
 * the runtime methods can be implemented. The spike command sheet lives at
 * `docs/research/sbx-feasibility.md`.
 *
 * Until the spike completes, the factory will instantiate this class only
 * when the user explicitly opts in via `isolation.provider: sbx`. Every
 * runtime method throws `SbxNotImplementedError` so the misconfiguration
 * is loud and impossible to miss.
 */

import { createLogger } from '@archon/paths';
import type { SbxConfig } from '../config';
import type {
  DestroyOptions,
  DestroyResult,
  IIsolationProvider,
  IsolatedEnvironment,
  IsolationRequest,
} from '../types';

const SPIKE_REFERENCE =
  'See docs/research/sbx-feasibility.md and complete the Phase 0 spike before enabling sbx.';

export class SbxNotImplementedError extends Error {
  constructor(method: string) {
    super(
      `SbxProvider.${method}() is not implemented yet (Docker Sandbox runtime not wired). ${SPIKE_REFERENCE}`
    );
    this.name = 'SbxNotImplementedError';
  }
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  cachedLog ??= createLogger('isolation.sbx');
  return cachedLog;
}

export class SbxProvider implements IIsolationProvider {
  readonly providerType = 'sbx';

  constructor(private readonly config: SbxConfig = {}) {
    getLog().info(
      {
        agent: this.config.agent,
        networkPolicy: this.config.networkPolicy,
        image: this.config.image,
        branchMode: this.config.branchMode ?? true,
      },
      'sbx.provider_constructed'
    );
  }

  /** Read-only access for tests and downstream wiring. */
  getConfig(): Readonly<SbxConfig> {
    return this.config;
  }

  create(_request: IsolationRequest): Promise<IsolatedEnvironment> {
    throw new SbxNotImplementedError('create');
  }

  destroy(_envId: string, _options?: DestroyOptions): Promise<DestroyResult> {
    throw new SbxNotImplementedError('destroy');
  }

  get(_envId: string): Promise<IsolatedEnvironment | null> {
    throw new SbxNotImplementedError('get');
  }

  list(_codebaseId: string): Promise<IsolatedEnvironment[]> {
    throw new SbxNotImplementedError('list');
  }

  healthCheck(_envId: string): Promise<boolean> {
    throw new SbxNotImplementedError('healthCheck');
  }
}
