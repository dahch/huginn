import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { LiveEngine, extractScopeBlock } from "./liveMode";
import { updateSpecPrompt, appendAdrPrompt, remainingPlanPrompt, unwrapFences, validateDraftFormat } from "./planMode";
import { events } from "./engineEvents";
import type { DecisionChoice } from "./types";
import { git } from "./diff";
import { computePlanHash } from "../state/store";
import type { RunConfig } from "../config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huginn-live-"));
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
    ...overrides,
  };
}

function makeClient(promptImpl: (body: { parts: Array<{ type?: string; text?: string }> }) => Promise<unknown>): OpencodeClient {
  return {
    session: {
      create: async () => ({ id: "ses_live" }),
      get: async () => ({}),
      abort: async () => {},
      prompt: async (opts: { body: { parts: Array<{ type?: string; text?: string }> } }) => promptImpl(opts.body),
      command: async () => ({ info: { id: "msg", error: undefined }, parts: [{ type: "text", text: "### Overall gate: 🟢" }] }),
    },
  } as unknown as OpencodeClient;
}

function textPartOf(body: { parts: Array<{ type?: string; text?: string }> }): string {
  return (body.parts ?? []).map((p) => p.text ?? "").join("\n");
}

function autoResolve(engine: LiveEngine, choice: DecisionChoice): () => void {
  const off = events.on("decision", () => {
    setTimeout(() => engine.resolveDecision(choice), 0);
  });
  return off;
}

describe("extractScopeBlock", () => {
  it("extracts the fenced markdown scope", () => {
    const text = [
      "Some preamble.",
      "",
      "SCOPE:",
      "```markdown",
      "Add a notifications module",
      "```",
      "trailing",
    ].join("\n");
    expect(extractScopeBlock(text)).toBe("Add a notifications module");
  });

  it("extracts a bare paragraph scope", () => {
    expect(extractScopeBlock("SCOPE:\nAdd auth for admin routes")).toBe("Add auth for admin routes");
  });

  it("returns null when no SCOPE marker is present", () => {
    expect(extractScopeBlock("Here is my scope: build things")).toBeNull();
  });

  it("returns null when the SCOPE block is empty", () => {
    expect(extractScopeBlock("SCOPE:\n```markdown\n\n```")).toBeNull();
  });
});

describe("update-mode drafting prompts", () => {
  it("updateSpecPrompt embeds the existing spec and repository state", () => {
    const p = updateSpecPrompt("add caching", "# Old spec\n\nREQ-1: hello\n", "git log --oneline -1: aabb");
    expect(p).toContain("REFINED SCOPE / IDEA");
    expect(p).toContain("Old spec");
    expect(p).toContain("REQ-1");
    expect(p).toContain("aabb");
    expect(p).toContain("EXISTING project");
  });

  it("appendAdrPrompt asks for new entries only, preserving the existing adr", () => {
    const p = appendAdrPrompt("# Spec", "## ADR-1: Postgres\n\nDecision: postgres");
    expect(p).toContain("ADR-1");
    expect(p).toContain("Do NOT repeat");
    expect(p).toContain("APPEND");
  });

  it("remainingPlanPrompt produces only remaining iterations grounded in repo state", () => {
    const p = remainingPlanPrompt("# Spec", "## ADR-1: X", "src/app.ts");
    expect(p).toContain("REMAINING");
    expect(p).toContain("Do NOT re-plan");
    expect(p).toContain("src/app.ts");
    expect(p).toContain("starting at 1");
  });

  it("appends the output format contract to every document prompt", () => {
    expect(updateSpecPrompt("x", "# old", "log")).toContain("OUTPUT FORMAT CONTRACT");
    expect(appendAdrPrompt("# spec", "## ADR-1: X")).toContain("OUTPUT FORMAT CONTRACT");
    expect(remainingPlanPrompt("# spec", "# adr", "log")).toContain("OUTPUT FORMAT CONTRACT");
  });

  it("unwrapFences strips a fully-fenced document", () => {
    expect(unwrapFences("```markdown\n# Spec\ncontent\n```")).toBe("# Spec\ncontent\n");
  });
});

