# Runtime Abstraction: Multi-Provider Agent Support

> Design document for decoupling Overstory from Claude Code and enabling
> alternative coding agent runtimes (Codex, Pi, OpenCode, Cline, others).

## Problem

Overstory is tightly coupled to Claude Code. The `claude` binary name, its CLI
flags, TUI readiness strings, hook system, `.claude/` directory conventions, and
transcript format are hardcoded across 35 coupling points in 15+ source files.
This locks every agent in the swarm to a single runtime.

The goal is a thin abstraction layer that lets Overstory spawn agents using
**any** compatible coding agent runtime — without requiring a massive per-provider
build-out. Each new runtime should be a ~200–400 line adapter file, not a fork of
the orchestration engine.

## Design Principles

1. **Extract, don't rewrite.** Phase 0 moves current Claude Code behavior behind
   an interface with zero behavior change. New runtimes come after.
2. **Config-driven adapters.** Most per-runtime differences are flag names and
   file paths, not logic. Adapters are mostly declarative.
3. **Incremental adoption.** A project can run Claude agents alongside Codex
   agents in the same swarm. The runtime is per-agent, not per-project.
4. **Headless-first.** Runtimes that support headless/JSON output modes get
   first-class support. Interactive-only runtimes are lower priority.

## Coupling Audit Summary

The 35 identified coupling points collapse into 4 abstraction surfaces:

| Surface | What it covers | Files affected |
|---------|---------------|----------------|
| **Spawn** | Binary name, CLI flags, env vars, permission mode | sling.ts, coordinator.ts, supervisor.ts (deprecated), monitor.ts, manifest.ts |
| **Readiness** | TUI detection strings, trust dialog handling | worktree/tmux.ts, sling.ts |
| **Hooks** | Event names, config file path, stdin payload schema, block protocol, tool blocklists | hooks-deployer.ts, hooks.ts, hooks.json.tmpl, log.ts |
| **Overlay + Transcripts** | Instruction file path (`.claude/CLAUDE.md`), transcript JSONL format, pricing tables | agents/overlay.ts, metrics/transcript.ts, costs.ts, log.ts |

Full coupling inventory with exact line numbers is in the appendix.

## The Interface

```typescript
// src/runtimes/types.ts

interface AgentRuntime {
  /** Unique runtime identifier */
  id: string;

  /** Build the shell command to spawn an interactive agent in tmux */
  buildSpawnCommand(opts: SpawnOpts): string;

  /** Build the argv array for a headless one-shot AI call */
  buildPrintCommand(prompt: string, model?: string): string[];

  /** Deploy per-agent instructions + guards to a worktree */
  deployConfig(
    worktreePath: string,
    overlay: OverlayContent,
    hooks: HooksDef
  ): Promise<void>;

  /** Detect agent readiness from tmux pane content */
  detectReady(paneContent: string): ReadyState;

  /** Parse a session transcript into normalized token usage */
  parseTranscript(path: string): Promise<TranscriptSummary | null>;

  /** Runtime-specific env vars for model/provider routing */
  buildEnv(model: ResolvedModel): Record<string, string>;
}

type ReadyState =
  | { phase: "loading" }
  | { phase: "dialog"; action: string }
  | { phase: "ready" };

interface SpawnOpts {
  model: string;
  permissionMode: "bypass" | "ask";
  systemPrompt?: string;
  appendSystemPrompt?: string;
  cwd: string;
  env: Record<string, string>;
}
```

### Config Surface

```yaml
# .overstory/config.yaml
runtime:
  default: claude
  printCommand: claude        # runtime for headless AI calls (merge, triage)
  adapters:
    claude:
      binary: claude
    codex:
      binary: codex
      mode: exec
    pi:
      binary: pi
      mode: rpc
    opencode:
      binary: opencode
      mode: run
```

Per-agent runtime override via `ov sling`:

```bash
ov sling TASK-1 --capability builder --name bob --runtime codex
```

Or via dispatch mail payload:

```json
{ "runtime": "codex", "model": "gpt-5-codex" }
```

---

## Codex Integration

OpenAI's Codex CLI is the highest-demand integration target. Its `codex exec`
headless mode is purpose-built for subprocess orchestration.

### How Codex Works

Codex has two primary modes:
- **Interactive:** `codex` launches a full-screen TUI (similar to Claude Code)
- **Headless:** `codex exec "prompt"` processes one task and exits

