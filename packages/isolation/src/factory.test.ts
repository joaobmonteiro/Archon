import { describe, test, expect, afterEach } from 'bun:test';
import {
  getIsolationProvider,
  resetIsolationProvider,
  configureIsolation,
  setIsolationProviderType,
} from './factory';
import { SbxProvider } from './providers/sbx';
import { WorktreeProvider } from './providers/worktree';

describe('Isolation Provider Factory', () => {
  afterEach(() => {
    resetIsolationProvider();
  });

  test('getIsolationProvider returns same instance on repeated calls', () => {
    const first = getIsolationProvider();
    const second = getIsolationProvider();
    expect(first).toBe(second);
  });

  test('resetIsolationProvider clears singleton so next call returns new instance', () => {
    const first = getIsolationProvider();
    resetIsolationProvider();
    const second = getIsolationProvider();
    expect(first).not.toBe(second);
  });

  test('configureIsolation resets singleton', () => {
    const first = getIsolationProvider();
    configureIsolation(async () => null);
    const second = getIsolationProvider();
    expect(first).not.toBe(second);
  });

  test('default provider is WorktreeProvider', () => {
    const provider = getIsolationProvider();
    expect(provider).toBeInstanceOf(WorktreeProvider);
    expect(provider.providerType).toBe('worktree');
  });

  test("setIsolationProviderType('sbx') returns SbxProvider with the supplied config", () => {
    setIsolationProviderType('sbx', { agent: 'claude', networkPolicy: 'balanced' });
    const provider = getIsolationProvider();
    expect(provider).toBeInstanceOf(SbxProvider);
    expect(provider.providerType).toBe('sbx');
    expect((provider as SbxProvider).getConfig()).toEqual({
      agent: 'claude',
      networkPolicy: 'balanced',
    });
  });

  test('switching provider type resets the singleton', () => {
    const worktree = getIsolationProvider();
    setIsolationProviderType('sbx');
    const sbx = getIsolationProvider();
    expect(sbx).not.toBe(worktree);
    expect(sbx).toBeInstanceOf(SbxProvider);

    setIsolationProviderType('worktree');
    const backToWorktree = getIsolationProvider();
    expect(backToWorktree).toBeInstanceOf(WorktreeProvider);
    expect(backToWorktree).not.toBe(worktree);
  });

  test('reserved provider types throw a clear error', () => {
    setIsolationProviderType('container');
    expect(() => getIsolationProvider()).toThrow(/reserved but not yet implemented/);

    setIsolationProviderType('vm');
    expect(() => getIsolationProvider()).toThrow(/reserved but not yet implemented/);

    setIsolationProviderType('remote');
    expect(() => getIsolationProvider()).toThrow(/reserved but not yet implemented/);
  });

  test('resetIsolationProvider also reverts to the worktree default', () => {
    setIsolationProviderType('sbx', { agent: 'codex' });
    expect(getIsolationProvider()).toBeInstanceOf(SbxProvider);
    resetIsolationProvider();
    expect(getIsolationProvider()).toBeInstanceOf(WorktreeProvider);
  });
});