describe("validateDraftFormat", () => {
  it("accepts a well-formed spec", () => {
    expect(validateDraftFormat("spec", "# Spec: x\n\nREQ-1: do a thing\nAC-1: works")).toBeNull();
  });

  it("rejects a spec without numbered requirements", () => {
    expect(validateDraftFormat("spec", "# Spec: x\n\nJust prose, no requirements")).toContain("REQ-");
  });

  it("rejects a spec without a title heading", () => {
    expect(validateDraftFormat("spec", "REQ-1: do a thing")).toContain("top-level heading");
  });

  it("accepts well-formed ADR entries", () => {
    expect(validateDraftFormat("adr", "## ADR-2: Publish via queues\n\nContext: async\nDecision: queue\nConsequences: infra")).toBeNull();
  });

  it("accepts NONE and empty ADR drafts", () => {
    expect(validateDraftFormat("adr", "NONE")).toBeNull();
    expect(validateDraftFormat("adr", "  ")).toBeNull();
  });

  it("rejects ADR prose without headings", () => {
    expect(validateDraftFormat("adr", "We should probably use a queue for the notifications")).toContain("ADR-");
  });

  it("rejects an ADR with a non-ADR entry heading", () => {
    expect(validateDraftFormat("adr", "## ADR-2: X\n\nContext: c\n\n## Alternatives\n\nprose")).toContain("non-ADR");
  });

  it("accepts ADR entries with level-3 subheadings (classic template)", () => {
    expect(validateDraftFormat("adr", "## ADR-2: X\n\n### Context\nc\n### Decision\nd\n### Consequences\nx")).toBeNull();
  });

  it("accepts a parseable plan and rejects unparseable ones", () => {
    expect(validateDraftFormat("plan", "# Plan: x\n\n## Iteration 1 — Do\n\nwork\n")).toBeNull();
    expect(validateDraftFormat("plan", "# Plan: x\n\nno iterations here")).toContain("Iteration");
    expect(validateDraftFormat("plan", "just prose")).toContain("# Plan:");
  });
});