For Overstory, headless mode is the right fit. The agent runs, completes its
task, and exits — no TUI readiness detection needed.

### Spawning a Codex Agent

```bash
codex exec --full-auto --json "Read your instructions at AGENTS.md and begin."
```

Key flags:

| Flag | Purpose | Overstory equivalent |
|------|---------|---------------------|
| `exec` | Headless mode, exits on completion | Replaces interactive tmux session |
| `--full-auto` | `workspace-write` sandbox + auto-approve | `--permission-mode bypassPermissions` |
| `--json` | NDJSON event stream to stdout | Enables event parsing without tmux capture |
| `--model <name>` | Model selection (e.g. `gpt-5-codex`) | `--model sonnet` |
| `--ephemeral` | No session persistence to disk | Useful for stateless one-shot agents |

### Instruction Delivery

Codex reads **`AGENTS.md`** (not `CLAUDE.md`) from the project root and any
parent directory. Overstory's overlay generator would write to `AGENTS.md`
instead of `.claude/CLAUDE.md` when the runtime is Codex:

```typescript
// In the Codex adapter's deployConfig():
const instructionPath = join(worktreePath, "AGENTS.md");
await Bun.write(instructionPath, overlayContent);
```

Codex also supports `--config key=value` for inline config and
`model_instructions_file` in its `config.toml` for custom system prompts.
`AGENTS.md` is the simplest path — it aligns with Codex's conventions and
requires no special config file generation.

### Event Stream

With `--json`, Codex emits NDJSON to stdout. Key event types:

```jsonl
{"type":"thread.started","thread_id":"...","session_id":"..."}
{"type":"turn.started"}
{"type":"item.created","item":{"type":"message","role":"assistant","content":[{"type":"text","text":"..."}]}}
{"type":"item.created","item":{"type":"command","command":"bash","args":["bun test"]}}
{"type":"item.created","item":{"type":"file_change","path":"src/foo.ts","action":"edit"}}
{"type":"turn.completed","usage":{"input_tokens":1234,"output_tokens":567}}
{"type":"thread.completed"}
```

Overstory would parse this stream to populate `events.db` and `metrics.db`,
replacing the current Claude Code hook-based event logging.

### Sandbox Model

Codex has OS-level sandboxing (Seatbelt on macOS, Landlock on Linux) with three tiers:

| Tier | Writes | Network | Overstory use |
|------|--------|---------|--------------|
| `read-only` | None | No | Scout agents |
| `workspace-write` | Project only | Configurable | Builder agents (default via `--full-auto`) |
| `danger-full-access` | Unrestricted | Yes | Not recommended |

This is stronger than Claude Code's current setup (which relies entirely on
Overstory's PreToolUse hook guards). With Codex, the OS enforces filesystem
boundaries — Overstory's hook-based guards become defense-in-depth rather than
the only line of defense.

Scout agents can use `--sandbox read-only` for zero-write-risk exploration.

### Readiness Detection

Not needed. `codex exec` is headless — it starts processing immediately and
exits on completion. The adapter's `detectReady()` returns `{ phase: "ready" }`
unconditionally.

If the agent is spawned inside a tmux window for visibility (optional), the
NDJSON stream is the source of truth for lifecycle state, not pane content.

### Transcript Parsing

Codex sessions can be persisted to disk (opt-in) or captured via the `--json`
stdout stream. For cost tracking, Overstory captures `turn.completed` events
which include `usage.input_tokens` and `usage.output_tokens`.

```typescript
// Codex transcript parser
function parseCodexEvent(line: string): TokenSnapshot | null {
  const event = JSON.parse(line);
  if (event.type === "turn.completed" && event.usage) {
    return {
      inputTokens: event.usage.input_tokens,
      outputTokens: event.usage.output_tokens,
      model: event.model ?? "unknown",
    };
  }
  return null;
}
```

Pricing would need a separate table for OpenAI model tiers (extending the
current Anthropic-only `MODEL_PRICING` in `transcript.ts`).

### What Overstory's Hook System Becomes

Claude Code hooks serve four purposes. Here's how each maps to Codex:

| Hook purpose | Claude Code mechanism | Codex equivalent |
|-------------|----------------------|-----------------|
| **Agent priming** (SessionStart) | Shell hook runs `ov prime` | Not needed — AGENTS.md is read at startup |
| **Mail injection** (UserPromptSubmit) | Shell hook runs `ov mail check --inject` | Parse NDJSON stream; orchestrator sends follow-up prompts via tmux or new `codex exec` |
| **Tool guards** (PreToolUse) | Shell hook blocks dangerous tools | Codex's sandbox enforces filesystem boundaries; `--sandbox workspace-write` replaces most guards |
| **Event logging** (PostToolUse, Stop) | Shell hook runs `ov log` | Parse NDJSON events directly from stdout |

