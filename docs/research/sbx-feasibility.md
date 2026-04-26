# `sbx` Feasibility Spike — Command Sheet

> **Status:** awaiting host runner. This dev box (Hetzner KVM vServer, no nested
> virtualization, `/dev/kvm` absent) cannot run `sbx`. Run the script on a
> machine that meets one of:
> - macOS Tahoe 26+ on Apple silicon
> - Windows 11 with Hypervisor Platform enabled
> - Ubuntu 22.04+ x86_64 with `/dev/kvm` exposed (bare metal or nested-virt VM)
>
> Paste each command's output verbatim into the matching answer block. Sections
> tagged **CRITICAL** must yield a clear yes/no — they gate the implementation
> plan in `/home/archon/.claude/plans/plan-make-workflows-run-piped-karp.md`.

---

## 0. Install & login

```bash
# macOS
brew install docker/tap/sbx && sbx login

# Windows
winget install -h Docker.sbx && sbx login

# Linux (Ubuntu 22.04+)
curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh
sudo apt-get install docker-sbx
sbx login

# Verify
sbx --version
sbx --help 2>&1 | head -50
```

**Capture:** version, full top-level command list. Identify which subcommands
exist beyond `run / ls / stop / rm / login / secret / policy`.

---

## 1. CRITICAL — Non-interactive command execution

The plan assumes `sbx exec <id> -- <cmd>` (or equivalent) lets the host stream
stdout/stderr from a command run inside the sandbox. Confirm one of these
paths works:

```bash
# Start a sandbox in the background
sbx run claude --branch feasibility-test &
SBX_PID=$!
sbx ls

# Try each of the following — record which (if any) succeed:
sbx exec <sandbox-id> -- bash -c "uname -a; pwd; whoami"
sbx run claude --exec "uname -a"
sbx <sandbox-id> exec uname -a
sbx shell <sandbox-id> -c "uname -a"
docker exec <underlying-container> uname -a   # discover via `sbx ls --json` or `docker ps`
```

**Answer:**
- Does a non-interactive exec exist? `[yes / no / partial]`
- Exact invocation that worked: `____`
- Exit code propagation? Run `sbx exec … -- bash -c 'exit 7'; echo $?` → expect `7`.
- Stream behavior: line-buffered? Block-buffered? Test with
  `sbx exec … -- bash -c 'for i in 1 2 3; do echo $i; sleep 1; done'`.

---

## 2. CRITICAL — Repo mount semantics

```bash
mkdir -p /tmp/sbx-mount-test && cd /tmp/sbx-mount-test
git init && echo "host" > host-side.txt && git add . && git commit -m init

sbx run generic --branch mount-test &  # or whatever generic agent exists
SBX_ID=$(sbx ls --json | jq -r '.[0].id')   # adapt selector

# Inside sandbox: list, modify, create files
sbx exec $SBX_ID -- ls -la
sbx exec $SBX_ID -- bash -c 'echo "from-sandbox" >> host-side.txt && touch sandbox-only.txt'

# On host: confirm whether sandbox writes are visible
ls -la /tmp/sbx-mount-test
cat /tmp/sbx-mount-test/host-side.txt
```

**Answer:**
- Mount style: `[bind-mount / snapshot / overlay / .sbx worktree]`
- Sandbox writes visible on host immediately? `[yes / no / on-stop]`
- Can we point `sbx run` at an arbitrary directory (e.g.
  `~/.archon/workspaces/owner/repo/worktrees/feature-x`) instead of `cwd`?
  Test:
  ```bash
  cd /tmp && sbx run generic --workspace /tmp/sbx-mount-test
  # or whatever flag exists; record what does
  ```
- Does `--branch` mode (`.sbx/` worktrees) interact with our existing
  `~/.archon/workspaces/.../worktrees/` layout? Conflict or ignore?

---

## 3. CRITICAL — Binaries available inside the sandbox

```bash
# Default image contents
sbx run claude --branch tools-test &
SBX_ID=$(sbx ls --json | jq -r '.[0].id')

sbx exec $SBX_ID -- bash -c 'which bash bun node claude codex copilot gh git curl'
sbx exec $SBX_ID -- bash -c 'cat /etc/os-release; uname -a'
sbx exec $SBX_ID -- bash -c 'apt list --installed 2>/dev/null | head -20'

# Can we install missing tools at runtime?
sbx exec $SBX_ID -- bash -c 'curl -fsSL https://bun.sh/install | bash; bun --version'

# Can we provide a custom image? Check sbx's image flag
sbx run --help | grep -i image
sbx run --image my-custom:latest --branch custom-image-test &
```

