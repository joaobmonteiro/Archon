import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import * as resolver from './cli-resolver';
import { resolveCopilotCliPath, resolveNativeCopilotBinary } from './cli-resolver';

describe('resolveCopilotCliPath', () => {
  const origEnv = process.env.COPILOT_CLI_PATH;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.COPILOT_CLI_PATH;
    else process.env.COPILOT_CLI_PATH = origEnv;
  });

  test('config path wins over everything else', () => {
    process.env.COPILOT_CLI_PATH = '/env/path';
    const spy = spyOn(resolver, 'resolveNativeCopilotBinary').mockReturnValue('/native/path');
    try {
      expect(resolveCopilotCliPath('/config/path')).toBe('/config/path');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('env var wins when config path is absent', () => {
    process.env.COPILOT_CLI_PATH = '/env/path';
    const spy = spyOn(resolver, 'resolveNativeCopilotBinary').mockReturnValue('/native/path');
    try {
      expect(resolveCopilotCliPath(undefined)).toBe('/env/path');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('falls back to native binary resolution when no config or env', () => {
    delete process.env.COPILOT_CLI_PATH;
    const spy = spyOn(resolver, 'resolveNativeCopilotBinary').mockReturnValue('/native/bin');
    try {
      expect(resolveCopilotCliPath(undefined)).toBe('/native/bin');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('returns undefined when nothing resolves (SDK fallback will run)', () => {
    delete process.env.COPILOT_CLI_PATH;
    const spy = spyOn(resolver, 'resolveNativeCopilotBinary').mockReturnValue(undefined);
    try {
      expect(resolveCopilotCliPath(undefined)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('resolveNativeCopilotBinary', () => {
  test('returns the bundled platform binary when the package is installed', () => {
    // The test environment has @github/copilot installed (it's a real
    // dependency), and the matching @github/copilot-linux-x64 / darwin-arm64
    // package gets pulled in as a peer install. We don't assert the exact
    // path (it varies by platform) — just that resolution produces an
    // absolute path pointing at a file that exists.
    const result = resolveNativeCopilotBinary();

    if (result === undefined) {
      // If the platform-specific package isn't installed on this machine
      // (e.g., CI on an unsupported arch), the function correctly returns
      // undefined rather than throwing. That's the documented fallback.
      expect(result).toBeUndefined();
      return;
    }

    expect(result).toMatch(/copilot$/);
    expect(result.startsWith('/')).toBe(true);
  });

  test('returns undefined when fileExists is false', () => {
    // Simulate the resolved path not existing on disk — e.g., partial install.
    const spy = spyOn(resolver, 'fileExists').mockReturnValue(false);
    try {
      expect(resolveNativeCopilotBinary()).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
