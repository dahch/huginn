/**
 * Phase 4B — the live engine persists its session so the context survives a
 * restart and the handoff to the cycle does not wipe it.
 *
 * The store's own contract is covered in `test/state/liveSession.test.ts`; here
 * it is the *wiring*: when a turn is written, what is written, that a restart
 * reads it back, that a default run starts fresh (resume is explicit), and that
 * `execute()`/`resetHarnessState` only clears `.harness`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { LiveEngine } from "../../src/engine/liveMode";
import { events } from "../../src/engine/engineEvents";
import { git } from "../../src/engine/diff";
import { repoContext, resetHarnessState } from "../../src/engine/liveRepo";
import {
  latestLiveSession,
  liveDir,
  liveSessionsPath,
  loadLiveSessions,
  saveLiveSession,
} from "../../src/state/liveSession";
import { sanitizeTerminalText } from "../../src/util/text";
import type { RunConfig } from "../../src/config";
import type { IAgentRuntime, IAgentSession } from "../../src/engine/agent/types";
import type { AgentTarget } from "../../src/agents/integrator";
import type { DecisionChoice } from "../../src/engine/types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huginn-live-persist-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Huginn Test"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCfg(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    projectPath: dir,
    planPath: join(dir, "plan.md"),
    specPath: join(dir, "spec.md"),
    adrPath: join(dir, "adr.md"),
    thinker: "opencode-go/deepseek-v4-pro",
    executor: "opencode-go/deepseek-v4-flash",
    mode: "auto",
    permissions: "auto",
    maxRetries: 3,
    tui: false,
    port: 0,
    serverTimeoutMs: 1000,
    phaseTimeoutMs: 0,
    ignorePlanChanges: false,
    sandbox: false,
    ...overrides,
  };
}

/** Minimal runtime stub: one session id, one canned reply per prompt. */
function stubRuntime(
  reply: string,
  opts: { sessionHistory?: boolean; sessionId?: string; id?: AgentTarget } = {},
): IAgentRuntime {
  const session: IAgentSession = {
    id: opts.sessionId ?? "ses_stub_1",
    prompt: async () => ({ messageId: "msg_1", text: reply }),
    abort: async () => {},
  };
  return {
    id: opts.id ?? "opencode",
    name: "Stub",
    ...(opts.sessionHistory === undefined ? { sessionHistory: true } : { sessionHistory: opts.sessionHistory }),
    isAvailable: async () => true,
    getAvailableModels: async () => [],
    getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
    createSession: async () => session,
  } as unknown as IAgentRuntime;
}

/** Client stub routing a live prompt to a canned reply (opencode transport). */
function makeClient(
  reply: (body: { parts: Array<{ type?: string; text?: string }> }) => string,
  sessionId = "ses_live",
): OpencodeClient {
  return {
    session: {
      create: async () => ({ id: sessionId }),
      get: async () => ({}),
      abort: async () => {},
      prompt: async (o: { body: { parts: Array<{ type?: string; text?: string }> } }) => ({
        info: { id: "msg", error: undefined },
        parts: [{ type: "text", text: reply(o.body) }],
      }),
      command: async () => ({ info: { id: "msg", error: undefined }, parts: [{ type: "text", text: "" }] }),
    },
  } as unknown as OpencodeClient;
}

function autoResolve(engine: LiveEngine, choice: DecisionChoice): () => void {
  return events.on("decision", () => {
    setTimeout(() => engine.resolveDecision(choice), 0);
  });
}

function warnings(): { messages: string[]; off: () => void } {
  const messages: string[] = [];
  const off = events.on("log", (entry) => {
    if (entry.level === "warn") messages.push(entry.message);
  });
  return { messages, off };
}

