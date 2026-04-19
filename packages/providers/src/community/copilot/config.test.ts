import { describe, expect, test } from 'bun:test';

import { parseCopilotConfig } from './config';

describe('parseCopilotConfig', () => {
  test('parses all valid fields', () => {
    expect(
      parseCopilotConfig({
        model: 'claude-sonnet-4.5',
        cliPath: '/usr/local/bin/copilot',
        githubToken: 'ghp_abc',
        reasoningEffort: 'high',
      })
    ).toEqual({
      model: 'claude-sonnet-4.5',
      cliPath: '/usr/local/bin/copilot',
      githubToken: 'ghp_abc',
      reasoningEffort: 'high',
    });
  });

  test('drops invalid model type silently', () => {
    expect(parseCopilotConfig({ model: 123 })).toEqual({});
  });

  test('drops invalid reasoningEffort silently', () => {
    expect(parseCopilotConfig({ reasoningEffort: 'ultra' })).toEqual({});
    expect(parseCopilotConfig({ reasoningEffort: 'max' })).toEqual({});
    expect(parseCopilotConfig({ reasoningEffort: 5 })).toEqual({});
  });

  test('accepts each valid effort level', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh'] as const) {
      expect(parseCopilotConfig({ reasoningEffort: e })).toEqual({ reasoningEffort: e });
    }
  });

  test('ignores unknown keys', () => {
    expect(parseCopilotConfig({ futureField: 'x', model: 'gpt-5' })).toEqual({ model: 'gpt-5' });
  });

  test('returns empty object for empty input', () => {
    expect(parseCopilotConfig({})).toEqual({});
  });

  test('does not throw on malformed input', () => {
    expect(() => parseCopilotConfig({ model: null })).not.toThrow();
    expect(() => parseCopilotConfig({ cliPath: [] })).not.toThrow();
    expect(() => parseCopilotConfig({ githubToken: {} })).not.toThrow();
  });
});