The key architectural shift: instead of hooks inside the agent pushing events
out, Overstory pulls events from the agent's stdout stream. This is actually
cleaner — no hook deployment, no stdin/stdout protocol differences, no shell
script generation.

### Mail Delivery Challenge

Claude Code agents receive mail via the `UserPromptSubmit` hook that runs
`ov mail check --inject` before each prompt. Codex has no equivalent hook.

Options for delivering messages to a running Codex agent:

1. **tmux send-keys:** If the Codex agent is in a tmux window (interactive mode
   instead of `exec`), inject text via `tmux send-keys`. This requires
   interactive mode, giving up the clean headless exit behavior.

2. **Multi-turn via new exec calls:** For `codex exec` mode, each "turn" is a
   separate `codex exec` invocation with `codex resume` to continue the session.
   The orchestrator checks mail between turns and prepends messages to the next
   prompt.

3. **Fire-and-forget tasks:** For builders doing focused work, mail delivery
   during execution may not be necessary. The agent gets its full assignment
   upfront and reports back when done. Mail is checked by the orchestrator, not
   the agent.

Option 3 is the pragmatic starting point. Most builder tasks are
self-contained — the agent reads its spec, does the work, and signals
completion. The orchestrator handles coordination.

### The Codex Adapter

```typescript
// src/runtimes/codex.ts

export const codexRuntime: AgentRuntime = {
  id: "codex",

  buildSpawnCommand(opts: SpawnOpts): string {
    const parts = ["codex", "exec", "--full-auto", "--json"];

    if (opts.model) parts.push("--model", opts.model);
    if (opts.permissionMode === "bypass") {
      // --full-auto already implies workspace-write + auto-approve
    }

    // The prompt tells the agent to read AGENTS.md for its full instructions
    parts.push(
      JSON.stringify("Read AGENTS.md for your task assignment and begin immediately.")
    );

    return parts.join(" ");
  },

  buildPrintCommand(prompt: string, model?: string): string[] {
    const args = ["codex", "exec", "--full-auto", "--ephemeral"];
    if (model) args.push("--model", model);
    args.push(prompt);
    return args;
  },

  async deployConfig(worktreePath, overlay, _hooks) {
    // Codex reads AGENTS.md, not .claude/CLAUDE.md
    const agentsPath = join(worktreePath, "AGENTS.md");
    await Bun.write(agentsPath, overlay.content);

    // No hooks deployment needed — events come from stdout NDJSON
  },

  detectReady(_paneContent: string): ReadyState {
    // codex exec is headless — always ready
    return { phase: "ready" };
  },

  async parseTranscript(path: string): Promise<TranscriptSummary | null> {
    // Parse captured NDJSON from the agent's stdout
    const file = Bun.file(path);
    if (!(await file.exists())) return null;

    const text = await file.text();
    let totalInput = 0;
    let totalOutput = 0;
    let model = "unknown";

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "turn.completed" && event.usage) {
        totalInput += event.usage.input_tokens ?? 0;
        totalOutput += event.usage.output_tokens ?? 0;
      }
      if (event.model) model = event.model;
    }

    return { inputTokens: totalInput, outputTokens: totalOutput, model };
  },

  buildEnv(model: ResolvedModel): Record<string, string> {
    const env: Record<string, string> = {};
    if (model.provider?.baseUrl) {
      env.OPENAI_BASE_URL = model.provider.baseUrl;
    }
    if (model.provider?.authTokenEnv) {
      env.OPENAI_API_KEY = process.env[model.provider.authTokenEnv] ?? "";
    }
    return env;
  },
};
```

### Codex Integration Summary

| Dimension | Assessment |
|-----------|-----------|
| **Adapter complexity** | Low (~200 lines). Headless mode eliminates TUI detection and hook deployment. |
| **Instruction delivery** | Clean. AGENTS.md is Codex's native convention. |
| **Event capture** | Clean. NDJSON stdout replaces hook-based logging. |
| **Sandbox** | Stronger than current. OS-level Seatbelt/Landlock vs. hook-based guards. |
| **Mail delivery** | Trade-off. Fire-and-forget is simplest; multi-turn via resume is possible. |
| **Model routing** | Straightforward. `--model` flag, OpenAI env vars. |
| **Transcript/costs** | `turn.completed` events provide token usage. Pricing table needs OpenAI tiers. |