describe("LiveEngine flow", () => {
  const SCOPE_REPLY = "SCOPE:\n```markdown\nAdd a notifications module to the existing app\n```";
  const SPEC_REPLY = "# Spec: notifications\n\nREQ-1: notify users\n";
  const ADR_REPLY = "## ADR-2: Publish via queues\n\nContext: notify needs async delivery.\nDecision: use a queue.\nConsequences: adds infra.";
  const PLAN_REPLY = "# Plan: notifications\n\n## Iteration 1 — Add notifications\n\nAdd the notifications feature per REQ-1.\n";

  function routingClient(): OpencodeClient {
    return makeClient(async (body) => {
      const t = textPartOf(body);
      let text: string;
      if (t.includes("fenced block")) text = SCOPE_REPLY;
      else if (t.includes("REFINED SCOPE / IDEA")) text = SPEC_REPLY;
      else if (t.includes("APPEND to the project's existing adr.md")) text = ADR_REPLY;
      else if (t.includes("REMAINING work of an EXISTING project")) text = PLAN_REPLY;
      else text = "Let me clarify a couple of things first.";
      return { info: { id: "msg", error: undefined }, parts: [{ type: "text", text }] };
    });
  }

  it("refines, drafts update-mode docs, approves, and hands off to a fresh CycleEngine", async () => {
    writeFileSync(join(dir, "spec.md"), "# Old spec\n\nREQ-1: existing\n");
    writeFileSync(join(dir, "adr.md"), "## ADR-1: Postgres\n\nDecision: postgres\n");

    const engine = new LiveEngine({ cfg: makeCfg(), client: routingClient(), idea: "add notifications" });
    const offs: Array<() => void> = [
      autoResolve(engine, "continue"),
      events.on("liveChat", () => {}),
    ];

    try {
      await engine.start();
      await engine.chat("add notifications");
      const ok = await engine.draft();
      expect(ok).toBe("approved");
      expect(engine.currentStage).toBe("approve");

      const ce = await engine.execute();
      expect(engine.cycleEngine).toBe(ce);
      expect(engine.currentStage).toBe("execute");

      // spec is a full replacement; adr preserved + appended; plan has remaining iterations
      const spec = (await Bun.file(join(dir, "spec.md")).text()) as string;
      expect(spec).toContain("notifications");
      const adr = (await Bun.file(join(dir, "adr.md")).text()) as string;
      expect(adr).toContain("ADR-1");
      expect(adr).toContain("ADR-2");
      const plan = (await Bun.file(join(dir, "plan.md")).text()) as string;
      expect(plan).toContain("## Iteration 1");

      // docs committed with a docs(scope) message
      const log = git(dir, ["log", "--oneline", "-3"]).stdout;
      expect(log).toContain("docs(scope)");

      // handoff state is fresh with the new plan hash
      expect(ce.getState().currentIteration).toBe(1);
      expect(ce.getState().planHash).toBe(computePlanHash([join(dir, "plan.md"), join(dir, "spec.md"), join(dir, "adr.md")]));
    } finally {
      offs.forEach((off) => off());
    }
  });

  it("falls back to the last user message when scope extraction yields no SCOPE block", async () => {
    const client = makeClient(async (body) => {
      const t = textPartOf(body);
      let text: string;
      if (t.includes("fenced block")) text = "I am not sure how to express this yet.";
      else if (t.includes("REFINED SCOPE / IDEA")) text = SPEC_REPLY;
      else if (t.includes("APPEND to the project's existing adr.md")) text = "NONE";
      else if (t.includes("REMAINING work of an EXISTING project")) text = PLAN_REPLY;
      else text = "ok";
      return { info: { id: "msg", error: undefined }, parts: [{ type: "text", text }] };
    });

    const engine = new LiveEngine({ cfg: makeCfg(), client, idea: "use the last message" });
    const decisions: string[] = [];
    const offs: Array<() => void> = [
      events.on("decision", (req) => {
        decisions.push(req.kind);
        setTimeout(() => engine.resolveDecision("continue"), 0);
      }),
    ];

    try {
      await engine.chat("use the last message");
      const ok = await engine.draft();
      expect(ok).toBe("approved");
      // scope-extraction failed closed → asked, then continued with the last user message
      expect(decisions).toContain("scope-extraction");
      expect(decisions).toContain("approve-draft");
      expect(existsSync(join(dir, "spec.md"))).toBe(true);
      // adr reply was "NONE" → nothing appended, file untouched
      expect(existsSync(join(dir, "adr.md"))).toBe(false);
    } finally {
      offs.forEach((off) => off());
    }
  });

  it("aborts when the approval decision is aborted", async () => {
    const engine = new LiveEngine({ cfg: makeCfg(), client: routingClient(), idea: "x" });
    const offs: Array<() => void> = [
      events.on("decision", (req) => {
        if (req.kind === "approve-draft") setTimeout(() => engine.resolveDecision("abort"), 0);
      }),
    ];
    try {
      await engine.chat("x");
      const ok = await engine.draft();
      expect(ok).toBe("aborted");
      expect(engine.hasAborted).toBe(true);
      // intent-to-add staging dropped: docs no longer appear in the diff
      expect(git(dir, ["diff", "HEAD", "--name-only"]).stdout).not.toContain("spec.md");
    } finally {
      offs.forEach((off) => off());
    }
  });

  it("asks a draft-format decision and accepts as-is when the adr draft is prose", async () => {
    let adrCalls = 0;
    const client = makeClient(async (body) => {
      const t = textPartOf(body);
      let text: string;
      if (t.includes("fenced block")) text = SCOPE_REPLY;
      else if (t.includes("REFINED SCOPE / IDEA")) text = SPEC_REPLY;
      else if (t.includes("APPEND to the project's existing adr.md")) {
        adrCalls++;
        text = "We should probably use a queue for the notifications. Prose is bad here.";
      } else if (t.includes("REMAINING work of an EXISTING project")) text = PLAN_REPLY;
      else text = "ok";
      return { info: { id: "msg", error: undefined }, parts: [{ type: "text", text }] };
    });

    const engine = new LiveEngine({ cfg: makeCfg(), client, idea: "x" });
    const decisions: string[] = [];
    const offs: Array<() => void> = [
      events.on("decision", (req) => {
        decisions.push(req.kind);
        setTimeout(() => engine.resolveDecision(req.kind === "approve-draft" ? "continue" : "continue"), 0);
      }),
    ];
    try {
      await engine.chat("x");
      const ok = await engine.draft();
      expect(ok).toBe("approved");
      expect(adrCalls).toBe(2); // first attempt + contract-reemphasized retry
      expect(decisions).toContain("draft-format");
      // accepted as-is: the prose ended up appended to adr.md
      const adr = (await Bun.file(join(dir, "adr.md")).text()) as string;
      expect(adr).toContain("Prose is bad here.");
    } finally {
      offs.forEach((off) => off());
    }
  });

  it("retries once with the contract and writes a well-formed draft without a decision", async () => {
    let adrCalls = 0;
    const client = makeClient(async (body) => {
      const t = textPartOf(body);
      let text: string;
      if (t.includes("fenced block")) text = SCOPE_REPLY;
      else if (t.includes("REFINED SCOPE / IDEA")) text = SPEC_REPLY;
      else if (t.includes("APPEND to the project's existing adr.md")) {
        adrCalls++;
        text = adrCalls === 1 ? "just prose" : "## ADR-2: Publish via queues\n\nContext: async\nDecision: queue\nConsequences: infra";
      } else if (t.includes("REMAINING work of an EXISTING project")) text = PLAN_REPLY;
      else text = "ok";
      return { info: { id: "msg", error: undefined }, parts: [{ type: "text", text }] };
    });

    const engine = new LiveEngine({ cfg: makeCfg(), client, idea: "x" });
    const decisions: string[] = [];
    const offs: Array<() => void> = [
      events.on("decision", (req) => {
        decisions.push(req.kind);
        setTimeout(() => engine.resolveDecision("continue"), 0);
      }),
    ];
    try {
      await engine.chat("x");
      const ok = await engine.draft();
      expect(ok).toBe("approved");
      expect(adrCalls).toBe(2);
      expect(decisions).not.toContain("draft-format");
      const adr = (await Bun.file(join(dir, "adr.md")).text()) as string;
      expect(adr).toContain("## ADR-2");
      expect(adr).not.toContain("just prose");
    } finally {
      offs.forEach((off) => off());
    }
  });
});