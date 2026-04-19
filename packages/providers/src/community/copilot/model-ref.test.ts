import { describe, expect, test } from 'bun:test';

import { isCopilotModelCompatible } from './model-ref';

describe('isCopilotModelCompatible', () => {
  test('accepts standard Copilot model strings', () => {
    expect(isCopilotModelCompatible('claude-sonnet-4.5')).toBe(true);
    expect(isCopilotModelCompatible('gpt-5')).toBe(true);
    expect(isCopilotModelCompatible('gpt-4.1')).toBe(true);
  });

  test('accepts BYOK / custom strings (validated at SDK runtime)', () => {
    expect(isCopilotModelCompatible('any/custom-byok-model')).toBe(true);
    expect(isCopilotModelCompatible('vendor:model:v1')).toBe(true);
  });

  test('rejects empty string', () => {
    expect(isCopilotModelCompatible('')).toBe(false);
  });
});