---

## Pi Integration

[Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
(`@mariozechner/pi-coding-agent`) is an MIT-licensed coding agent with the
cleanest integration surface of any runtime surveyed. Its RPC mode and extension
system make it a natural fit for Overstory's orchestration model.

### Why Pi Stands Out

Pi was designed for extensibility. Where other runtimes bolt on headless modes as
an afterthought, Pi has three first-class programmatic interfaces:

| Mode | Interface | Use case |
|------|-----------|----------|
| `--mode rpc` | Bidirectional JSON-RPC over stdin/stdout | Full agent lifecycle control |
| `--mode json` | NDJSON event stream to stdout | Fire-and-forget with event capture |
| SDK (`createAgentSession`) | In-process TypeScript API | Embedded agents (no subprocess) |

The RPC mode is the standout. It provides commands that map directly to
Overstory's orchestration needs:

| RPC command | What it does | Overstory use |
|-------------|-------------|---------------|
| `prompt` | Send a message to the agent | Deliver mail, follow-up instructions |
| `steer` | Interrupt current work, redirect | Urgent orchestrator overrides |
| `followUp` | Queue message for after current turn | Non-urgent mail delivery |
| `abort` | Cancel current operation | `ov stop` implementation |
| `get_state` | Query agent state | `ov status`, `ov inspect` |
| `waitForIdle` | Block until agent finishes current turn | Completion detection |

### Native Compatibility

Pi already reads the same instruction files as Claude Code:

| Convention | Pi support |
|-----------|-----------|
| `CLAUDE.md` | Read as context file at startup |
| `AGENTS.md` | Read as context file at startup |
| `.claude/CLAUDE.md` | Read (traverses `.claude/` directory) |

This means Overstory's existing overlay system works with Pi out of the box.
The overlay generator writes `.claude/CLAUDE.md` in the worktree, and Pi reads
it automatically. No adapter-level file path translation needed.

### Model Support

Pi supports 18+ providers natively:

- Anthropic, OpenAI, Google Gemini, Azure OpenAI, Amazon Bedrock, Google
  Vertex AI, Mistral, Groq, Cerebras, xAI, OpenRouter, and more
- Subscription OAuth for Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, Gemini
- Local models via Ollama, LM Studio, vLLM (configured in `~/.pi/agent/models.json`)

Model selection: `pi --model claude-sonnet-4-20250514` or
`pi --provider anthropic --model claude-opus-4-6`.

### Extension System as Hook Replacement

Pi's extension system is more powerful than Claude Code's hooks. Extensions
subscribe to typed events and can block tool calls, modify results, inject
context, and transform messages.

| Claude Code hook | Pi extension event | Capability |
|-----------------|-------------------|------------|
| `SessionStart` | `session_start` | Read saved state, initialize |
| `UserPromptSubmit` | `input` | Transform or intercept user prompts |
| `PreToolUse` | `tool_call` | **Can return `{type:"block", reason:"..."}`** |
| `PostToolUse` | `tool_result` | Can modify the result |
| `PreCompact` | `session_compact` | Save checkpoint before compression |
| `Stop` | `session_shutdown` | Cleanup, record metrics |
| *(none)* | `before_agent_start` | Inject messages into LLM context |
| *(none)* | `message_update` | Stream deltas in real-time |

Overstory would deploy a guard extension to each worktree:

```typescript
// .pi/extensions/overstory-guard.ts
import type { Extension } from "@mariozechner/pi-coding-agent";

export default (): Extension => ({
  tool_call: async (event) => {
    // Block dangerous operations (equivalent to PreToolUse guards)
    if (event.name === "bash") {
      const cmd = event.input?.command ?? "";
      if (cmd.includes("git push") && cmd.includes("main")) {
        return { type: "block", reason: "Cannot push to main from agent worktree" };
      }
      if (cmd.includes("git reset --hard")) {
        return { type: "block", reason: "Destructive git operations are blocked" };
      }
    }
    return { type: "allow" };
  },
});
```

### Mail Delivery via RPC

This is where Pi has a clear advantage over every other runtime. Instead of
relying on hooks or tmux send-keys to deliver messages, the orchestrator sends
mail directly via the RPC `prompt` or `followUp` command:

```typescript
// Orchestrator delivers mail to a Pi agent
const message = await mailClient.check(agentName);
if (message) {
  await rpcClient.followUp(formatMailAsPrompt(message));
}
```

`followUp` queues the message for after the current turn completes, so it
doesn't interrupt mid-tool-execution. For urgent messages, `steer` interrupts
immediately.

### Stopping Agents

```typescript
// ov stop implementation for Pi
async function stopPiAgent(rpcClient: RpcClient): Promise<void> {
  await rpcClient.abort();   // cancel current operation
  await rpcClient.stop();    // close the RPC session
  // process exits cleanly
}
```

No SIGTERM-to-tmux-session needed. The RPC protocol handles graceful shutdown.

### Session Transcripts

Pi stores sessions at `~/.pi/agent/sessions/<encoded-path>/<timestamp>_<uuid>.jsonl`
as append-only JSONL. In `--mode json`, events stream to stdout with
`inputTokens` and `outputTokens` on `message_end` events:

```jsonl
{"type":"message_end","message":{...},"inputTokens":1500,"outputTokens":420}
```

### The Pi Adapter

```typescript
// src/runtimes/pi.ts

export const piRuntime: AgentRuntime = {
  id: "pi",

  buildSpawnCommand(opts: SpawnOpts): string {
    // For tmux visibility: interactive mode
    // For pure orchestration: --mode rpc
    const parts = ["pi"];

    if (opts.model) parts.push("--model", opts.model);
    if (opts.appendSystemPrompt) {
      parts.push("--append-system-prompt", quote(opts.appendSystemPrompt));
    }
    // Pi has no --permission-mode; use extension guards instead

    return parts.join(" ");
  },

  buildPrintCommand(prompt: string, model?: string): string[] {
    const args = ["pi", "--print"];
    if (model) args.push("--model", model);
    args.push(prompt);
    return args;
  },

  async deployConfig(worktreePath, overlay, hooks) {
    // Pi reads .claude/CLAUDE.md natively — use existing overlay path
    const claudeDir = join(worktreePath, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await Bun.write(join(claudeDir, "CLAUDE.md"), overlay.content);

    // Deploy guard extension instead of settings.local.json hooks
    const piExtDir = join(worktreePath, ".pi", "extensions");
    await mkdir(piExtDir, { recursive: true });
    await Bun.write(
      join(piExtDir, "overstory-guard.ts"),
      generatePiGuardExtension(hooks)
    );

    // Deploy Pi settings (model, tools config)
    const piDir = join(worktreePath, ".pi");
    await Bun.write(
      join(piDir, "settings.json"),
      JSON.stringify({ extensions: ["./extensions"] }, null, 2)
    );
  },

  detectReady(paneContent: string): ReadyState {
    // Pi TUI shows a header line and editor on startup
    // In RPC mode, readiness is detected via get_state, not pane content
    if (paneContent.includes("pi") && paneContent.includes("model:")) {
      return { phase: "ready" };
    }
    return { phase: "loading" };
  },

  async parseTranscript(path: string): Promise<TranscriptSummary | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;

    const text = await file.text();
    let totalInput = 0;
    let totalOutput = 0;
    let model = "unknown";

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === "message_end") {
        totalInput += entry.inputTokens ?? 0;
        totalOutput += entry.outputTokens ?? 0;
      }
      if (entry.type === "model_change") {
        model = entry.model ?? model;
      }
    }

    return { inputTokens: totalInput, outputTokens: totalOutput, model };
  },

  buildEnv(model: ResolvedModel): Record<string, string> {
    const env: Record<string, string> = {};
    // Pi uses standard provider env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
    if (model.provider?.authTokenEnv) {
      const val = process.env[model.provider.authTokenEnv];
      if (val) env[model.provider.authTokenEnv] = val;
    }
    return env;
  },
};
```

### Pi Integration Summary

| Dimension | Assessment |
|-----------|-----------|
| **Adapter complexity** | Low–Medium (~300 lines). RPC mode simplifies lifecycle; guard extension replaces hooks. |
| **Instruction delivery** | Zero-cost. Pi reads `.claude/CLAUDE.md` natively. |
| **Event capture** | Clean. RPC events or `--mode json` NDJSON stream. |
| **Mail delivery** | Best-in-class. RPC `followUp` delivers messages without hooks or tmux. |
| **Agent control** | Best-in-class. `steer`, `abort`, `get_state`, `waitForIdle` via RPC. |
| **Model routing** | 18+ providers natively. Local model support via `models.json`. |
| **Guard deployment** | Extension system. `tool_call` event with `{type:"block"}` response. |
| **License** | MIT |

---

## Agent Client Protocol (ACP)

ACP is an emerging standard for driving coding agents via bidirectional JSON-RPC
over stdio. Both **OpenCode** and **Cline** implement it. If ACP reaches
critical mass, Overstory could support any ACP-compliant runtime with a single
generic adapter instead of per-runtime implementations.

### What ACP Provides

ACP defines a JSON-RPC protocol over stdin/stdout:

```
Orchestrator                        Agent (ACP mode)
    │                                    │
    │──── JSON-RPC request ────────────>│
    │     {"method":"prompt",            │
    │      "params":{"text":"..."}}      │
    │                                    │
    │<──── JSON-RPC notifications ──────│
    │      {"method":"event",            │
    │       "params":{"type":"tool_call" │
    │                 ...}}              │
    │                                    │
    │<──── JSON-RPC response ───────────│
    │      {"result":{"status":"idle"}}  │
```

The protocol covers:
- **Session lifecycle:** start, prompt, abort, shutdown
- **Event streaming:** tool calls, file edits, messages, errors
- **State queries:** get current state, check if idle

### Current ACP Support

| Runtime | ACP flag | Status |
|---------|----------|--------|
| OpenCode | `opencode acp` | Implemented. Used by Zed, JetBrains, Neovim. |
| Cline | `cline --acp` | Implemented. |
| Codex | — | Not implemented. Uses `--json` NDJSON instead. |
| Pi | — | Not implemented. Has its own RPC protocol (similar concepts). |
| Amp | — | Not implemented. |
| Aider | — | Not implemented. |

### A Generic ACP Adapter

If ACP adoption grows, a single adapter handles any compliant runtime:

```typescript
// src/runtimes/acp.ts

export function createAcpRuntime(config: {
  id: string;
  binary: string;
  acpFlag: string;        // "--acp" or "acp" (subcommand)
  instructionFile: string; // "AGENTS.md", ".claude/CLAUDE.md", etc.
}): AgentRuntime {
  return {
    id: config.id,

    buildSpawnCommand(opts: SpawnOpts): string {
      return `${config.binary} ${config.acpFlag}`;
    },

    async deployConfig(worktreePath, overlay, _hooks) {
      await Bun.write(
        join(worktreePath, config.instructionFile),
        overlay.content
      );
    },

    // ACP agents communicate via stdin/stdout JSON-RPC
    // readiness is detected via the protocol, not TUI scraping
    detectReady(_paneContent: string): ReadyState {
      return { phase: "ready" };
    },

    // ... transcript parsing per-runtime since ACP doesn't standardize this
  };
}

// Usage:
const opencode = createAcpRuntime({
  id: "opencode",
  binary: "opencode",
  acpFlag: "acp",
  instructionFile: "AGENTS.md",
});

const cline = createAcpRuntime({
  id: "cline",
  binary: "cline",
  acpFlag: "--acp",
  instructionFile: "AGENTS.md",
});
```

### ACP vs Pi RPC

Pi's RPC protocol and ACP solve the same problem with different schemas. Key
differences:

| Capability | ACP | Pi RPC |
|-----------|-----|--------|
| Transport | stdin/stdout JSON-RPC | stdin/stdout JSON-RPC |
| Prompt delivery | `prompt` method | `prompt` method |
| Interruption | Varies by impl | `steer` (redirect), `abort` (cancel) |
| State query | Varies by impl | `get_state`, `waitForIdle` |
| Event streaming | JSON-RPC notifications | JSON-RPC notifications |
| Standardization | Cross-tool standard (emerging) | Pi-specific |

If ACP stabilizes with `steer`-like interruption and state queries, it could
subsume Pi's RPC protocol. Until then, both are worth supporting.

### Strategic Recommendation

Don't wait for ACP to stabilize. Build per-runtime adapters now (Claude, Codex,
Pi) using the `AgentRuntime` interface. If/when ACP becomes standard, the
generic ACP adapter slots in alongside the existing ones — the interface doesn't
change.