**Answer:**
- Pre-installed: `bash[Y/N], bun[Y/N], node[Y/N], claude[Y/N], codex[Y/N], copilot[Y/N], gh[Y/N], git[Y/N], curl[Y/N]`
- Image strategy: `[stock-claude / stock-codex / runtime-install / custom-image-required]`
- Custom image flag: `____`
- If runtime install is required, time-to-ready: `____ seconds`

---

## 4. CRITICAL — Secret + env var injection

Test both the documented `sbx secret` flow and raw env vars (we need both for
the per-codebase env vars feature):

```bash
# Documented secret flow
sbx secret set -g anthropic
# (paste a throwaway test key when prompted)
sbx exec $SBX_ID -- env | grep -i anthropic   # should NOT show the key (proxy injection)
sbx exec $SBX_ID -- bash -c 'curl -s https://api.anthropic.com/v1/messages -H "anthropic-version: 2023-06-01" | head -5'
# Should still authenticate via the host proxy

# Raw env vars
sbx run claude --branch env-test --env FOO=bar --env BAZ=qux &  # or whatever flag exists
sbx exec $SBX_ID -- bash -c 'echo "$FOO $BAZ"'

# DATABASE_URL passthrough (for our worker mode)
sbx run claude --branch db-test --env DATABASE_URL=postgresql://… &
sbx exec $SBX_ID -- bash -c 'echo $DATABASE_URL'
```

**Answer:**
- `sbx secret`-injected keys reachable from inside? `[yes via proxy / no / direct env]`
- Raw `--env KEY=VAL` flag exists and works? `[yes / no]`
- Bind-mount `~/.archon/archon.db` (SQLite path) — does sbx have a flag like
  `--mount /host/path:/sandbox/path`? Test:
  ```bash
  sbx run --mount ~/.archon:/host-archon ...
  ```

---

## 5. Lifecycle & idempotency

```bash
# Stop preserves state
sbx stop $SBX_ID
sbx ls   # status field?
sbx exec $SBX_ID -- ls -la   # works while stopped?
sbx start $SBX_ID 2>&1 || sbx run --resume $SBX_ID 2>&1   # how do we resume?

# Removal
sbx rm $SBX_ID
sbx ls

# JSON output for our list/health-check parsing
sbx ls --json
sbx inspect $SBX_ID --json 2>&1 || sbx show $SBX_ID 2>&1
```

**Answer:**
- Stop/start cycle works? `____`
- `sbx ls --json` shape: paste actual output.
- Per-sandbox inspection command exists: `____`
- Stale sandboxes (sbx host crash / kill -9): how does `sbx ls` represent them?

---

## 6. Networking policy (informational)

```bash
sbx policy ls
sbx policy --help
```

Capture the full set of policies and any per-rule customization, so we can
expose them through `.archon/config.yaml`'s `isolation.sbx.networkPolicy` field.

---

## 7. Agent presets (informational)

The doc shows `sbx run claude` and `sbx run codex`. List every agent preset:

```bash
sbx run --help | grep -A 30 -i "agents\|presets"
sbx agents 2>&1 || sbx list-agents 2>&1
```

For each preset, capture: image used, default `cwd` inside sandbox, default
env vars set, what the "interactive UI" actually does (in case we need to
bypass it).

---

## 8. CRITICAL — Programmatic event stream

For the worker-mode design, we need to spawn `sbx exec … -- bun
some-script.ts` and parse JSONL from stdout. Confirm there is no PTY
requirement that breaks pipe redirection:

```bash
sbx exec $SBX_ID -- bash -c 'for i in 1 2 3 4 5; do echo "{\"event\":$i}"; sleep 0.5; done' | tee /tmp/sbx-stream.jsonl
# Verify lines arrive incrementally (not all at end)
```

**Answer:** `[streams correctly / buffers / requires PTY (use script(1) wrapper) / fails]`

---

## Summary template (fill in after running)

```
Verdict: [GREEN — proceed with plan as written]
       | [YELLOW — proceed with adjustments: ____]
       | [RED — re-plan; option (2) generic-Docker provider is the fallback]

sbx version tested: ____
Host OS: ____
Notes: ____
```

---

## What to send back

Paste this whole file with the **Answer** blocks filled in, plus:
1. Output of `sbx --version` and `sbx --help`.
2. A `sbx ls --json` sample (one running sandbox).
3. The exact non-interactive command that worked from §1, §4, §8.

I'll fold the results into the implementation plan and start Phase 1.
