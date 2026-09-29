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
import { OpencodeRuntimeAdapter } from "../../src/engine/agent/adapters/opencode.js";
import { parseArgs, resolveResume } from "../../src/cli.js";
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

/**
 * An error shaped like the one the SDK's `throwOnError` wrapper produces
 * (`wrapClientError`): the HTTP status travels under `cause.status`, not in the
 * message. REV-4C-003 relies on exactly that to tell "gone" from "probe failed".
 */
function missingSessionError(id: string): Error {
  return new Error(`GET /session/${id} → 404 Not Found`, {
    cause: { body: { name: "NotFound" }, status: 404 },
  });
}

/**
 * Phase 4C client stub: answers `session.get` only for the ids in `known` (so a
 * reattach can be made to succeed or fail), records every session the engine
 * *created*, every id a prompt was sent to, and every prompt **body** —
 * REV-4C-001 is about what the reattached session is (not) sent.
 *
 * `lookupError` overrides how an unknown id fails, which is how a *failed* probe
 * (server not answering) is told apart from a session that is really gone.
 */
function dialClient(opts: {
  known?: string[];
  newSessionId?: string;
  reply?: string;
  lookupError?: Error;
}): { client: OpencodeClient; created: string[]; prompts: string[]; bodies: string[] } {
  const known = new Set(opts.known ?? []);
  const created: string[] = [];
  const prompts: string[] = [];
  const bodies: string[] = [];
  const client = {
    session: {
      create: async () => {
        const id = opts.newSessionId ?? "ses_new";
        created.push(id);
        return { id };
      },
      get: async (o: { path: { id: string } }) => {
        if (!known.has(o.path.id)) throw opts.lookupError ?? missingSessionError(o.path.id);
        return { id: o.path.id };
      },
      abort: async () => {},
      prompt: async (o: {
        path: { id: string };
        body?: { parts?: Array<{ type?: string; text?: string }> };
      }) => {
        prompts.push(o.path.id);
        bodies.push(o.body?.parts?.[0]?.text ?? "");
        return { info: { id: "msg", error: undefined }, parts: [{ type: "text", text: opts.reply ?? "ok" }] };
      },
      command: async () => ({ info: { id: "msg", error: undefined }, parts: [{ type: "text", text: "" }] }),
    },
  } as unknown as OpencodeClient;
  return { client, created, prompts, bodies };
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

/**
 * Phase 4C — what happens to a *resumed* session's **runtime-side** session.
 *
 * A history-less runtime (`claude`, `codex`, …) needs nothing: 4A replays the
 * transcript on the next prompt, and that is already covered above. opencode
 * does: 4B persisted its server-side session id, and 4C has to decide whether
 * that conversation can be picked up where it was left (`probeSession`) or
 * whether a brand-new server session has to be opened — never silently.
 *
 * The two branches also differ in what the next prompt carries (REV-4C-001): a
 * *reattached* session already holds the conversation, so only the architect
 * prompt is seeded, while the *fallback* opens an empty session that still needs
 * the 4A replay. Both are asserted on the prompt bodies the client stub records.
 */
describe("LiveEngine opencode reattach on resume (Phase 4C)", () => {
  /** A stored session of `dir` whose server-side id is `serverId`. */
  async function seedWithServerSession(serverId: string): Promise<string> {
    const first = new LiveEngine({
      cfg: makeCfg(),
      runtime: stubRuntime("first reply", { sessionId: serverId }),
    });
    await first.chat("first turn");
    expect(latestLiveSession(dir)!.opencodeSessionId).toBe(serverId);
    return first.getSessionId();
  }

  it("reattaches to the stored opencode session instead of creating a new one", async () => {
    const liveId = await seedWithServerSession("ses_stored");
    const dial = dialClient({ known: ["ses_stored"] });
    const resumed = new LiveEngine({
      cfg: makeCfg(),
      runtime: new OpencodeRuntimeAdapter({ client: dial.client }),
      resume: { id: liveId },
    });

    await resumed.start();

    // no server-side session was created, and the stored one is what is talked to
    expect(dial.created).toEqual([]);
    expect(resumed.getOpencodeSessionId()).toBe("ses_stored");
    expect(resumed.getTranscript()).toHaveLength(2);

    await resumed.chat("second turn");
    expect(dial.prompts).toEqual(["ses_stored"]);
    // the reattached engine keeps writing the same session, and the same record
    expect(latestLiveSession(dir)!.id).toBe(liveId);
    expect(latestLiveSession(dir)!.opencodeSessionId).toBe("ses_stored");
  });

  it("does not replay the transcript into the first prompt of a reattached session (REV-4C-001)", async () => {
    const liveId = await seedWithServerSession("ses_stored");
    const dial = dialClient({ known: ["ses_stored"] });
    const resumed = new LiveEngine({
      cfg: makeCfg(),
      runtime: new OpencodeRuntimeAdapter({ client: dial.client }),
      resume: { id: liveId },
    });

    await resumed.start();
    await resumed.chat("second turn");

    const first = dial.bodies[0];
    // The architect prompt is still seeded — a stored session can be older than
    // the docs it embeds, and those changes have to reach the model…
    expect(first).toContain("You are the thinker/architect");
    // …but the conversation is **not** replayed on top of a session that already
    // holds it: the model would read every turn twice.
    expect(first).not.toContain("CONVERSATION SO FAR");
    expect(first).not.toContain("UNTRUSTED TRANSCRIPT");
    expect(first).not.toContain("USER: first turn");
    expect(first.endsWith("second turn")).toBe(true);
    // and the turn is the only place the new text appears
    expect(first.split("second turn").length - 1).toBe(1);
  });

  it("replays the conversation again once a switch opens an empty session (REV-4C-001)", async () => {
    const liveId = await seedWithServerSession("ses_stored");
    const dial = dialClient({ known: ["ses_stored"], reply: "after switch" });
    const resumed = new LiveEngine({
      cfg: makeCfg(),
      runtime: new OpencodeRuntimeAdapter({ client: dial.client }),
      resume: { id: liveId },
    });

    await resumed.start();
    await resumed.chat("second turn");
    expect(dial.bodies[0]).not.toContain("CONVERSATION SO FAR");

    // The switch replaces the reattached session with a brand-new, empty one, so
    // the suppression no longer applies — the transcript is what carries the
    // conversation over (4A/REV-008).
    await resumed.switchRuntime("opencode");
    await resumed.chat("third turn");

    expect(dial.created).toEqual(["ses_new"]);
    const afterSwitch = dial.bodies[1];
    expect(afterSwitch).toContain("You are the thinker/architect");
    expect(afterSwitch).toContain("CONVERSATION SO FAR");
    expect(afterSwitch).toContain("USER: first turn");
    expect(afterSwitch.endsWith("third turn")).toBe(true);
  });

  it("opens a new opencode session — loudly — when the stored one is gone", async () => {
    const liveId = await seedWithServerSession("ses_gone");
    const dial = dialClient({ known: [], newSessionId: "ses_replacement", reply: "second reply" });
    const { messages, off } = warnings();
    try {
      const resumed = new LiveEngine({
        cfg: makeCfg(),
        runtime: new OpencodeRuntimeAdapter({ client: dial.client }),
        resume: { id: liveId },
      });

      await resumed.start();

      // the stale handle is reported, not swallowed...
      expect(messages.some((m) => m.includes("ses_gone") && m.includes("no longer exists"))).toBe(true);
      // ...and the turn goes to the replacement session
      expect(dial.created).toEqual(["ses_replacement"]);
      await resumed.chat("second turn");
      expect(dial.prompts).toEqual(["ses_replacement"]);
      // the persisted record now points at the session that exists
      expect(resumed.getOpencodeSessionId()).toBe("ses_replacement");
      expect(latestLiveSession(dir)!.opencodeSessionId).toBe("ses_replacement");
      // the resumed conversation is still there, so nothing was lost by the fallback
      expect(resumed.getTranscript().map((m) => m.text)).toContain("first turn");
      // …and it is replayed *into* the replacement session, which starts empty:
      // the 4A behavior is what survives on the fallback branch (REV-4C-001).
      expect(dial.bodies[0]).toContain("You are the thinker/architect");
      expect(dial.bodies[0]).toContain("CONVERSATION SO FAR");
      expect(dial.bodies[0]).toContain("USER: first turn");
    } finally {
      off();
    }
  });

  it("reports a failed lookup as a failed lookup, not as a dead session (REV-4C-003)", async () => {
    const liveId = await seedWithServerSession("ses_stored");
    // The server does not answer the probe at all — no 404, no status: that is not
    // the same fact as "the session no longer exists", and must not be reported as it.
    const dial = dialClient({
      known: [],
      newSessionId: "ses_replacement",
      lookupError: new Error("opencode server GET /session/ses_stored → network error (no response)"),
    });
    const { messages, off } = warnings();
    try {
      const resumed = new LiveEngine({
        cfg: makeCfg(),
        runtime: new OpencodeRuntimeAdapter({ client: dial.client }),
        resume: { id: liveId },
      });

      await resumed.start();

      expect(messages.some((m) => m.includes("could not confirm") && m.includes("ses_stored"))).toBe(true);
      expect(messages.some((m) => m.includes("no longer exists"))).toBe(false);
      // the fail-open path is unchanged: a session that was never confirmed is
      // never adopted, so a new one is opened
      expect(dial.created).toEqual(["ses_replacement"]);
      await resumed.chat("second turn");
      expect(dial.prompts).toEqual(["ses_replacement"]);
    } finally {
      off();
    }
  });

  it("never looks up a stored id for a runtime that does not keep history", async () => {
    const liveId = await seedWithServerSession("ses_stored");
    // Even with a stored server-side id and a client to ask, a stateless runtime
    // gets the 4A transcript treatment: its session is created fresh, per turn.
    const dial = dialClient({ known: ["ses_stored"] });
    const stateless = stubRuntime("stateless reply", {
      id: "claude",
      sessionHistory: false,
      sessionId: "one-shot-1",
    });
    const engine = new LiveEngine({
      cfg: makeCfg(),
      runtime: stateless,
      client: dial.client,
      resume: { id: liveId },
    });

    await engine.start();
    await engine.chat("second turn");

    // no reattach probe, no opencode session created, no prompt over the client
    expect(dial.created).toEqual([]);
    expect(dial.prompts).toEqual([]);
    expect(engine.getOpencodeSessionId()).toBeUndefined();
    // …and the now-meaningless id is dropped from the record (REV-4B-001)
    expect(latestLiveSession(dir)!.opencodeSessionId).toBeUndefined();
  });

  it("stays inert for a brand-new session: no flags means no reattach", async () => {
    const dial = dialClient({ known: ["ses_stored"] });
    const engine = new LiveEngine({
      cfg: makeCfg(),
      runtime: new OpencodeRuntimeAdapter({ client: dial.client }),
    });

    await engine.start();

    // a fresh session is created — nothing stored may be adopted by accident
    expect(dial.created).toEqual(["ses_new"]);
    await engine.chat("hello");
    expect(dial.prompts).toEqual(["ses_new"]);
  });

  it("fails open on a CLI handle that no longer exists, and never echoes it raw", async () => {
    await seedWithServerSession("ses_stored");
    const dial = dialClient({ known: ["ses_stored"], newSessionId: "ses_after_missing" });
    const { messages, off } = warnings();
    try {
      // what `runLive` passes to the engine for `--session <id>`
      const resume = resolveResume(parseArgs(["live", "--session", "hand-edited-miss"]), dir);
      expect(resume).toEqual({ id: "hand-edited-miss" });

      const engine = new LiveEngine({
        cfg: makeCfg(),
        runtime: new OpencodeRuntimeAdapter({ client: dial.client }),
        ...(resume ? { resume } : {}),
      });

      expect(engine.getLiveSessionId()).not.toBe("hand-edited-miss");
      expect(engine.getTranscript()).toEqual([]);
      expect(messages.some((m) => m.includes("hand-edited-miss") && m.includes("not found"))).toBe(true);

      // a new server session, not the stored one (the handle identified nothing)
      await engine.start();
      expect(dial.created).toEqual(["ses_after_missing"]);
      expect(dial.prompts).toEqual([]);
    } finally {
      off();
    }
  });

  it("sanitizes a hand-edited server-side id before the lookup and the log (SEC-4B-003b)", async () => {
    const liveId = await seedWithServerSession("ses_stored");
    // `saveLiveSession` writes the field as it is handed over, so the raw escape
    // really does land in the file; the *read* path is what cleans it (SEC-4C-001),
    // and the reattach sanitizes again before the id is used or logged.
    saveLiveSession(dir, {
      ...latestLiveSession(dir)!,
      id: liveId,
      opencodeSessionId: "ses\u001b]0;pwned\u0007",
    });

    const dial = dialClient({ known: [] });
    const { messages, off } = warnings();
    try {
      // the store is the first line of defense: nothing raw is handed out
      expect(loadLiveSessions(dir)[0]?.opencodeSessionId).toBe("ses]0;pwned");

      const resumed = new LiveEngine({
        cfg: makeCfg(),
        runtime: new OpencodeRuntimeAdapter({ client: dial.client }),
        resume: { id: liveId },
      });

      await resumed.start();

      expect(messages.some((m) => m.includes("no longer exists"))).toBe(true);
      for (const message of messages) {
        expect(message).not.toContain("\u001b");
        expect(message).not.toContain("\u0007");
      }
    } finally {
      off();
    }
  });
});
