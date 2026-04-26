import { describe, test, expect } from 'bun:test';
import { SbxProvider, SbxNotImplementedError } from './sbx';
import type { TaskIsolationRequest } from '../types';
import { toRepoPath } from '@archon/git';

describe('SbxProvider (stub)', () => {
  const mkRequest = (): TaskIsolationRequest => ({
    workflowType: 'task',
    identifier: 'phase-zero',
    codebaseId: 'cb-1',
    canonicalRepoPath: toRepoPath('/tmp/repo'),
  });

  test('providerType is sbx', () => {
    expect(new SbxProvider().providerType).toBe('sbx');
  });

  test('preserves the supplied SbxConfig', () => {
    const provider = new SbxProvider({
      agent: 'claude',
      networkPolicy: 'balanced',
      image: 'docker/sbx-claude:edge',
      branchMode: false,
    });
    expect(provider.getConfig()).toEqual({
      agent: 'claude',
      networkPolicy: 'balanced',
      image: 'docker/sbx-claude:edge',
      branchMode: false,
    });
  });

  test('every runtime method throws SbxNotImplementedError', () => {
    const provider = new SbxProvider();

    expect(() => provider.create(mkRequest())).toThrow(SbxNotImplementedError);
    expect(() => provider.destroy('sbx-id')).toThrow(SbxNotImplementedError);
    expect(() => provider.get('sbx-id')).toThrow(SbxNotImplementedError);
    expect(() => provider.list('cb-1')).toThrow(SbxNotImplementedError);
    expect(() => provider.healthCheck('sbx-id')).toThrow(SbxNotImplementedError);
  });

  test('error message points at the spike doc so misconfig is loud', () => {
    const provider = new SbxProvider();
    try {
      provider.create(mkRequest());
      throw new Error('expected throw');
    } catch (e) {
      const err = e as Error;
      expect(err).toBeInstanceOf(SbxNotImplementedError);
      expect(err.message).toContain('docs/research/sbx-feasibility.md');
    }
  });
});