---

## Runtime Comparison Matrix

| Capability | Claude Code | Codex | Pi | OpenCode | Cline | Aider |
|-----------|-------------|-------|----|----------|-------|-------|
| **Headless mode** | `--print` | `exec` | `--mode rpc/json/print` | `run --format json` | `--yolo --json` | `--message` |
| **Instruction file** | `.claude/CLAUDE.md` | `AGENTS.md` | Both | `AGENTS.md` | `AGENTS.md` | None (workaround) |
| **System prompt flag** | `--append-system-prompt` | Config only | `--append-system-prompt` | Agent definition file | Config only | None |
| **NDJSON events** | No (hooks push events) | `--json` | `--mode json` | `--format json` | `--json` | None |
| **Stdin/stdout protocol** | No | No | RPC mode | ACP | ACP | No |
| **Hook/extension system** | 6 lifecycle hooks | Notifications | Rich extension events | Plugin system | Config hooks | Auto-lint/test only |
| **Tool blocking** | `{"decision":"block"}` | OS sandbox | `{type:"block"}` extension | Plugin intercept | Command permissions | N/A |
| **OS sandbox** | None (hook guards) | Seatbelt/Landlock | None | Permission rules | Command allow/deny | File scope only |
| **Model providers** | Anthropic + gateway env vars | OpenAI + custom | 18+ native | Multi-provider | Multi-provider | Multi-provider |
| **Session resume** | Transcript-based | `codex resume` | `--continue` / `--session` | `--continue` / `--session` | History-based | `--restore-chat-history` |
| **Adapter complexity** | ~250 lines (extraction) | ~200 lines | ~300 lines | ~250 lines | ~200 lines | ~400 lines (hardest) |