describe("LiveEngine live-session persistence (Phase 4B)", () => {
  it("persists each turn of chat() to .huginn/live/sessions.json", async () => {
    const engine = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("sure — which channel?") });

    await engine.chat("add notifications");

    const path = liveSessionsPath(dir);
    expect(existsSync(path)).toBe(true);
    const stored = latestLiveSession(dir)!;
    expect(stored.id).toBe(engine.getSessionId());
    expect(stored.messages).toEqual([
      { role: "user", text: "add notifications" },
      { role: "assistant", text: "sure — which channel?" },
    ]);
    expect(stored.runtimeId).toBe("opencode");
    expect(stored.projectPath).toBe(dir);
    expect(stored.title).toBe("add notifications");
    // the file is a JSON envelope, not a bare array
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  it("persists the runtime session id for a runtime that keeps history", async () => {
    const engine = new LiveEngine({
      cfg: makeCfg(),
      runtime: stubRuntime("ok", { sessionHistory: true, sessionId: "ses_resumable" }),
    });

    await engine.chat("hello");

    expect(engine.getOpencodeSessionId()).toBe("ses_resumable");
    expect(latestLiveSession(dir)!.opencodeSessionId).toBe("ses_resumable");
  });

  it("does not persist a meaningless session id for a stateless runtime", async () => {
    const engine = new LiveEngine({
      cfg: makeCfg(),
      runtime: stubRuntime("ok", { sessionHistory: false, sessionId: "one-shot-42" }),
    });

    await engine.chat("hello");

    expect(engine.getOpencodeSessionId()).toBeUndefined();
    expect(latestLiveSession(dir)!.opencodeSessionId).toBeUndefined();
    // the turn itself is still persisted
    expect(latestLiveSession(dir)!.messages).toHaveLength(2);
  });

  it("records the runtime the session is talking to, and follows a switch", async () => {
    const stateless = stubRuntime("answer before", {
      id: "claude",
      sessionHistory: false,
      sessionId: "one-shot-1",
    });
    const opencode = stubRuntime("answer after", {
      id: "opencode",
      sessionHistory: true,
      sessionId: "ses_after_switch",
    });
    const engine = new LiveEngine({ cfg: makeCfg(), runtime: stateless, runtimeFactory: () => opencode });

    await engine.chat("hello claude");
    expect(latestLiveSession(dir)!.runtimeId).toBe("claude");

    await engine.switchRuntime("opencode");

    // the switch is persisted, and the transcript survives it
    const afterSwitch = latestLiveSession(dir)!;
    expect(afterSwitch.runtimeId).toBe("opencode");
    expect(afterSwitch.messages.map((m) => m.text)).toEqual(["hello claude", "answer before"]);

    await engine.chat("hello opencode");
    expect(latestLiveSession(dir)!.opencodeSessionId).toBe("ses_after_switch");
  });

  it("keeps the persisted transcript readable after the engine is dropped", async () => {
    const first = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("keep me") });
    await first.chat("remember this");
    const firstId = first.getSessionId();

    // "restart": nothing from the previous engine is in memory any more
    const reopened = loadLiveSessions(dir);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].id).toBe(firstId);
    expect(reopened[0].messages.map((m) => m.text)).toEqual(["remember this", "keep me"]);
  });

  it("starts a new session by default — a restart does not auto-resume", async () => {
    const first = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("first reply") });
    await first.chat("first turn");

    const second = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("second reply") });
    expect(second.getSessionId()).not.toBe(first.getSessionId());
    expect(second.getTranscript()).toEqual([]);

    await second.chat("second turn");

    // both sessions are on disk; the newest is the fresh one
    const sessions = loadLiveSessions(dir);
    expect(sessions).toHaveLength(2);
    expect(latestLiveSession(dir)!.id).toBe(second.getSessionId());
    expect(latestLiveSession(dir)!.messages.map((m) => m.text)).toEqual(["second turn", "second reply"]);
  });

  it("exposes the transcript and both session ids for the UI/flags", async () => {
    const engine = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("reply") });
    await engine.chat("question");

    expect(engine.getTranscript()).toEqual([
      { role: "user", text: "question" },
      { role: "assistant", text: "reply" },
    ]);
    expect(engine.getLiveSessionId()).toBe(engine.getSessionId());

    // the returned transcript is a copy: mutating it must not touch the engine
    engine.getTranscript().push({ role: "assistant", text: "injected" });
    engine.getTranscript()[0].text = "mutated";
    expect(engine.getTranscript()[0].text).toBe("question");
    expect(engine.getTranscript()).toHaveLength(2);
  });

  it("resumeSession adopts the stored conversation and keeps writing to that session (4C hook)", async () => {
    const first = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("first reply") });
    await first.chat("first turn");
    const id = first.getSessionId();

    const reopened = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("second reply") });
    expect(reopened.resumeSession(id)).toBe(true);
    expect(reopened.getLiveSessionId()).toBe(id);
    expect(reopened.getTranscript()).toEqual(first.getTranscript());
    expect(reopened.getOpencodeSessionId()).toBe("ses_stub_1");

    await reopened.chat("second turn");

    const sessions = loadLiveSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(id);
    expect(sessions[0].messages.map((m) => m.text)).toEqual([
      "first turn",
      "first reply",
      "second turn",
      "second reply",
    ]);
  });

  it("accepts the resume hook through the constructor", async () => {
    const first = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("first reply") });
    await first.chat("first turn");

    const resumed = new LiveEngine({
      cfg: makeCfg(),
      runtime: stubRuntime("second reply"),
      resume: { id: first.getSessionId() },
    });

    expect(resumed.getLiveSessionId()).toBe(first.getSessionId());
    expect(resumed.getTranscript()).toHaveLength(2);
  });

  it("fails open on an unknown resume id: new session, warning, no crash", async () => {
    const { messages, off } = warnings();
    try {
      const engine = new LiveEngine({
        cfg: makeCfg(),
        runtime: stubRuntime("ok"),
        resume: { id: "does-not-exist" },
      });

      expect(engine.getTranscript()).toEqual([]);
      expect(engine.getLiveSessionId()).not.toBe("does-not-exist");
      expect(messages.some((m) => m.includes("does-not-exist") && m.includes("not found"))).toBe(true);
    } finally {
      off();
    }
  });

  it("never echoes a raw session id into the log (SEC-4B-003b)", () => {
    // A hand-edited (or attacker-authored) store whose id carries an OSC sequence
    // and a bell: neither the handle we are given nor the id we hand back may put
    // those on the log.
    const hostileId = "hijack\u001b]0;pwned\u0007";
    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(
      liveSessionsPath(dir),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: hostileId,
            runtimeId: "opencode\u001b[31m",
            messages: [{ role: "user", text: "hi" }],
          },
        ],
      }),
    );

    const { messages, off } = warnings();
    try {
      // the store hands out the sanitized id, and that is the handle that resumes
      const clean = sanitizeTerminalText(hostileId);
      expect(clean).toBe("hijack]0;pwned");
      const resumed = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("ok"), resume: { id: clean } });
      expect(resumed.getLiveSessionId()).toBe(clean);
      expect(resumed.getTranscript()).toEqual([{ role: "user", text: "hi" }]);

      // an escape-carrying handle matches nothing, is never adopted, and is
      // reported sanitized
      const rejected = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("ok"), resume: { id: hostileId } });
      expect(rejected.getLiveSessionId()).not.toBe(hostileId);
      expect(messages.some((m) => m.includes("not found"))).toBe(true);

      for (const message of messages) {
        expect(message).not.toContain("\u001b");
        expect(message).not.toContain("\u0007");
      }
    } finally {
      off();
    }
  });

  it("drops a stale runtime session id when the switch lands on a stateless runtime (REV-4B-001)", async () => {
    const opencode = stubRuntime("answer before", {
      id: "opencode",
      sessionHistory: true,
      sessionId: "ses_now_stale",
    });
    const stateless = stubRuntime("answer after", {
      id: "claude",
      sessionHistory: false,
      sessionId: "one-shot-9",
    });
    const engine = new LiveEngine({ cfg: makeCfg(), runtime: opencode, runtimeFactory: () => stateless });

    await engine.chat("hello opencode");
    expect(latestLiveSession(dir)!.opencodeSessionId).toBe("ses_now_stale");

    await engine.switchRuntime("claude");

    // the id belonged to a server-side session the new runtime knows nothing
    // about: keeping it would let 4C reattach to the wrong conversation
    expect(engine.getOpencodeSessionId()).toBeUndefined();
    expect(latestLiveSession(dir)!.opencodeSessionId).toBeUndefined();
    expect(JSON.parse(readFileSync(liveSessionsPath(dir), "utf8")).sessions[0]).not.toHaveProperty(
      "opencodeSessionId",
    );
  });

  it("persists the stage and restores it when the session is resumed (REV-4B-002)", async () => {
    const engine = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("ok") });
    await engine.chat("hi");
    expect(engine.currentStage).toBe("refine");
    expect(latestLiveSession(dir)!.stage).toBe("refine");

    // a session that stopped at the approval gate
    const stored = latestLiveSession(dir)!;
    saveLiveSession(dir, { ...stored, stage: "approve" });

    const resumed = new LiveEngine({
      cfg: makeCfg(),
      runtime: stubRuntime("ok"),
      resume: { id: stored.id },
    });
    expect(resumed.currentStage).toBe("approve");

    // and the resumed engine keeps writing that stage back
    await resumed.chat("continue");
    expect(latestLiveSession(dir)!.stage).toBe("approve");
  });

  it("keeps .huginn out of git status, whatever the project's .gitignore says (REV-4B-003)", async () => {
    const engine = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("reply") });

    await engine.chat("persist me");

    expect(existsSync(liveSessionsPath(dir))).toBe(true);
    const status = git(dir, ["status", "--short"]).stdout;
    expect(status).not.toContain(".huginn");
    // the git-derived prompt context must not see the store either
    expect(repoContext(dir)).toContain("(clean working tree)");
  });

  it("leaves an existing .huginn/.gitignore alone (REV-4B-003)", async () => {
    // A user who already curated `.huginn/.gitignore` keeps their file: huginn
    // only ever creates it, never rewrites it.
    mkdirSync(join(dir, ".huginn"), { recursive: true });
    const curated = "*\n# curated by hand\n!.keep\n";
    writeFileSync(join(dir, ".huginn", ".gitignore"), curated);

    const engine = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("reply") });
    await engine.chat("persist me");

    expect(readFileSync(join(dir, ".huginn", ".gitignore"), "utf8")).toBe(curated);
    expect(git(dir, ["status", "--short"]).stdout).not.toContain(".huginn");
  });

  it("degrades with a warning, and keeps answering, when .huginn/live is a symlink (SEC-4B-001)", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "huginn-live-engine-victim-"));
    const { messages, off } = warnings();
    try {
      const secrets = join(root, "secrets");
      mkdirSync(secrets, { mode: 0o755 });
      chmodSync(secrets, 0o755);
      mkdirSync(join(dir, ".huginn"), { mode: 0o700 });
      symlinkSync(secrets, join(dir, ".huginn", "live"));

      const engine = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("still answering") });
      const reply = await engine.chat("does this still work?");
      expect(reply).toBe("still answering");
      expect(engine.getTranscript()).toHaveLength(2);

      // the foreign directory was neither written to nor chmodded
      expect(existsSync(join(secrets, "sessions.json"))).toBe(false);
      if (process.platform !== "win32") expect(statSync(secrets).mode & 0o777).toBe(0o755);
      // and the failure is a warning, not a crash
      expect(messages.some((m) => m.includes("could not persist live session"))).toBe(true);
      expect(messages.some((m) => m.includes("refusing to persist live sessions"))).toBe(true);
    } finally {
      off();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps .huginn out of the prompt's source tree (REV-4B-003)", () => {
    // No `.huginn/.gitignore` here, so the store *is* visible to git...
    mkdirSync(join(dir, ".huginn", "live"), { recursive: true });
    writeFileSync(join(dir, ".huginn", "live", "sessions.json"), "{}");
    expect(git(dir, ["status", "--short"]).stdout).toContain(".huginn");

    // ...yet the source tree embedded in every prompt filters it out.
    const sourceTree = repoContext(dir).split("Source tree:\n")[1] ?? "";
    expect(sourceTree).not.toContain(".huginn");
    expect(sourceTree).toContain("(no source files yet)");
  });

  it("never lets a failed persist break the turn — it warns instead", async () => {
    // a regular file where the live *directory* must be: mkdir fails deterministically
    mkdirSync(join(dir, ".huginn"), { recursive: true });
    writeFileSync(join(dir, ".huginn", "live"), "not a directory");

    const { messages, off } = warnings();
    try {
      const engine = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("still answering") });
      const reply = await engine.chat("does this still work?");

      expect(reply).toBe("still answering");
      expect(engine.getTranscript()).toHaveLength(2);
      expect(messages.some((m) => m.includes("could not persist live session"))).toBe(true);
    } finally {
      off();
    }
  });

  it("resetHarnessState clears .harness and leaves the live store untouched", async () => {
    const engine = new LiveEngine({ cfg: makeCfg(), runtime: stubRuntime("kept") });
    await engine.chat("survive the reset");
    mkdirSync(join(dir, ".harness"), { recursive: true });
    writeFileSync(join(dir, ".harness", "state.json"), "{}");

    resetHarnessState(dir);

    expect(existsSync(join(dir, ".harness"))).toBe(false);
    expect(existsSync(liveSessionsPath(dir))).toBe(true);
    expect(latestLiveSession(dir)!.messages.map((m) => m.text)).toEqual(["survive the reset", "kept"]);
  });

  it("execute() clears .harness but keeps the live session", async () => {
    const SCOPE_REPLY = "SCOPE:\n```markdown\nAdd a notifications module\n```";
    const SPEC_REPLY = "# Spec: notifications\n\nREQ-1: notify users\n";
    const ADR_REPLY = "NONE";
    const PLAN_REPLY = "# Plan: notifications\n\n## Iteration 1 — Add notifications\n\nAdd it per REQ-1.\n";
    const client = makeClient((body) => {
      const t = (body.parts ?? []).map((p) => p.text ?? "").join("\n");
      if (t.includes("fenced block")) return SCOPE_REPLY;
      if (t.includes("REFINED SCOPE / IDEA")) return SPEC_REPLY;
      if (t.includes("APPEND to the project's existing adr.md")) return ADR_REPLY;
      if (t.includes("REMAINING work of an EXISTING project")) return PLAN_REPLY;
      return "Tell me more.";
    });

    const engine = new LiveEngine({ cfg: makeCfg(), client, idea: "add notifications" });
    const offs = [autoResolve(engine, "continue")];
    try {
      await engine.chat("add notifications");
      expect(await engine.draft()).toBe("approved");

      // stand in for a previous cycle's harness state
      mkdirSync(join(dir, ".harness", "reports"), { recursive: true });
      writeFileSync(join(dir, ".harness", "state.json"), "{}");
      const liveBefore = JSON.parse(readFileSync(liveSessionsPath(dir), "utf8")).sessions[0];

      await engine.execute();

      // the handoff resets the harness...
      expect(existsSync(join(dir, ".harness"))).toBe(false);
      // ...and must not touch the live session
      expect(existsSync(liveSessionsPath(dir))).toBe(true);
      const stored = latestLiveSession(dir)!;
      expect(stored.id).toBe(engine.getSessionId());
      expect(stored.messages.map((m) => m.role)).toContain("user");
      expect(stored.messages.map((m) => m.text)).toContain("add notifications");
      const after = JSON.parse(readFileSync(liveSessionsPath(dir), "utf8")).sessions;
      expect(after).toHaveLength(1);
      // the checkpoint after the reset happened, without dropping the transcript
      expect(after[0].updatedAt >= liveBefore.updatedAt).toBe(true);
      expect(after[0].messages).toHaveLength(liveBefore.messages.length);
      // the opencode session id was checkpointed, so 4C can reattach
      expect(stored.opencodeSessionId).toBe("ses_live");
      // ...and so was the stage the session stopped at (REV-4B-002)
      expect(stored.stage).toBe("execute");
    } finally {
      offs.forEach((off) => off());
    }
  });
});
