import { describe, expect, test } from 'bun:test';

import { resolveCopilotEffort, resolveCopilotEnv } from './options-translator';

describe('resolveCopilotEffort', () => {
  test('returns config default when no nodeConfig', () => {
    expect(resolveCopilotEffort(undefined, 'medium')).toEqual({ effort: 'medium' });
    expect(resolveCopilotEffort(undefined, undefined)).toEqual({ effort: undefined });
  });

  test('passes through native Copilot levels from effort', () => {
    expect(resolveCopilotEffort({ effort: 'low' }).effort).toBe('low');
    expect(resolveCopilotEffort({ effort: 'medium' }).effort).toBe('medium');
    expect(resolveCopilotEffort({ effort: 'high' }).effort).toBe('high');
    expect(resolveCopilotEffort({ effort: 'xhigh' }).effort).toBe('xhigh');
  });

  test("maps 'max' → 'xhigh'", () => {
    expect(resolveCopilotEffort({ effort: 'max' }).effort).toBe('xhigh');
  });

  test("maps 'minimal' → 'low'", () => {
    expect(resolveCopilotEffort({ effort: 'minimal' }).effort).toBe('low');
  });

  test("'off' on effort returns undefined", () => {
    expect(resolveCopilotEffort({ effort: 'off' }, 'high').effort).toBeUndefined();
  });

  test("'off' on thinking returns undefined", () => {
    expect(resolveCopilotEffort({ thinking: 'off' }, 'high').effort).toBeUndefined();
  });

  test('effort takes precedence over thinking', () => {
    expect(resolveCopilotEffort({ effort: 'low', thinking: 'high' }).effort).toBe('low');
  });

  test('falls back to thinking when effort is unknown', () => {
    const r = resolveCopilotEffort({ effort: 'ultra', thinking: 'medium' });
    expect(r.effort).toBe('medium');
  });

  test('warns on Claude-shape thinking object', () => {
    const r = resolveCopilotEffort({ thinking: { type: 'enabled', budget_tokens: 5000 } });
    expect(r.effort).toBeUndefined();
    expect(r.warning).toContain('Claude-specific');
  });

  test('warns on unknown string effort', () => {
    const r = resolveCopilotEffort({ effort: 'ultra' });
    expect(r.warning).toContain("'ultra'");
  });

  test('config default applies when nodeConfig has no relevant fields', () => {
    expect(resolveCopilotEffort({ allowed_tools: ['read'] }, 'high').effort).toBe('high');
  });
});

describe('resolveCopilotEnv', () => {
  test('returns undefined for empty/missing env', () => {
    expect(resolveCopilotEnv(undefined)).toBeUndefined();
    expect(resolveCopilotEnv({})).toBeUndefined();
  });

  test('returns a copy of the env map', () => {
    const env = { FOO: 'bar', BAZ: 'qux' };
    const out = resolveCopilotEnv(env);
    expect(out).toEqual(env);
    expect(out).not.toBe(env); // ensures we copied (caller may mutate)
  });
});