---

## Implementation Phases

### Phase 0: Extract the Interface

**Scope:** 3–4 new files, modify 4 existing files. Zero behavior change.

1. Create `src/runtimes/types.ts` with the `AgentRuntime` interface
2. Create `src/runtimes/claude.ts` wrapping all current Claude Code behavior
3. Create `src/runtimes/registry.ts` to resolve runtime by name from config
4. Update `sling.ts`, `coordinator.ts`, `supervisor.ts` (deprecated), `monitor.ts` to call
   `runtime.buildSpawnCommand()` instead of hardcoding `claude ...`
5. Update `hooks-deployer.ts` to be called via `runtime.deployConfig()`
6. Update `worktree/tmux.ts` to call `runtime.detectReady()` instead of
   hardcoded string checks

After this phase, `ov sling --runtime claude` produces identical behavior to
today. The abstraction exists but only one implementation does.

### Phase 1: Headless Print Abstraction

**Scope:** 1 new file, modify 2 existing files.

1. Abstract `claude --print -p <prompt>` in `merge/resolver.ts` and
   `watchdog/triage.ts` to use `runtime.buildPrintCommand()`
2. Add `runtime.printCommand` config field
3. This alone enables using any model for merge conflict resolution and
   failure triage — no full agent lifecycle needed

