import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { PROVIDER_DEFAULT_MODEL_SELECTION } from "./teamBootstrapModelSelection.js";
import type {
  TeamBootstrapRequest,
  TeamBootstrapResult,
} from "./teamBootstrapTypes.js";

type SpawnInput = Record<string, unknown>;
type DuplicateReason = "already_running" | "bootstrap_pending";
type FailedTeamBootstrapResult = Extract<TeamBootstrapResult, { ok: false }>;

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const SAFE_E2E_TIMEOUT_MS = 15_000;

describe("team bootstrap launch matrix safe e2e", () => {
  let tempConfigDir: string;
  let spawnInputs: SpawnInput[];
  let registeredMemberNames: Set<string>;
  let spawnFailures: Map<string, string>;
  let duplicateSpawns: Map<string, DuplicateReason>;
  let teamConfigExists: boolean;
  let createTeamCalls: Array<Record<string, unknown>>;
  let createTeamFailure: string | null;
  let registerSpawnedMembers: boolean;

  beforeEach(async () => {
    mock.restore();
    mock.clearAllMocks();
    tempConfigDir = await mkdtemp(
      join(tmpdir(), "team-bootstrap-launch-matrix-"),
    );
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir;
    spawnInputs = [];
    registeredMemberNames = new Set();
    spawnFailures = new Map();
    duplicateSpawns = new Map();
    teamConfigExists = true;
    createTeamCalls = [];
    createTeamFailure = null;
    registerSpawnedMembers = false;

    const buildMockTeamFile = () => ({
      name: "atlas-hq",
      leadAgentId: "team-lead@atlas-hq",
      leadSessionId: "lead-session",
      members: [
        { name: "team-lead", agentId: "team-lead@atlas-hq" },
        ...[...registeredMemberNames].map((name) => ({
          name,
          agentId: `${name}@atlas-hq`,
        })),
      ],
    });
    const { __setTeamBootstrapRunnerDepsForTests } = await import(
      "./teamBootstrapRunner.js"
    );
    __setTeamBootstrapRunnerDepsForTests({
      readTeamFileAsync: (async () =>
        teamConfigExists
          ? buildMockTeamFile()
          : null) as never,
      updateTeamFileAsync: (async (
        _teamName: string,
        updater: (teamFile: ReturnType<typeof buildMockTeamFile>) => unknown,
      ) => {
        const previousTeamFile = buildMockTeamFile();
        const updateResult = updater(previousTeamFile) as
          | { changed?: boolean; teamFile?: ReturnType<typeof buildMockTeamFile> }
          | undefined;
        return {
          status: updateResult?.changed === false ? "unchanged" : "updated",
          teamFile: updateResult?.teamFile ?? previousTeamFile,
        };
      }) as never,
      unregisterTeamForSessionCleanup: (() => {}) as never,
      spawnTeammate: (async (input: SpawnInput) => {
        spawnInputs.push(input);
        const name = String(input.name);
        const failure = spawnFailures.get(name);
        if (failure) {
          throw new Error(failure);
        }
        const duplicateReason = duplicateSpawns.get(name);
        if (duplicateReason) {
          return {
            data: {
              status: "duplicate_skipped",
              reason: duplicateReason,
              agent_id: `${name}@atlas-hq`,
              teammate_id: `${name}@atlas-hq`,
              provider: input.provider,
              model: input.model,
              name,
              team_name: "atlas-hq",
              spawned: false,
            },
          };
        }
        if (registerSpawnedMembers) {
          registeredMemberNames.add(name);
        }
        return {
          data: {
            agent_id: `${name}@atlas-hq`,
            teammate_id: `${name}@atlas-hq`,
            backend_type: input.provider === "codex" ? "codex-native" : "pane",
            name,
            spawned: true,
          },
        };
      }) as never,
      teamCreateCall: (async (input: Record<string, unknown>) => {
        createTeamCalls.push(input);
        if (createTeamFailure) {
          throw new Error(createTeamFailure);
        }
        teamConfigExists = true;
        return { data: { team_name: "atlas-hq" } };
      }) as never,
    });
  }, SAFE_E2E_TIMEOUT_MS);

  afterEach(async () => {
    const { __setTeamBootstrapRunnerDepsForTests } = await import(
      "./teamBootstrapRunner.js"
    );
    __setTeamBootstrapRunnerDepsForTests(null);
    mock.restore();
    mock.clearAllMocks();
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    await rm(tempConfigDir, { recursive: true, force: true });
  }, SAFE_E2E_TIMEOUT_MS);

  test(
    "spawns mixed Anthropic, Codex, and Gemini teammates with their exact runtime selections",
    async () => {
      registeredMemberNames = new Set(["alice", "bob", "zoe"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          members: [
            {
              originalName: "alice",
              displayName: "alice",
              normalizedName: "alice",
              prompt: "Alice bootstrap",
              provider: "anthropic",
              model: "claude-opus-4-6",
              effort: "high",
            },
            {
              originalName: "bob",
              displayName: "bob",
              normalizedName: "bob",
              prompt: "Bob bootstrap",
              provider: "codex",
              model: "gpt-5.4-mini",
              effort: "medium",
              cwd: join(tempConfigDir, "bob-workspace"),
            },
            {
              originalName: "zoe",
              displayName: "zoe",
              normalizedName: "zoe",
              prompt: "Zoe bootstrap",
              provider: "gemini",
              model: "gemini-2.5-flash",
              effort: "low",
              useSplitPane: false,
            },
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs).toMatchObject([
        {
          name: "alice",
          provider: "anthropic",
          model: "claude-opus-4-6",
          effort: "high",
        },
        {
          name: "bob",
          provider: "codex",
          model: "gpt-5.4-mini",
          effort: "medium",
          cwd: join(tempConfigDir, "bob-workspace"),
        },
        {
          name: "zoe",
          provider: "gemini",
          model: "gemini-2.5-flash",
          effort: "low",
          use_splitpane: false,
        },
      ]);
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "alice",
        outcome: "spawned",
        agentId: "alice@atlas-hq",
        teammateId: "alice@atlas-hq",
        backendType: "pane",
      });
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "bob",
        outcome: "spawned",
        agentId: "bob@atlas-hq",
        teammateId: "bob@atlas-hq",
        backendType: "codex-native",
      });
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "zoe",
        outcome: "spawned",
        agentId: "zoe@atlas-hq",
        teammateId: "zoe@atlas-hq",
        backendType: "pane",
      });
      expect(events.items).toContainEqual({
        type: "completed",
        status: "completed",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "audits mixed primary teammates after spawn registers them in team config",
    async () => {
      registerSpawnedMembers = true;
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          members: [
            member("alice", "anthropic", "claude-opus-4-6"),
            member("bob", "codex", "gpt-5.4-mini"),
            member("zoe", "gemini", "gemini-2.5-flash"),
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs.map((input) => input.name)).toEqual([
        "alice",
        "bob",
        "zoe",
      ]);
      if (!result.ok) {
        throw new Error("expected dynamic registration launch success");
      }
      expect(result.summary.terminalStatus).toBe("completed");
      expect(result.summary.expectedMembers).toEqual(["alice", "bob", "zoe"]);
      expect(result.summary.registeredMembers).toEqual(["alice", "bob", "zoe"]);
      expect(result.summary.failedMembers).toEqual([]);
      expect(events.completedEvents).toEqual([
        {
          status: "completed",
          expectedMembers: ["alice", "bob", "zoe"],
          registeredMembers: ["alice", "bob", "zoe"],
          failedMembers: [],
        },
      ]);
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "spawns provider-default primary teammates without forwarding synthetic model values",
    async () => {
      registeredMemberNames = new Set(["alice", "bob", "zoe"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          members: [
            {
              originalName: "alice",
              displayName: "alice",
              normalizedName: "alice",
              prompt: "Alice Anthropic default bootstrap",
              provider: "anthropic",
              model: PROVIDER_DEFAULT_MODEL_SELECTION,
              effort: "medium",
            },
            {
              originalName: "bob",
              displayName: "bob",
              normalizedName: "bob",
              prompt: "Bob Codex default bootstrap",
              provider: "codex",
              model: PROVIDER_DEFAULT_MODEL_SELECTION,
              effort: "high",
            },
            {
              originalName: "zoe",
              displayName: "zoe",
              normalizedName: "zoe",
              prompt: "Zoe Gemini default bootstrap",
              provider: "gemini",
              model: PROVIDER_DEFAULT_MODEL_SELECTION,
              effort: "low",
            },
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected provider-default launch success");
      }
      expect(spawnInputs).toMatchObject([
        {
          name: "alice",
          provider: "anthropic",
          effort: "medium",
        },
        {
          name: "bob",
          provider: "codex",
          effort: "high",
        },
        {
          name: "zoe",
          provider: "gemini",
          effort: "low",
        },
      ]);
      expect(spawnInputs[0]).not.toHaveProperty("model");
      expect(spawnInputs[1]).not.toHaveProperty("model");
      expect(spawnInputs[2]).not.toHaveProperty("model");
      expect(result.summary.terminalStatus).toBe("completed");
      expect(events.items).toContainEqual({
        type: "completed",
        status: "completed",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "spawns a pure Codex teammate roster with exact model and effort selections",
    async () => {
      registeredMemberNames = new Set(["alice", "bob"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          members: [
            {
              originalName: "alice",
              displayName: "alice",
              normalizedName: "alice",
              prompt: "Alice Codex bootstrap",
              provider: "codex",
              model: "gpt-5.4-mini",
              effort: "low",
            },
            {
              originalName: "bob",
              displayName: "bob",
              normalizedName: "bob",
              prompt: "Bob Codex bootstrap",
              provider: "codex",
              model: "gpt-5.4",
              effort: "high",
              planModeRequired: true,
            },
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs).toMatchObject([
        {
          name: "alice",
          provider: "codex",
          model: "gpt-5.4-mini",
          effort: "low",
        },
        {
          name: "bob",
          provider: "codex",
          model: "gpt-5.4",
          effort: "high",
          plan_mode_required: true,
        },
      ]);
      if (!result.ok) {
        throw new Error("expected pure Codex launch success");
      }
      expect(result.summary.terminalStatus).toBe("completed");
      expect(result.summary.registeredMembers).toEqual(["alice", "bob"]);
      expect(events.items).toContainEqual({
        type: "completed",
        status: "completed",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "spawns a pure Anthropic teammate roster with exact model and agent metadata",
    async () => {
      registeredMemberNames = new Set(["alice", "bob"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          members: [
            {
              ...member("alice", "anthropic", "claude-opus-4-6"),
              effort: "high",
              agentType: "reviewer",
              description: "Reviews launch quality",
            },
            {
              ...member("bob", "anthropic", "claude-sonnet-4-6"),
              effort: "low",
              cwd: join(tempConfigDir, "bob-pane-cwd"),
            },
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs).toMatchObject([
        {
          name: "alice",
          provider: "anthropic",
          model: "claude-opus-4-6",
          effort: "high",
          agent_type: "reviewer",
          description: "Reviews launch quality",
        },
        {
          name: "bob",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          effort: "low",
          cwd: join(tempConfigDir, "bob-pane-cwd"),
        },
      ]);
      if (!result.ok) {
        throw new Error("expected pure Anthropic launch success");
      }
      expect(result.summary.terminalStatus).toBe("completed");
      expect(result.summary.registeredMembers).toEqual(["alice", "bob"]);
      expect(events.items).toContainEqual({
        type: "completed",
        status: "completed",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "spawns a pure Gemini teammate roster with exact model and split-pane selections",
    async () => {
      registeredMemberNames = new Set(["alice", "zoe"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          members: [
            {
              ...member("alice", "gemini", "gemini-2.5-pro"),
              effort: "high",
              useSplitPane: true,
            },
            {
              ...member("zoe", "gemini", "gemini-2.5-flash"),
              effort: "low",
              useSplitPane: false,
            },
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs).toMatchObject([
        {
          name: "alice",
          provider: "gemini",
          model: "gemini-2.5-pro",
          effort: "high",
          use_splitpane: true,
        },
        {
          name: "zoe",
          provider: "gemini",
          model: "gemini-2.5-flash",
          effort: "low",
          use_splitpane: false,
        },
      ]);
      if (!result.ok) {
        throw new Error("expected pure Gemini launch success");
      }
      expect(result.summary.terminalStatus).toBe("completed");
      expect(result.summary.registeredMembers).toEqual(["alice", "zoe"]);
      expect(events.items).toContainEqual({
        type: "completed",
        status: "completed",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "keeps cwd and worktree isolation scoped to the intended mixed-provider teammates",
    async () => {
      registeredMemberNames = new Set(["alice", "bob", "zoe"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();
      const aliceCwd = join(tempConfigDir, "alice-pane-cwd");
      const bobWorktreeCwd = join(tempConfigDir, "bob-worktree-cwd");
      const zoeCwd = join(tempConfigDir, "zoe-pane-cwd");

      const result = await runTeamBootstrap({
        request: request({
          members: [
            {
              ...member("alice", "anthropic", "claude-opus-4-6"),
              cwd: aliceCwd,
            },
            {
              ...member("bob", "codex", "gpt-5.4-mini"),
              cwd: bobWorktreeCwd,
              isolation: "worktree",
            },
            {
              ...member("zoe", "gemini", "gemini-2.5-flash"),
              cwd: zoeCwd,
              useSplitPane: false,
            },
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs).toMatchObject([
        {
          name: "alice",
          provider: "anthropic",
          cwd: aliceCwd,
        },
        {
          name: "bob",
          provider: "codex",
          isolation: "worktree",
        },
        {
          name: "zoe",
          provider: "gemini",
          cwd: zoeCwd,
          use_splitpane: false,
        },
      ]);
      expect(spawnInputs[1]).not.toHaveProperty("cwd");
      if (!result.ok) {
        throw new Error("expected mixed-provider cwd isolation launch success");
      }
      expect(result.summary.terminalStatus).toBe("completed");
      expect(events.items).toContainEqual({
        type: "completed",
        status: "completed",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "creates a missing team config before spawning a mixed primary roster",
    async () => {
      teamConfigExists = false;
      registeredMemberNames = new Set(["alice", "bob"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          mode: "create",
          description: "created by safe launch matrix",
          members: [
            member("alice", "codex", "gpt-5.4-mini"),
            member("bob", "gemini", "gemini-2.5-flash"),
          ],
        }),
        context: detachedContext(),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(createTeamCalls).toEqual([
        {
          team_name: "atlas-hq",
          description: "created by safe launch matrix",
        },
      ]);
      expect(spawnInputs).toMatchObject([
        {
          name: "alice",
          provider: "codex",
          model: "gpt-5.4-mini",
        },
        {
          name: "bob",
          provider: "gemini",
          model: "gemini-2.5-flash",
        },
      ]);
      if (!result.ok) {
        throw new Error("expected create-mode mixed roster launch success");
      }
      expect(result.summary.createdTeam).toBe(true);
      expect(result.summary.reusedExistingTeam).toBe(false);
      expect(result.summary.terminalStatus).toBe("completed");
      expect(events.items).toContainEqual({
        type: "team_created",
        reusedExistingTeam: false,
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "fails before spawning teammates when launch mode cannot find an existing team config",
    async () => {
      teamConfigExists = false;
      registeredMemberNames = new Set(["alice"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          mode: "launch",
          members: [member("alice", "codex", "gpt-5.4-mini")],
        }),
        context: detachedContext(),
        emit: events.emit,
      });

      expect(result.ok).toBe(false);
      expect(createTeamCalls).toEqual([]);
      expect(spawnInputs).toEqual([]);
      if (result.ok) {
        throw new Error("expected missing launch team config to fail");
      }
      const failure = result as FailedTeamBootstrapResult;
      expect(failure.error).toContain("team config does not exist");
      expect(
        events.items.some((item) => item.type === "member_spawn_started"),
      ).toBe(false);
      expect(events.items).toContainEqual({
        type: "failed",
        reason: failure.error,
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "fails before spawning teammates when create mode cannot create the team config",
    async () => {
      teamConfigExists = false;
      createTeamFailure = "TeamCreateTool failed to persist config";
      registeredMemberNames = new Set(["alice"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          mode: "create",
          members: [member("alice", "codex", "gpt-5.4-mini")],
        }),
        context: detachedContext(),
        emit: events.emit,
      });

      expect(result.ok).toBe(false);
      expect(createTeamCalls).toEqual([
        {
          team_name: "atlas-hq",
        },
      ]);
      expect(spawnInputs).toEqual([]);
      if (result.ok) {
        throw new Error("expected create team failure");
      }
      const failure = result as FailedTeamBootstrapResult;
      expect(failure.error).toContain("TeamCreateTool failed to persist config");
      expect(
        events.items.some((item) => item.type === "member_spawn_started"),
      ).toBe(false);
      expect(events.items).toContainEqual({
        type: "failed",
        reason: failure.error,
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "completes a lead-only primary lane when mixed OpenCode teammates are launched separately",
    async () => {
      registeredMemberNames = new Set();
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          members: [],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs).toEqual([]);
      if (!result.ok) {
        throw new Error("expected lead-only primary lane success");
      }
      expect(result.summary.terminalStatus).toBe("completed");
      expect(result.summary.expectedMembers).toEqual([]);
      expect(result.summary.registeredMembers).toEqual([]);
      expect(events.items).toContainEqual({ type: "started", members: [] });
      expect(events.items).toContainEqual({
        type: "completed",
        status: "completed",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "spawns only primary Codex teammates when OpenCode secondary teammates are outside the bootstrap spec",
    async () => {
      registeredMemberNames = new Set(["alice", "bob", "jack"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          members: [
            {
              originalName: "alice",
              displayName: "alice",
              normalizedName: "alice",
              prompt: "Alice Codex bootstrap",
              provider: "codex",
              model: "gpt-5.4-mini",
              effort: "medium",
            },
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs.map((input) => input.name)).toEqual(["alice"]);
      if (!result.ok) {
        throw new Error("expected mixed primary lane bootstrap success");
      }
      expect(result.summary.terminalStatus).toBe("completed");
      expect(result.summary.expectedMembers).toEqual(["alice"]);
      expect(result.summary.registeredMembers).toEqual([
        "alice",
        "bob",
        "jack",
      ]);
      expect(result.summary.failedMembers).toEqual([]);
      expect(events.items).toContainEqual({
        type: "member_spawn_started",
        memberName: "alice",
      });
      expect(events.items).not.toContainEqual({
        type: "member_spawn_started",
        memberName: "bob",
      });
      expect(events.items).not.toContainEqual({
        type: "member_spawn_started",
        memberName: "jack",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "rejects malformed primary OpenCode teammates before spawn dispatch",
    async () => {
      registeredMemberNames = new Set(["alice"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          members: [
            {
              ...member("alice", "codex", "gpt-5.4-mini"),
              effort: "medium",
            },
            {
              originalName: "bob",
              displayName: "bob",
              normalizedName: "bob",
              prompt: "Bob malformed primary OpenCode bootstrap",
              provider: "opencode" as never,
              model: "openrouter/minimax-m2.5-free",
              effort: "medium",
            },
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs.map((input) => input.name)).toEqual(["alice"]);
      if (!result.ok) {
        throw new Error(
          "expected malformed primary OpenCode to become partial success",
        );
      }
      expect(result.summary.terminalStatus).toBe("partial_success");
      expect(result.summary.failedMembers).toEqual([
        {
          name: "bob",
          reason:
            'Provider "opencode" cannot be launched in primary bootstrap. OpenCode teammates must use secondary OpenCode runtime lanes.',
        },
      ]);
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "bob",
        outcome: "failed",
        reason:
          'Provider "opencode" cannot be launched in primary bootstrap. OpenCode teammates must use secondary OpenCode runtime lanes.',
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "does not require OpenCode secondary teammates to be registered during primary audit",
    async () => {
      registeredMemberNames = new Set(["alice"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          runId: "run-primary-before-opencode-secondary",
          members: [
            {
              originalName: "alice",
              displayName: "alice",
              normalizedName: "alice",
              prompt: "Alice Codex bootstrap",
              provider: "codex",
              model: "gpt-5.4-mini",
              effort: "medium",
            },
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs.map((input) => input.name)).toEqual(["alice"]);
      if (!result.ok) {
        throw new Error(
          "expected primary lane success before OpenCode side lanes materialize",
        );
      }
      expect(result.summary.terminalStatus).toBe("completed");
      expect(result.summary.expectedMembers).toEqual(["alice"]);
      expect(result.summary.registeredMembers).toEqual(["alice"]);
      expect(result.summary.failedMembers).toEqual([]);
      expect(events.completedEvents).toEqual([
        {
          status: "completed",
          expectedMembers: ["alice"],
          registeredMembers: ["alice"],
          failedMembers: [],
        },
      ]);
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "reports only primary lane audit failures when OpenCode secondary teammates are outside the bootstrap spec",
    async () => {
      registeredMemberNames = new Set(["bob", "jack"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: true,
          members: [
            {
              originalName: "alice",
              displayName: "alice",
              normalizedName: "alice",
              prompt: "Alice Codex bootstrap",
              provider: "codex",
              model: "gpt-5.4-mini",
              effort: "medium",
            },
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs.map((input) => input.name)).toEqual(["alice"]);
      if (!result.ok) {
        throw new Error("expected mixed primary lane partial success");
      }
      expect(result.summary.terminalStatus).toBe("partial_success");
      expect(result.summary.expectedMembers).toEqual(["alice"]);
      expect(result.summary.registeredMembers).toEqual(["bob", "jack"]);
      expect(result.summary.failedMembers).toEqual([
        {
          name: "alice",
          reason:
            "Teammate was not registered in config.json during deterministic bootstrap.",
        },
      ]);
      expect(
        result.summary.failedMembers.some((member) => member.name === "bob"),
      ).toBe(false);
      expect(
        result.summary.failedMembers.some((member) => member.name === "jack"),
      ).toBe(false);
      expect(events.items).toContainEqual({
        type: "completed",
        status: "partial_success",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "fails strict primary lane audit without blaming OpenCode secondary teammates outside the bootstrap spec",
    async () => {
      registeredMemberNames = new Set(["bob", "jack"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: false,
          members: [
            {
              originalName: "alice",
              displayName: "alice",
              normalizedName: "alice",
              prompt: "Alice Codex bootstrap",
              provider: "codex",
              model: "gpt-5.4-mini",
              effort: "medium",
            },
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(false);
      expect(spawnInputs.map((input) => input.name)).toEqual(["alice"]);
      if (result.ok) {
        throw new Error("expected strict mixed primary lane failure");
      }
      const failure = result as FailedTeamBootstrapResult;
      expect(failure.error).toContain(
        "alice: Teammate was not registered in config.json",
      );
      expect(failure.error).not.toContain("bob");
      expect(failure.error).not.toContain("jack");
      expect(result.summary?.terminalStatus).toBe("failed");
      expect(result.summary?.expectedMembers).toEqual(["alice"]);
      expect(result.summary?.registeredMembers).toEqual(["bob", "jack"]);
      expect(result.summary?.failedMembers).toEqual([
        {
          name: "alice",
          reason:
            "Teammate was not registered in config.json during deterministic bootstrap.",
        },
      ]);
      expect(events.items).toContainEqual({
        type: "failed",
        reason: failure.error,
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "continues spawning later teammates after one spawn failure when partial success is allowed",
    async () => {
      registeredMemberNames = new Set(["alice", "zoe"]);
      spawnFailures.set("bob", "Codex native runtime unavailable");
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: true,
          members: [
            member("alice", "anthropic", "claude-opus-4-6"),
            member("bob", "codex", "gpt-5.4-mini"),
            member("zoe", "gemini", "gemini-2.5-flash"),
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(spawnInputs.map((input) => input.name)).toEqual([
        "alice",
        "bob",
        "zoe",
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected partial success");
      }
      expect(result.summary.terminalStatus).toBe("partial_success");
      expect(result.summary.failedMembers).toEqual([
        { name: "bob", reason: "Codex native runtime unavailable" },
      ]);
      expect(events.completedEvents).toEqual([
        {
          status: "partial_success",
          expectedMembers: ["alice", "bob", "zoe"],
          registeredMembers: ["alice", "zoe"],
          failedMembers: [
            { name: "bob", reason: "Codex native runtime unavailable" },
          ],
        },
      ]);
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "bob",
        outcome: "failed",
        reason: "Codex native runtime unavailable",
      });
      expect(events.items).toContainEqual({
        type: "completed",
        status: "partial_success",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "continues spawning Codex and Gemini teammates after the first Anthropic spawn fails",
    async () => {
      registeredMemberNames = new Set(["bob", "zoe"]);
      spawnFailures.set("alice", "Anthropic CLI exited before bootstrap");
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: true,
          members: [
            member("alice", "anthropic", "claude-opus-4-6"),
            member("bob", "codex", "gpt-5.4-mini"),
            member("zoe", "gemini", "gemini-2.5-flash"),
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(spawnInputs.map((input) => input.name)).toEqual([
        "alice",
        "bob",
        "zoe",
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected partial success after first-member failure");
      }
      expect(result.summary.terminalStatus).toBe("partial_success");
      expect(result.summary.registeredMembers).toEqual(["bob", "zoe"]);
      expect(result.summary.failedMembers).toEqual([
        { name: "alice", reason: "Anthropic CLI exited before bootstrap" },
      ]);
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "alice",
        outcome: "failed",
        reason: "Anthropic CLI exited before bootstrap",
      });
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "bob",
        outcome: "spawned",
        agentId: "bob@atlas-hq",
        teammateId: "bob@atlas-hq",
        backendType: "codex-native",
      });
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "zoe",
        outcome: "spawned",
        agentId: "zoe@atlas-hq",
        teammateId: "zoe@atlas-hq",
        backendType: "pane",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "continues spawning Anthropic and Codex teammates after the first Gemini spawn fails",
    async () => {
      registeredMemberNames = new Set(["alice", "bob"]);
      spawnFailures.set("zoe", "Gemini pane failed to start");
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: true,
          members: [
            member("zoe", "gemini", "gemini-2.5-flash"),
            member("alice", "anthropic", "claude-opus-4-6"),
            member("bob", "codex", "gpt-5.4-mini"),
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(spawnInputs.map((input) => input.name)).toEqual([
        "zoe",
        "alice",
        "bob",
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected partial success after first Gemini failure");
      }
      expect(result.summary.terminalStatus).toBe("partial_success");
      expect(result.summary.registeredMembers).toEqual(["alice", "bob"]);
      expect(result.summary.failedMembers).toEqual([
        { name: "zoe", reason: "Gemini pane failed to start" },
      ]);
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "zoe",
        outcome: "failed",
        reason: "Gemini pane failed to start",
      });
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "alice",
        outcome: "spawned",
        agentId: "alice@atlas-hq",
        teammateId: "alice@atlas-hq",
        backendType: "pane",
      });
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "bob",
        outcome: "spawned",
        agentId: "bob@atlas-hq",
        teammateId: "bob@atlas-hq",
        backendType: "codex-native",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "fails partial-mode bootstrap when every provider spawn fails",
    async () => {
      spawnFailures.set("alice", "Anthropic CLI exited before bootstrap");
      spawnFailures.set("bob", "Codex native runtime unavailable");
      spawnFailures.set("zoe", "Gemini pane failed to start");
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: true,
          members: [
            member("alice", "anthropic", "claude-opus-4-6"),
            member("bob", "codex", "gpt-5.4-mini"),
            member("zoe", "gemini", "gemini-2.5-flash"),
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(spawnInputs.map((input) => input.name)).toEqual([
        "alice",
        "bob",
        "zoe",
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected all-provider spawn failure");
      }
      const failure = result as FailedTeamBootstrapResult;
      expect(result.summary?.terminalStatus).toBe("failed");
      expect(result.summary?.registeredMembers).toEqual([]);
      expect(result.summary?.failedMembers).toEqual([
        { name: "alice", reason: "Anthropic CLI exited before bootstrap" },
        { name: "bob", reason: "Codex native runtime unavailable" },
        { name: "zoe", reason: "Gemini pane failed to start" },
      ]);
      expect(failure.error).toContain("no teammates were registered");
      expect(events.completedEvents).toEqual([]);
      expect(events.items).toContainEqual({
        type: "failed",
        reason: failure.error,
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "fails strict bootstrap on direct spawn failures without hiding successful peers",
    async () => {
      registeredMemberNames = new Set(["alice", "zoe"]);
      spawnFailures.set("bob", "Codex native runtime unavailable");
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: false,
          members: [
            member("alice", "anthropic", "claude-opus-4-6"),
            member("bob", "codex", "gpt-5.4-mini"),
            member("zoe", "gemini", "gemini-2.5-flash"),
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(spawnInputs.map((input) => input.name)).toEqual([
        "alice",
        "bob",
        "zoe",
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected strict bootstrap failure");
      }
      const failure = result as FailedTeamBootstrapResult;
      expect(failure.error).toContain("bob: Codex native runtime unavailable");
      expect(result.summary?.registeredMembers).toEqual(["alice", "zoe"]);
      expect(events.items).toContainEqual({
        type: "failed",
        reason: failure.error,
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "treats duplicate already-running and bootstrap-pending teammates as registered outcomes",
    async () => {
      registeredMemberNames = new Set(["alice", "bob", "zoe"]);
      duplicateSpawns.set("bob", "already_running");
      duplicateSpawns.set("zoe", "bootstrap_pending");
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          members: [
            member("alice", "anthropic", "claude-opus-4-6"),
            member("bob", "codex", "gpt-5.4-mini"),
            member("zoe", "gemini", "gemini-2.5-flash"),
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected completed duplicate recovery");
      }
      expect(result.summary.terminalStatus).toBe("completed");
      expect(result.summary.failedMembers).toEqual([]);
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "bob",
        outcome: "already_running",
        agentId: "bob@atlas-hq",
        teammateId: "bob@atlas-hq",
        reason: "already_running",
      });
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "zoe",
        outcome: "duplicate_pending",
        agentId: "zoe@atlas-hq",
        teammateId: "zoe@atlas-hq",
        reason: "bootstrap_pending",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "does not trust duplicate spawn results unless config audit confirms the teammate",
    async () => {
      registeredMemberNames = new Set(["alice"]);
      duplicateSpawns.set("bob", "already_running");
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: true,
          members: [
            member("alice", "codex", "gpt-5.4-mini"),
            member("bob", "codex", "gpt-5.4"),
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs.map((input) => input.name)).toEqual(["alice", "bob"]);
      if (!result.ok) {
        throw new Error("expected partial duplicate audit failure");
      }
      expect(result.summary.terminalStatus).toBe("partial_success");
      expect(result.summary.registeredMembers).toEqual(["alice"]);
      expect(result.summary.failedMembers).toEqual([
        {
          name: "bob",
          reason:
            "Teammate was not registered in config.json during deterministic bootstrap.",
        },
      ]);
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "bob",
        outcome: "already_running",
        agentId: "bob@atlas-hq",
        teammateId: "bob@atlas-hq",
        reason: "already_running",
      });
      expect(events.completedEvents).toEqual([
        {
          status: "partial_success",
          expectedMembers: ["alice", "bob"],
          registeredMembers: ["alice"],
          failedMembers: [
            {
              name: "bob",
              reason:
                "Teammate was not registered in config.json during deterministic bootstrap.",
            },
          ],
        },
      ]);
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "does not finish successfully for bootstrap-pending duplicates missing from config audit",
    async () => {
      duplicateSpawns.set("bob", "bootstrap_pending");
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: true,
          members: [member("bob", "codex", "gpt-5.4-mini")],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(false);
      expect(spawnInputs.map((input) => input.name)).toEqual(["bob"]);
      if (result.ok) {
        throw new Error("expected bootstrap-pending duplicate audit failure");
      }
      const failure = result as FailedTeamBootstrapResult;
      expect(result.summary?.terminalStatus).toBe("failed");
      expect(result.summary?.registeredMembers).toEqual([]);
      expect(result.summary?.failedMembers).toEqual([
        {
          name: "bob",
          reason:
            "Teammate was not registered in config.json during deterministic bootstrap.",
        },
      ]);
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "bob",
        outcome: "duplicate_pending",
        agentId: "bob@atlas-hq",
        teammateId: "bob@atlas-hq",
        reason: "bootstrap_pending",
      });
      expect(events.completedEvents).toEqual([]);
      expect(events.items).toContainEqual({
        type: "failed",
        reason: failure.error,
      });
      expect(failure.error).toContain("no teammates were registered");
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "does not finish successfully for already-running duplicates missing from config audit",
    async () => {
      duplicateSpawns.set("bob", "already_running");
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: true,
          members: [member("bob", "codex", "gpt-5.4-mini")],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(false);
      expect(spawnInputs.map((input) => input.name)).toEqual(["bob"]);
      if (result.ok) {
        throw new Error("expected already-running duplicate audit failure");
      }
      const failure = result as FailedTeamBootstrapResult;
      expect(result.summary?.terminalStatus).toBe("failed");
      expect(result.summary?.registeredMembers).toEqual([]);
      expect(result.summary?.failedMembers).toEqual([
        {
          name: "bob",
          reason:
            "Teammate was not registered in config.json during deterministic bootstrap.",
        },
      ]);
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "bob",
        outcome: "already_running",
        agentId: "bob@atlas-hq",
        teammateId: "bob@atlas-hq",
        reason: "already_running",
      });
      expect(events.completedEvents).toEqual([]);
      expect(events.items).toContainEqual({
        type: "failed",
        reason: failure.error,
      });
      expect(failure.error).toContain("no teammates were registered");
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "fails strict bootstrap for bootstrap-pending duplicates missing from config audit",
    async () => {
      duplicateSpawns.set("bob", "bootstrap_pending");
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: false,
          members: [member("bob", "codex", "gpt-5.4-mini")],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(false);
      expect(spawnInputs.map((input) => input.name)).toEqual(["bob"]);
      if (result.ok) {
        throw new Error(
          "expected strict bootstrap-pending duplicate audit failure",
        );
      }
      const failure = result as FailedTeamBootstrapResult;
      expect(failure.error).toContain(
        "bob: Teammate was not registered in config.json",
      );
      expect(result.summary?.terminalStatus).toBe("failed");
      expect(result.summary?.registeredMembers).toEqual([]);
      expect(result.summary?.failedMembers).toEqual([
        {
          name: "bob",
          reason:
            "Teammate was not registered in config.json during deterministic bootstrap.",
        },
      ]);
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "bob",
        outcome: "duplicate_pending",
        agentId: "bob@atlas-hq",
        teammateId: "bob@atlas-hq",
        reason: "bootstrap_pending",
      });
      expect(events.items).toContainEqual({
        type: "failed",
        reason: failure.error,
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "emits launch progress in order for a mixed primary roster",
    async () => {
      registeredMemberNames = new Set(["alice", "bob"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          members: [
            member("alice", "anthropic", "claude-opus-4-6"),
            member("bob", "codex", "gpt-5.4-mini"),
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      expect(events.items.map(toEventLabel)).toEqual([
        "started:alice,bob",
        "phase:validating_spec",
        "phase:loading_existing_state",
        "phase:acquiring_bootstrap_lock",
        "team_created:reused",
        "phase:spawning_members",
        "member_spawn_started:alice",
        "member_spawn_result:alice:spawned",
        "member_spawn_started:bob",
        "member_spawn_result:bob:spawned",
        "phase:auditing_truth",
        "completed:completed",
      ]);
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "fails before spawning teammates when the bootstrap timeout expires at member join",
    async () => {
      registeredMemberNames = new Set(["alice"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();
      let monotonicNowMs = 0;

      const result = await runTeamBootstrap({
        request: request({
          bootstrapTimeoutMs: 150,
          members: [member("alice", "codex", "gpt-5.4-mini")],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
        monotonicNow: () => {
          monotonicNowMs += 40;
          return monotonicNowMs;
        },
      });

      expect(result.ok).toBe(false);
      expect(spawnInputs).toEqual([]);
      if (result.ok) {
        throw new Error("expected timeout before member spawn");
      }
      const failure = result as FailedTeamBootstrapResult;
      expect(failure.error).toContain('before spawning teammate "alice"');
      expect(events.items).toContainEqual({
        type: "phase",
        phase: "spawning_members",
      });
      expect(
        events.items.some((item) => item.type === "member_spawn_started"),
      ).toBe(false);
      expect(events.items).toContainEqual({
        type: "failed",
        reason: failure.error,
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "fails after a partial spawn when the bootstrap timeout expires before the next teammate",
    async () => {
      registeredMemberNames = new Set(["alice"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();
      let monotonicNowMs = 0;

      const result = await runTeamBootstrap({
        request: request({
          bootstrapTimeoutMs: 190,
          members: [
            member("alice", "anthropic", "claude-opus-4-6"),
            member("bob", "codex", "gpt-5.4-mini"),
            member("zoe", "gemini", "gemini-2.5-flash"),
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
        monotonicNow: () => {
          monotonicNowMs += 40;
          return monotonicNowMs;
        },
      });

      expect(result.ok).toBe(false);
      expect(spawnInputs.map((input) => input.name)).toEqual(["alice"]);
      if (result.ok) {
        throw new Error("expected timeout after partial spawn");
      }
      const failure = result as FailedTeamBootstrapResult;
      expect(failure.error).toContain('before spawning teammate "bob"');
      expect(events.items).toContainEqual({
        type: "member_spawn_started",
        memberName: "alice",
      });
      expect(events.items).toContainEqual({
        type: "member_spawn_result",
        memberName: "alice",
        outcome: "spawned",
        agentId: "alice@atlas-hq",
        teammateId: "alice@atlas-hq",
        backendType: "pane",
      });
      expect(events.items.some((item) => item.type === "completed")).toBe(
        false,
      );
      expect(events.items).toContainEqual({
        type: "failed",
        reason: failure.error,
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "dispatches worktree-isolated teammates without leaking a cwd override",
    async () => {
      registeredMemberNames = new Set(["alice", "bob"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");

      const result = await runTeamBootstrap({
        request: request({
          members: [
            member("alice", "anthropic", "claude-opus-4-6"),
            {
              ...member("bob", "codex", "gpt-5.4-mini"),
              isolation: "worktree",
              cwd: join(tempConfigDir, "must-not-forward"),
            },
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: createProgressEventSink().emit,
      });

      expect(result.ok).toBe(true);
      expect(spawnInputs[1]).toMatchObject({
        name: "bob",
        provider: "codex",
        model: "gpt-5.4-mini",
        isolation: "worktree",
      });
      expect(spawnInputs[1]).not.toHaveProperty("cwd");
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "runs hidden TeamBootstrapTool input through spec normalization and spawn dispatch",
    async () => {
      const originalDeterministicFlag =
        process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
      const originalBootstrapToolFlag =
        process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL;
      registeredMemberNames = new Set(["alice", "bob", "zoe"]);
      process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP = "1";
      process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL = "1";
      try {
        const { TeamBootstrapTool } =
          await import("src/tools/TeamBootstrapTool/TeamBootstrapTool.js");

        const result = await TeamBootstrapTool.call(
          {
            mode: "launch",
            team_name: "atlas-hq",
            continue_on_partial_failure: true,
            members: [
              {
                name: "alice",
                provider: "anthropic",
                model: "claude-opus-4-6",
                effort: "high",
              },
              {
                name: "bob",
                provider: "codex",
                model: "gpt-5.4-mini",
                effort: "medium",
                plan_mode_required: true,
              },
              {
                name: "zoe",
                provider: "gemini",
                model: "gemini-2.5-flash",
                effort: "low",
                use_split_pane: false,
              },
            ],
          },
          attachedContext("atlas-hq"),
        );

        expect(result.data).toMatchObject({
          teamName: "atlas-hq",
          terminalStatus: "completed",
          expectedMembers: ["alice", "bob", "zoe"],
          registeredMembers: ["alice", "bob", "zoe"],
          failedMembers: [],
        });
        expect(spawnInputs).toMatchObject([
          {
            name: "alice",
            provider: "anthropic",
            model: "claude-opus-4-6",
            effort: "high",
          },
          {
            name: "bob",
            provider: "codex",
            model: "gpt-5.4-mini",
            effort: "medium",
            plan_mode_required: true,
          },
          {
            name: "zoe",
            provider: "gemini",
            model: "gemini-2.5-flash",
            effort: "low",
            use_splitpane: false,
          },
        ]);
      } finally {
        if (originalDeterministicFlag === undefined) {
          delete process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP;
        } else {
          process.env.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP =
            originalDeterministicFlag;
        }
        if (originalBootstrapToolFlag === undefined) {
          delete process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL;
        } else {
          process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL =
            originalBootstrapToolFlag;
        }
      }
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "reports partial success when a spawned teammate is missing from config audit",
    async () => {
      registeredMemberNames = new Set(["alice"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: true,
          members: [
            member("alice", "anthropic", "claude-opus-4-6"),
            member("bob", "codex", "gpt-5.4-mini"),
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected partial success");
      }
      expect(result.summary.terminalStatus).toBe("partial_success");
      expect(result.summary.failedMembers).toEqual([
        {
          name: "bob",
          reason:
            "Teammate was not registered in config.json during deterministic bootstrap.",
        },
      ]);
      expect(events.completedEvents).toEqual([
        {
          status: "partial_success",
          expectedMembers: ["alice", "bob"],
          registeredMembers: ["alice"],
          failedMembers: [
            {
              name: "bob",
              reason:
                "Teammate was not registered in config.json during deterministic bootstrap.",
            },
          ],
        },
      ]);
      expect(events.items).toContainEqual({
        type: "completed",
        status: "partial_success",
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );

  test(
    "fails strict bootstrap when config audit cannot prove every spawned teammate",
    async () => {
      registeredMemberNames = new Set(["alice"]);
      const { runTeamBootstrap } = await import("./teamBootstrapRunner.js");
      const events = createProgressEventSink();

      const result = await runTeamBootstrap({
        request: request({
          continueOnPartialFailure: false,
          members: [
            member("alice", "anthropic", "claude-opus-4-6"),
            member("bob", "codex", "gpt-5.4-mini"),
          ],
        }),
        context: attachedContext("atlas-hq"),
        emit: events.emit,
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected strict bootstrap failure");
      }
      const failure = result as FailedTeamBootstrapResult;
      expect(failure.error).toContain(
        "bob: Teammate was not registered in config.json",
      );
      expect(events.items).toContainEqual({
        type: "failed",
        reason: failure.error,
      });
    },
    SAFE_E2E_TIMEOUT_MS,
  );
});

function request(
  overrides: Partial<TeamBootstrapRequest> = {},
): TeamBootstrapRequest {
  const members = overrides.members ?? [
    member("alice", "anthropic", "claude-opus-4-6"),
  ];
  return {
    version: 1,
    runId: "run-launch-matrix",
    requestHash: `hash-${Math.random().toString(36).slice(2)}`,
    mode: "launch",
    teamName: "atlas-hq",
    cwd: process.cwd(),
    bootstrapTimeoutMs: 5_000,
    continueOnPartialFailure: true,
    permissionSeedTools: [],
    emitStructuredEvents: true,
    policy: {
      persistentTeam: true,
      registerForSessionCleanup: false,
      writeConversationSummaryMessage: false,
    },
    initiator: {
      kind: "app",
      source: "claude_team_agent_teams_orchestrator",
    },
    ...overrides,
    members,
  };
}

function member(
  name: string,
  provider: "anthropic" | "codex" | "gemini",
  model: string,
): TeamBootstrapRequest["members"][number] {
  return {
    originalName: name,
    displayName: name,
    normalizedName: name,
    prompt: `${name} bootstrap`,
    provider,
    model,
  };
}

function attachedContext(teamName: string) {
  let state = {
    teamContext: {
      teamName,
      teamFilePath: "/tmp/atlas-hq/config.json",
      leadAgentId: "team-lead@atlas-hq",
      teammates: {},
    },
  };
  return {
    getAppState: () => state,
    setAppState: (updater: (previous: typeof state) => typeof state) => {
      state = updater(state);
    },
  } as never;
}

function detachedContext() {
  let state = {
    teamContext: undefined,
  };
  return {
    getAppState: () => state,
    setAppState: (updater: (previous: typeof state) => typeof state) => {
      state = updater(state);
    },
  } as never;
}

function createProgressEventSink() {
  const items: Array<Record<string, unknown>> = [];
  const completedEvents: Array<{
    status: string;
    expectedMembers?: string[];
    registeredMembers?: string[];
    failedMembers?: Array<{ name: string; reason: string }>;
  }> = [];
  return {
    items,
    completedEvents,
    emit: {
      started: async (members: string[]) => {
        items.push({ type: "started", members });
      },
      phaseChanged: async (phase: string) => {
        items.push({ type: "phase", phase });
      },
      teamCreated: async (reusedExistingTeam: boolean) => {
        items.push({ type: "team_created", reusedExistingTeam });
      },
      memberSpawnStarted: async (memberName: string) => {
        items.push({ type: "member_spawn_started", memberName });
      },
      memberSpawnResult: async (event: Record<string, unknown>) => {
        items.push({ type: "member_spawn_result", ...event });
      },
      completed: async (event: {
        status: string;
        expectedMembers?: string[];
        registeredMembers?: string[];
        failedMembers?: Array<{ name: string; reason: string }>;
      }) => {
        items.push({ type: "completed", status: event.status });
        completedEvents.push(event);
      },
      failed: async (reason: string) => {
        items.push({ type: "failed", reason });
      },
    },
  };
}

function toEventLabel(item: Record<string, unknown>): string {
  switch (item.type) {
    case "started":
      return `started:${(item.members as string[]).join(",")}`;
    case "phase":
      return `phase:${String(item.phase)}`;
    case "team_created":
      return `team_created:${item.reusedExistingTeam ? "reused" : "created"}`;
    case "member_spawn_started":
      return `member_spawn_started:${String(item.memberName)}`;
    case "member_spawn_result":
      return `member_spawn_result:${String(item.memberName)}:${String(item.outcome)}`;
    case "completed":
      return `completed:${String(item.status)}`;
    case "failed":
      return `failed:${String(item.reason)}`;
    default:
      return String(item.type);
  }
}
