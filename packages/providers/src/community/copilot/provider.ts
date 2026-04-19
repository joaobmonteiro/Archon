import { createLogger } from '@archon/paths';
import { CopilotClient, approveAll } from '@github/copilot-sdk';
import type { CopilotClientOptions, SessionConfig } from '@github/copilot-sdk';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';

import { COPILOT_CAPABILITIES } from './capabilities';
import { resolveCopilotCliPath } from './cli-resolver';
import { parseCopilotConfig } from './config';
import { bridgeCopilotSession } from './event-bridge';
import { resolveCopilotEffort, resolveCopilotEnv } from './options-translator';
import { resolveCopilotSession } from './session-resolver';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.copilot');
  return cachedLog;
}

/**
 * GitHub Copilot community provider — wraps `@github/copilot-sdk`.
 *
 * The SDK spawns the `copilot` CLI binary over JSON-RPC, so each `sendQuery()`
 * starts a fresh `CopilotClient` (binds `cwd` at construction time, so per-call
 * lifecycle is required to support different worktrees).
 *
 * v1 capabilities (see capabilities.ts): `sessionResume`, `effortControl`,
 * `envInjection`. Everything else is `false` — flip per follow-up PR as the
 * corresponding plumbing lands. Under-declaring is honest; the dag-executor
 * surfaces a warning for any nodeConfig field not supported.
 *
 * Auth: delegates to the Copilot CLI's credential resolution. Either:
 *   1. `gh auth login` populates `~/.config/gh/hosts.yml` (or equivalent), OR
 *   2. `assistants.copilot.githubToken` in `.archon/config.yaml`, OR
 *   3. `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` env var.
 */
export class CopilotProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const copilotConfig = parseCopilotConfig(assistantConfig);

    // 1. Resolve model: request → config default. Copilot rejects unknown
    //    models with a clear runtime error, so we don't gate here.
    const model = requestOptions?.model ?? copilotConfig.model;
    if (!model) {
      throw new Error(
        'Copilot provider requires a model. Set `model` on the workflow node or `assistants.copilot.model` in .archon/config.yaml. ' +
          "Examples: 'claude-sonnet-4.5', 'gpt-5', 'gpt-4.1'."
      );
    }

    // 2. Resolve effort + env per node config.
    const nodeConfig = requestOptions?.nodeConfig;
    const { effort, warning: effortWarning } = resolveCopilotEffort(
      nodeConfig,
      copilotConfig.reasoningEffort
    );
    if (effortWarning) {
      yield { type: 'system', content: `⚠️ ${effortWarning}` };
    }
    const childEnv = resolveCopilotEnv(requestOptions?.env);

    // 3. Construct the Copilot client. `cwd` is pinned at construction time
    //    by the SDK, so a per-call client lifecycle is required to support
    //    different worktrees. `cliPath` resolution (see ./cli-resolver.ts):
    //      1. assistantConfig.cliPath (YAML-configured)
    //      2. COPILOT_CLI_PATH env var
    //      3. platform-specific native binary bundled in node_modules
    //         (avoids the Bun-vs-Node:sea incompat for the default JS loader)
    //      4. undefined → SDK's own fallback to the JS loader runs next
    const cliPath = resolveCopilotCliPath(copilotConfig.cliPath);
    const githubToken = copilotConfig.githubToken ?? process.env.COPILOT_GITHUB_TOKEN;

    const clientOptions: CopilotClientOptions = {
      cwd,
      ...(cliPath ? { cliPath } : {}),
      ...(githubToken ? { githubToken } : {}),
      ...(childEnv ? { env: childEnv } : {}),
    };

    getLog().info(
      {
        cwd,
        model,
        effort,
        hasCliPath: cliPath !== undefined,
        hasGithubToken: githubToken !== undefined,
        envKeyCount: childEnv ? Object.keys(childEnv).length : 0,
        resumed: resumeSessionId !== undefined,
      },
      'copilot.session_starting'
    );

    let client: CopilotClient;
    try {
      client = new CopilotClient(clientOptions);
      await client.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      getLog().error({ err, cwd }, 'copilot.client_start_failed');
      // Most common failure: copilot binary not on PATH and no cliPath set.
      // Surface an actionable message that names the install command.
      throw new Error(
        `Failed to start Copilot client: ${message}. ` +
          'Install: `gh extension install github/gh-copilot && gh auth login`. ' +
          'Or set `assistants.copilot.cliPath` in .archon/config.yaml or COPILOT_CLI_PATH env var.'
      );
    }

    try {
      // 4. Resolve / create session. `approveAll` matches the existing trust
      //    model — workflows are already gated by isolation worktrees and
      //    explicit user/trigger intent. Configurable later if a node wants
      //    a stricter mode.
      const sessionConfig: SessionConfig = {
        model,
        onPermissionRequest: approveAll,
        streaming: true,
        ...(effort ? { reasoningEffort: effort } : {}),
      };

      const { session, resumeFailed } = await resolveCopilotSession(
        client,
        resumeSessionId,
        sessionConfig
      );
      if (resumeFailed) {
        yield {
          type: 'system',
          content: '⚠️ Could not resume Copilot session. Starting fresh conversation.',
        };
      }

      // 5. Bridge the session's event emitter into the async-generator contract.
      try {
        yield* bridgeCopilotSession(session, prompt, requestOptions?.abortSignal);
        getLog().info({ model }, 'copilot.prompt_completed');
      } catch (err) {
        getLog().error({ err, model }, 'copilot.prompt_failed');
        throw err;
      } finally {
        // Disconnect the session before stopping the client — the SDK can
        // hang if you stop while a session is still active.
        try {
          await (session as unknown as { disconnect: () => Promise<void> }).disconnect();
        } catch (err) {
          getLog().debug({ err }, 'copilot.session_disconnect_failed');
        }
      }
    } finally {
      try {
        await client.stop();
      } catch (err) {
        getLog().debug({ err }, 'copilot.client_stop_failed');
      }
    }
  }

  getType(): string {
    return 'copilot';
  }

  getCapabilities(): ProviderCapabilities {
    return COPILOT_CAPABILITIES;
  }
}