### Phase 2: Codex Adapter

**Scope:** 1–2 new files.

1. Create `src/runtimes/codex.ts`
2. Handle NDJSON stdout capture for event logging
3. Handle AGENTS.md instruction delivery
4. Test with a real Codex agent in a worktree
5. Add `--runtime codex` flag to `ov sling`

### Phase 3: Pi Adapter

**Scope:** 1–2 new files.

1. Create `src/runtimes/pi.ts`
2. Implement RPC client wrapper for agent lifecycle control
3. Deploy guard extension instead of hooks
4. Test mail delivery via RPC `followUp`

### Phase 4: ACP Generic Adapter (When Ready)

**Scope:** 1 file.

1. Create `src/runtimes/acp.ts` with the factory function
2. Register OpenCode, Cline, or any future ACP runtime via config

---

## Appendix: Full Coupling Inventory

### Category 1: Binary Name + CLI Flags

| # | File | Line | Code | Difficulty |
|---|------|------|------|-----------|
| 1.1 | `src/commands/sling.ts` | 619 | `claude --model ${model} --permission-mode bypassPermissions` | Hard |
| 1.2 | `src/commands/coordinator.ts` | 362 | Same + `--append-system-prompt` | Hard |
| 1.3 | `src/commands/supervisor.ts` (deprecated) | 170 | Same as 1.2 | Hard |
| 1.4 | `src/commands/monitor.ts` | 142 | Same as 1.2 | Hard |
| 1.5 | `src/merge/resolver.ts` | 268 | `claude --print -p <prompt>` (Tier 3 resolve) | Medium |
| 1.6 | `src/merge/resolver.ts` | 351 | `claude --print -p <prompt>` (Tier 4 re-imagine) | Medium |
| 1.7 | `src/watchdog/triage.ts` | 136 | `claude --print -p <prompt>` (failure classification) | Medium |

