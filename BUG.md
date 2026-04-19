# Bugs surfaced by the Copilot E2E test

Two issues found while wiring `feat/copilot-sdk-provider` into a real end-to-end
run (Linear → archon → `hmq-backend-pipeline-copilot.yaml` → Copilot CLI).

1. [Per-node `provider` / `model` / `effort` overrides silently dropped on loop nodes](#1-per-node-provider--model--effort-overrides-silently-dropped-on-loop-nodes)
2. [Copilot provider can't locate its own bundled CLI when the runtime is Bun](#2-copilot-provider-cant-locate-its-own-bundled-cli-when-the-runtime-is-bun)

---

## 1. Per-node `provider` / `model` / `effort` overrides silently dropped on loop nodes

### Severity

Medium. Not a crash — workflows continue to run — but the per-node AI override the user wrote in YAML is **silently ignored**, with no warning at load time or execution time. The loop node falls back to the workflow-level provider, making the configured behavior invisible from logs alone.

### Summary

The DAG node schema parser strips all `aiOnly` fields (`provider`, `model`, `effort`, `thinking`, `mcp`, `hooks`, `skills`, `allowed_tools`, `denied_tools`, `output_format`, `maxBudgetUsd`, `systemPrompt`, `fallbackModel`, `betas`, `sandbox`, `context`) when constructing a `LoopNode`. The DAG executor, however, _does_ try to read `node.provider` and `node.model` for loop nodes — so schema and dispatcher are inconsistent: dispatcher expects the fields, schema doesn't preserve them.

Net effect: setting `provider: copilot` (or any per-node AI override) on a `loop:` node has no effect. The workflow-level provider is used instead.

### Reproduction

Minimal workflow YAML:

```yaml
name: repro-loop-provider-override
provider: claude # workflow-level default

nodes:
  - id: my-loop
    provider: copilot # <-- silently stripped by schema
    loop:
      prompt: 'Reply with DONE.'
      until: DONE
      max_iterations: 1
```

Run the workflow. Observation:

- App logs show `provider.claude using_explicit_tokens` → Claude is the one called.
- No `provider.copilot.session_starting` / `copilot.*` logs ever fire.
- No warning emitted that the override was dropped.
- DB `workflow_events.tool_called` for the loop node shows Claude-style tool names (`Bash`, `Edit`, `Write`, `Read`), not the Copilot SDK's event shape.

Expected: the loop iterations run on Copilot (honoring `node.provider`), or the YAML load fails with a clear message if loop nodes are intentionally not allowed per-node provider overrides.

### Root cause

**File:** `packages/workflows/src/schemas/dag-node.ts`

The `superRefine → transform` branch that builds DAG node records spreads an `aiOnly` record into **every branch except loop**:

```ts
// lines 555-588 (condensed)
if (data.command !== undefined && ...) {
  return { ...base, ...shared, ...aiOnly, command: ... } as CommandNode;
}
if (data.prompt !== undefined && ...) {
  return { ...base, ...shared, ...aiOnly, prompt: ... } as PromptNode;
}
if (data.bash !== undefined && ...) {
  return { ...base, ...shared, bash: ..., ... } as BashNode;
}
if (data.script !== undefined && ...) {
  return { ...base, ...shared, script: ..., runtime: ..., ... } as ScriptNode;
}
if (data.approval !== undefined) {
  return { ...base, ...shared, approval: data.approval } as ApprovalNode;
}
if (data.cancel !== undefined && ...) {
  return { ...base, ...shared, cancel: ... } as CancelNode;
}
// loop branch — line 589
return { ...base, loop: data.loop } as LoopNode;   // ← NO ...aiOnly, NO ...shared
```

The inline comment at line 535 reads `// AI-only fields (not applicable to bash/loop nodes)`, which is the documented intent. However, the DAG executor contradicts that intent:

**File:** `packages/workflows/src/dag-executor.ts`, lines 2351-2391:

```ts
// 3b. Loop node dispatch
if (isLoopNode(node)) {
  const loopProvider: string =
    node.provider ?? inferProviderFromModel(node.model, workflowProvider);   // reads node.provider/node.model
  const loopAssistantConfig = config.assistants[loopProvider];
  const loopModel: string | undefined =
    node.model ??
    (loopProvider === workflowProvider
      ? workflowModel
      : (loopAssistantConfig?.model as string | undefined));
  // ...
  const output = await executeLoopNode(
    deps, platform, conversationId, cwd, workflowRun, node,
    loopProvider, loopModel,   // passes resolved per-node values
    ...
  );
}
```

Because the schema has already stripped `node.provider` / `node.model`, the `??` fallbacks always take the workflow-level path. The same applies to `effort`, `thinking`, `mcp`, `hooks`, `skills`, tool restrictions, etc. — the YAML is accepted, persisted, and executed, but the fields never reach the executor.

### Suggested fix

Either:

#### Option 1 — support per-node overrides on loop nodes (preferred)

Spread `aiOnly` into the loop return so the schema matches what the executor already reads:

```ts
// dag-node.ts line 589
return { ...base, ...shared, ...aiOnly, loop: data.loop } as LoopNode;
```

This is the smallest change and makes schema + executor consistent. It requires updating `LoopNode`'s TypeScript shape (line 226) to permit the fields, and ideally a small test that parses a loop node with `provider`/`model`/`effort` set and asserts they round-trip through the schema.

#### Option 2 — reject the fields at load time

If per-node AI overrides on loop nodes are genuinely unsupported, add a `superRefine` check that errors when `data.loop` is present alongside any `aiOnly` field — so broken user config fails loudly at `parseWorkflow` rather than running on the wrong provider silently.

Option 1 is preferred because (a) the executor already implements the resolution logic, and (b) mixing providers across a workflow (Claude for setup/plan/synthesize, Copilot for the implement loop) is a concretely useful pattern — the original reason this bug surfaced.

### Affected code

- `packages/workflows/src/schemas/dag-node.ts` (schema transformer, lines 530-590)
- `packages/workflows/src/schemas/dag-node.ts` (LoopNode type, lines 221-233)
- `packages/workflows/src/dag-executor.ts` (dispatcher expecting the fields, lines 2351-2391)
- `packages/workflows/src/dag-executor.ts` (`executeLoopNode` parameter naming is misleading — `workflowProvider` actually receives the per-node `loopProvider`; worth renaming for clarity)

### Discovery

Surfaced while wiring `hmq-backend-pipeline-copilot.yaml` for an E2E Copilot integration test: the `implement-review-cycle` loop node had `provider: copilot` set, but every iteration ran on Claude. Confirmed by:

1. Zero `provider.copilot.*` log events during the run.
2. Three `provider.claude using_explicit_tokens` events aligned with each of the node boundaries.
3. DB `workflow_events.tool_called` entries with Claude-native tool names (`Bash`, `Edit`, `Write`, `Read`) instead of Copilot SDK events.
4. Re-run after fixing Copilot auth produced identical behavior — Claude dispatched again, zero Copilot activity. The bug is deterministic, not environmental.

---

## 2. Copilot provider can't locate its own bundled CLI when the runtime is Bun

### Severity

Medium-High. The Copilot provider is **unusable out of the box** in any archon deployment running on Bun (including the default Docker image) — the CLI crashes on startup with a cryptic JS parse error, and the user has to know enough about Bun vs Node internals to hand-configure `assistants.copilot.cliPath` with the full path inside `node_modules`. That path is fragile (breaks on upgrades, wrong on other arches, wrong in bundled binaries) and shouldn't be something the user has to set at all.

### Summary

`@github/copilot-sdk` resolves the CLI via a three-step fallback (`options.cliPath` → `COPILOT_CLI_PATH` → `getBundledCliPath()`). The bundled path points at `@github/copilot/npm-loader.js`, which the SDK spawns with `getNodeExecPath()` — effectively "whatever `node` is on PATH."

In the archon Docker image, `node` is `/usr/local/bun-node-fallback-bin/node` — Bun's `node`-compat shim. The bundled `@github/copilot` entry point imports `node:sea` (Node Single Executable API, Node 20+) and uses other APIs that Bun's shim does not implement, so the CLI subprocess dies at parse time with:

```
error: Could not resolve: "node:sea". Maybe you need to "bun install"?
    at /app/node_modules/@github/copilot/index.js:7:390
Bun v1.3.11 (Linux x64 baseline)
```

The native platform-specific binary (`@github/copilot-linux-x64/copilot`) **is already installed** as a transitive dependency and works perfectly when invoked directly. Archon just never tries it.

### Reproduction

Bring up a stock archon docker-compose deployment, install the Copilot provider, configure minimum `assistants.copilot.model`, leave `cliPath` unset. Trigger any workflow that routes to Copilot. Expected: workflow runs. Actual: every `sendQuery` fails with `copilot.client_start_failed` → `Failed to start Copilot client: CLI server exited with code 1`. The only workaround currently documented anywhere is to inspect `/app/node_modules/@github/copilot-linux-x64/` manually and hand-set:

```yaml
assistants:
  copilot:
    cliPath: /app/node_modules/@github/copilot-linux-x64/copilot
```

…which is fragile: the file is inside `node_modules` (churns on `bun install`), is platform-specific (wrong for darwin-arm64, win32-x64, etc.), and doesn't survive in compiled-binary archon builds where `node_modules` isn't present.

### Root cause

**File:** `packages/providers/src/community/copilot/provider.ts` (lines 78-86):

```ts
const cliPath = copilotConfig.cliPath ?? process.env.COPILOT_CLI_PATH;
// (no third-tier fallback — we rely on the SDK's getBundledCliPath())

const clientOptions: CopilotClientOptions = {
  cwd,
  ...(cliPath ? { cliPath } : {}), // if unset, SDK's default kicks in
  ...(githubToken ? { githubToken } : {}),
  ...(childEnv ? { env: childEnv } : {}),
};
```

Archon defers to `@github/copilot-sdk`'s default, which resolves to `@github/copilot/npm-loader.js`. That loader only boots under a real Node 24+ runtime.

The SDK itself has the right behavior for a Node-first world — it spawns `node <loader.js>` — but makes no attempt to prefer the platform-specific native binary that ships in the same install, even when that binary would side-step the runtime-compat problem entirely.

### Suggested fix

Resolve the native binary in the Copilot provider and pass it through as `cliPath` when the user hasn't set one explicitly. The platform binaries follow the `@github/copilot-${platform}-${arch}/copilot` naming convention; resolution can use the same `require.resolve` strategy the SDK uses for the loader.

Sketch (in `packages/providers/src/community/copilot/provider.ts`):

```ts
import { createRequire } from 'node:module';

/**
 * Best-effort lookup of the native `@github/copilot-{platform}-{arch}/copilot`
 * binary shipped alongside `@github/copilot`. Returns `undefined` when the
 * platform-specific package isn't installed (caller then falls back to the
 * SDK's JS-loader resolution).
 */
function resolveNativeCopilotBinary(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkg = `@github/copilot-${process.platform}-${process.arch}`;
    const pkgJson = req.resolve(`${pkg}/package.json`);
    return path.join(path.dirname(pkgJson), 'copilot');
  } catch {
    return undefined;
  }
}
```

Then in `sendQuery`:

```ts
const cliPath =
  copilotConfig.cliPath ?? process.env.COPILOT_CLI_PATH ?? resolveNativeCopilotBinary(); // NEW: prefer native binary over JS loader
```

With the native binary resolved to something like `/app/node_modules/@github/copilot-linux-x64/copilot`, the SDK's spawn path will detect `.endsWith('.js')` is false and execute the binary directly — no Node runtime, no Bun shim, no `node:sea` issue.

Behavior notes:

- When the platform-specific package isn't installed (e.g., a stripped deployment), fall back to the current behavior — the SDK's JS-loader resolution — and let that emit its existing, actionable error.
- The lookup is synchronous + cheap; no need to cache.
- This is transparent to users who already set `cliPath` or `COPILOT_CLI_PATH`; the explicit path still wins.

### Affected code

- `packages/providers/src/community/copilot/provider.ts` (`sendQuery`, lines 78-99)
- `packages/providers/src/community/copilot/config.ts` (docs for `cliPath` — note that default now picks the native binary automatically)
- Tests: add a unit test that stubs `createRequire` to return a fake binary path and asserts the provider picks it up.

### Discovery

Surfaced during the first Copilot E2E trigger after wiring `awf-copilot-smoke.yaml` in the agentic-worflow repo. Symptom chain:

1. `copilot.session_starting` logged with `hasCliPath: false` (because user hadn't configured one).
2. Immediately followed by `copilot.client_start_failed` with the `node:sea` parse error quoted above.
3. Manually running `/app/node_modules/@github/copilot-linux-x64/copilot --version` inside the container succeeded — confirming the native binary works, just wasn't being used.
4. Setting `assistants.copilot.cliPath: /app/node_modules/@github/copilot-linux-x64/copilot` resolved the issue.

The required path is deployment-specific (`/app/...` here) and fragile, so baking it into user-facing configuration is a poor UX. The provider should do this resolution automatically.
