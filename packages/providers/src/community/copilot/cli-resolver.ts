/**
 * Copilot CLI path resolver.
 *
 * `@github/copilot-sdk` spawns the Copilot CLI as a subprocess. Its default
 * resolution (`getBundledCliPath()`) points at the JS loader in
 * `@github/copilot/npm-loader.js`, which is spawned with Node. In the stock
 * archon Docker image the runtime is Bun, and `node` on PATH is Bun's
 * node-compat shim — which doesn't implement `node:sea` (the Node 20+ Single
 * Executable API used by the CLI's bundled JS entry). So the loader crashes
 * on startup with a JSON parse error.
 *
 * The native platform-specific binary (`@github/copilot-{platform}-{arch}/copilot`)
 * ships as a peer install and runs fine without any Node runtime. This module
 * locates that binary so the provider can hand it to the SDK directly —
 * avoiding the Bun ↔ Node runtime-compat cliff without requiring the user to
 * hard-code a `/app/node_modules/...` path that churns on dependency
 * upgrades and breaks on other arches.
 *
 * Resolution order (in `resolveCopilotCliPath`):
 *   1. Explicit `cliPath` passed in (from YAML/config).
 *   2. `COPILOT_CLI_PATH` env var.
 *   3. `@github/copilot-{platform}-{arch}/copilot` native binary via
 *      `createRequire`. Silently falls through when the package isn't
 *      installed (e.g., stripped deployments) — the SDK's own resolution
 *      runs next and produces its existing error if it can't proceed.
 */
import { existsSync as _existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests. */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot.cli-resolver');
  return cachedLog;
}

/**
 * Best-effort lookup of the platform-specific native `copilot` binary bundled
 * alongside `@github/copilot`. Returns the absolute path when found, or
 * `undefined` when the package isn't installed for the current platform/arch.
 *
 * Isolated behind an exported helper (rather than inlined in `sendQuery`) so
 * unit tests can spy on it without juggling `createRequire` and real FS state.
 */
export function resolveNativeCopilotBinary(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkgName = `@github/copilot-${process.platform}-${process.arch}`;
    // Resolving the package.json is portable; the platform packages don't
    // declare `copilot` as an entry point (it's shipped as a raw binary).
    const pkgJsonPath = req.resolve(`${pkgName}/package.json`);
    const binaryPath = join(dirname(pkgJsonPath), 'copilot');
    if (!fileExists(binaryPath)) {
      getLog().debug({ pkgName, binaryPath }, 'copilot.native_binary_not_at_expected_path');
      return undefined;
    }
    return binaryPath;
  } catch (err) {
    // Package not installed for this platform/arch, or running in a context
    // without Node's require resolver (e.g., a stripped bundle). Fall through
    // so the SDK's own resolution runs next.
    getLog().debug(
      { err, platform: process.platform, arch: process.arch },
      'copilot.native_binary_lookup_failed'
    );
    return undefined;
  }
}

/**
 * Resolve the Copilot CLI path the SDK should spawn.
 *
 * @param configCliPath - value from `assistants.copilot.cliPath` in YAML
 * @returns absolute path to the CLI, or `undefined` to let the SDK's default
 *          resolution run (which may then error if the JS loader can't start).
 */
export function resolveCopilotCliPath(configCliPath?: string): string | undefined {
  if (configCliPath) return configCliPath;
  if (process.env.COPILOT_CLI_PATH) return process.env.COPILOT_CLI_PATH;
  return resolveNativeCopilotBinary();
}