### Category 2: TUI Readiness Heuristics

| # | File | Line | String | Difficulty |
|---|------|------|--------|-----------|
| 2.1 | `src/worktree/tmux.ts` | 474 | `❯` and `'Try "'` | Hard |
| 2.2 | `src/worktree/tmux.ts` | 479 | `"bypass permissions"` and `"shift+tab"` | Hard |
| 2.3 | `src/commands/sling.ts` | 691 | `'Try "'` (beacon verification) | Hard |
| 2.4 | `src/worktree/tmux.ts` | 466 | `"trust this folder"` (auto-dismiss) | Medium |

### Category 3: Hook System

| # | File | Line | What | Difficulty |
|---|------|------|------|-----------|
| 3.1 | `src/agents/hooks-deployer.ts` | 632 | `.claude/settings.local.json` path | Hard |
| 3.2 | `templates/hooks.json.tmpl` | all | 6 Claude Code event names | Hard |
| 3.3 | `src/commands/log.ts` | 367 | Hook stdin payload schema (`session_id`, `transcript_path`) | Hard |
| 3.4 | `src/agents/hooks-deployer.ts` | 256+ | `{"decision":"block","reason":"..."}` response format | Hard |
| 3.5 | `src/commands/hooks.ts` | 94 | `.claude/settings.local.json` for orchestrator | Hard |

### Category 4: Overlay + Instruction Path

| # | File | Line | Path | Difficulty |
|---|------|------|------|-----------|
| 4.1 | `src/agents/overlay.ts` | 348 | `.claude/CLAUDE.md` write target | Hard |
| 4.2 | `src/agents/overlay.ts` | 342 | Root guard for `.claude/CLAUDE.md` | Medium |
| 4.3 | `src/commands/sling.ts` | 152 | Beacon says "read .claude/CLAUDE.md" | Medium |
| 4.4 | `src/commands/agents.ts` | 42 | Overlay discovery at `.claude/CLAUDE.md` | Trivial |

### Category 5: Transcript Format

| # | File | Line | What | Difficulty |
|---|------|------|------|-----------|
| 5.1 | `src/commands/costs.ts` | 58 | `~/.claude/projects/<key>/` path | Hard |
| 5.2 | `src/metrics/transcript.ts` | 95 | Anthropic JSONL schema parsing | Hard |
| 5.3 | `src/commands/log.ts` | 369 | `transcript_path` from hook stdin | Hard |

### Category 6: Anthropic-Specific Config

| # | File | Line | What | Difficulty |
|---|------|------|------|-----------|
| 6.1 | `src/types.ts` | 4 | `ModelAlias = "sonnet" \| "opus" \| "haiku"` | Medium |
| 6.2 | `src/agents/manifest.ts` | 304 | `ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_*_MODEL` env vars | Hard |
| 6.3 | `src/config.ts` | 635 | "non-Anthropic model" warning | Trivial |
| 6.4 | `src/config.ts` | 48 | `providers.anthropic` default | Medium |
| 6.5 | `src/logging/sanitizer.ts` | 9 | `sk-ant-*` key pattern | Trivial |
| 6.6 | `src/metrics/transcript.ts` | 39 | Opus/sonnet/haiku pricing table | Medium |

### Category 7: Tool Name Blocklists

| # | File | Line | What | Difficulty |
|---|------|------|------|-----------|
| 7.1 | `src/agents/hooks-deployer.ts` | 38 | 10 Claude Code native team tool names | Medium |
| 7.2 | `src/agents/hooks-deployer.ts` | 55 | 3 Claude Code interactive tool names | Medium |

### Category 8: Permission Mode

| # | File | Line | What | Difficulty |
|---|------|------|------|-----------|
| 8.1 | `sling.ts`, `coordinator.ts`, `supervisor.ts` (deprecated), `monitor.ts` | various | Root UID check for `--permission-mode bypassPermissions` | Trivial |

### Category 9: Hook Execution Environment

| # | File | Line | What | Difficulty |
|---|------|------|------|-----------|
| 9.1 | `src/agents/hooks-deployer.ts` | 160 | `OVERSTORY_AGENT_NAME` env guard | Medium |
| 9.2 | `src/agents/hooks-deployer.ts` | 176 | PATH prefix for Bun in Claude Code's stripped hook environment | Medium |
