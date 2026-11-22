#!/usr/bin/env bun
/**
 * Record the README demos from the real thing.
 *
 * Every frame of `docs/media/*.gif` comes from the actual `Dashboard` component
 * painting into a captured stream while the actual `CycleEngine` runs a real
 * plan against a real git repository: the sandbox worktree, the verification
 * commands, the deterministic commit and the iteration receipt are huginn's own.
 * The only scripted part is the model turn — a `RuntimePort` fake answers each
 * phase prompt with a canned report and writes the iteration's files, which is
 * exactly the seam the conformance tests use.
 *
 * Output: `docs/media/build/<demo>.jsonl`, one `{ "t", "data" }` record per
 * write with its elapsed milliseconds, which `render_media.py` replays into
 * image frames. Nothing here is committed except the GIFs and this pair of
 * scripts.
 *
 *   bun docs/media/capture.ts            # both demos
 *   bun docs/media/capture.ts lite       # one of them
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import chalk from "chalk";

// The demos are recorded on a dark terminal: that is where the cyan/green/yellow
// palette of `HUGINN_THEME=dark` is legible, and it is what the screenshots show.
process.env.HUGINN_THEME = "dark";
process.env.FORCE_COLOR = "3";
delete process.env.NO_COLOR;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const BUILD = join(HERE, "build");
const WORK = join(ROOT, ".work", "media");
const COLUMNS = 104;
const ROWS = 34;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** One line the agent "says" while a phase runs, and how long it takes to say it. */
interface Beat {
  text: string;
  ms?: number;
}

/** What the scripted agent writes when its turn ends. */
interface Write {
  path: string;
  content: string;
}

interface PhaseScript {
  /** Streamed text, in order; `undefined` means "stream the report itself". */
  beats?: Beat[];
  writes?: Write[];
  report: string;
  usage?: { inputTokens: number; outputTokens: number };
}

interface Demo {
  id: string;
  profile: "lite" | "huginn";
  /** The command line the recording opens with, typed character by character. */
  command: string;
  plan: string;
  spec: string;
  adr: string;
  /** Files the repository already has before iteration 1. */
  base: Write[];
  /** Phase name -> what the scripted agent does for it. */
  phases: Record<string, PhaseScript>;
}

const CART_SOURCE = `export interface CartLine {
  sku: string;
  price: number;
  quantity: number;
}

export function cartTotal(lines: readonly CartLine[]): number {
  const cents = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
  return Math.round(cents * 100) / 100;
}
`;

const CART_TEST = `import { describe, expect, it } from "bun:test";
import { cartTotal, type CartLine } from "../src/cart";

const lines: CartLine[] = [
  { sku: "raven-mug", price: 12.5, quantity: 2 },
  { sku: "poetic-edda", price: 30, quantity: 1 },
];

describe("cartTotal", () => {
  it("adds every line", () => {
    expect(cartTotal(lines)).toBe(55);
  });
});
`;

/** The suite after the iteration: the same file, plus the discount cases. */
const CART_TEST_AFTER = `import { describe, expect, it } from "bun:test";
import { applyDiscount, cartTotal, type CartLine } from "../src/cart";

const lines: CartLine[] = [
  { sku: "raven-mug", price: 12.5, quantity: 2 },
  { sku: "poetic-edda", price: 30, quantity: 1 },
];

describe("cartTotal", () => {
  it("adds every line", () => {
    expect(cartTotal(lines)).toBe(55);
  });
});

describe("applyDiscount", () => {
  it("takes 10% off", () => {
    expect(applyDiscount(55, "SAVE10")).toBe(49.5);
  });

  it("takes 20% off", () => {
    expect(applyDiscount(55, "SAVE20")).toBe(44);
  });

  it("ignores an unknown code", () => {
    expect(applyDiscount(55, "NOSUCH")).toBe(55);
  });
});
`;

/** The iteration the demos build: one small, well-scoped feature. */
const ITERATION = {
  index: 1,
  title: "Apply a discount code",
  prompt: "Support SAVE10 and SAVE20 discount codes on a cart total.",
  modules: ["src"],
  verification: ["bun test"],
};

function planFor(profileLine: string): string {
  return `# Plan: tiny-cart

A small cart library used to record huginn's README demos.

## Iteration 1 — Apply a discount code

**Goal:** a cart total can be reduced by a discount code.

**Changes:**
- \`src/cart.ts\`: add \`applyDiscount(total, code)\` for \`SAVE10\` and \`SAVE20\`.
- \`test/cart.test.ts\`: cover both codes and an unknown code.

**Verification:**

\`\`\`sh
bun test
\`\`\`

${profileLine}
`;
}

const SPEC = `# Spec: tiny-cart

## Requirement 1 — Cart total

\`cartTotal(lines)\` returns the sum of \`price × quantity\`, rounded to cents.

## Requirement 2 — Discount codes

\`applyDiscount(total, code)\` returns the discounted total:

| Code | Discount |
|---|---|
| \`SAVE10\` | 10% |
| \`SAVE20\` | 20% |
| anything else | no change |

A discount never returns a negative total.
`;

const ADR = `# ADR-1 — Discounts are a pure function

**Status:** Accepted

\`applyDiscount\` takes a total and a code and returns a number: no cart mutation, no
rounding state, no I/O. The cart keeps a single source of truth (its lines) and the
discount is applied where the total is read.
`;

const EXECUTE_WRITES: Write[] = [
  {
    path: "src/cart.ts",
    content: `${CART_SOURCE}
const DISCOUNTS: Record<string, number> = { SAVE10: 0.1, SAVE20: 0.2 };

/** Apply a discount code to a total; an unknown code leaves it untouched. */
export function applyDiscount(total: number, code: string): number {
  const rate = DISCOUNTS[code.trim().toUpperCase()] ?? 0;
  return Math.max(0, Math.round(total * (1 - rate) * 100) / 100);
}
`,
  },
  {
    path: "test/cart.test.ts",
    content: CART_TEST_AFTER,
  },
];

const EXECUTE_BEATS: Beat[] = [
  { text: "Reading plan.md and spec.md…\n", ms: 260 },
  { text: "⚡ [tool: read] src/cart.ts\n", ms: 220 },
  { text: "Writing src/cart.ts — applyDiscount(total, code)\n", ms: 340 },
  { text: "Writing test/cart.test.ts — SAVE10, SAVE20, unknown code\n", ms: 300 },
  { text: "⚡ [tool: write] test/cart.test.ts\n", ms: 240 },
];

const LITE: Demo = {
  id: "lite",
  profile: "lite",
  command: "huginn run --profile lite",
  plan: planFor(
    "**Profile:** lite\n**Profile reason:** one small function, already covered by the suite.",
  ),
  spec: SPEC,
  adr: ADR,
  base: [
    { path: "src/cart.ts", content: CART_SOURCE },
    { path: "test/cart.test.ts", content: CART_TEST },
    {
      // A real project with `bun-types` installed would not need this; the demo
      // repo has no `node_modules`, so it ships the two ambient names the suite
      // uses. Without it the contract gate reads `bun:test` as a missing module.
      path: "tsconfig.json",
      content: [
        "{",
        '  "compilerOptions": {',
        '    "target": "ES2022",',
        '    "module": "ESNext",',
        '    "moduleResolution": "Bundler",',
        '    "strict": true,',
        '    "noEmit": true,',
        '    "baseUrl": ".",',
        '    "paths": { "bun:test": ["types/bun-test.d.ts"] }',
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "types/bun-test.d.ts",
      content: [
        'declare module "bun:test" {',
        "  export function describe(name: string, fn: () => void): void;",
        "  export function it(name: string, fn: () => void): void;",
        "  export function expect(value: unknown): { toBe(expected: unknown): void };",
        "}",
        "",
      ].join("\n"),
    },
  ],
  phases: {
    EXECUTE: {
      beats: EXECUTE_BEATS,
      writes: EXECUTE_WRITES,
      report: [
        "# EXECUTE — Iteration 1",
        "",
        "Added `applyDiscount(total, code)` to `src/cart.ts` with the SAVE10/SAVE20",
        "rates from the spec, and three cases in `test/cart.test.ts`.",
      ].join("\n"),
      usage: { inputTokens: 8214, outputTokens: 913 },
    },
  },
};

const HUGINN: Demo = {
  id: "huginn",
  profile: "huginn",
  command: "huginn run",
  plan: planFor("**Profile:** huginn\n**Profile reason:** the full cycle, gates included."),
  spec: SPEC,
  adr: ADR,
  base: LITE.base,
  phases: {
    SPEC_AUDIT: {
      beats: [
        { text: "Auditing spec.md against src/cart.ts…\n", ms: 300 },
        { text: "Omissions 0 · Additions 0 · Substitutions 0\n", ms: 220 },
      ],
      report: [
        "## Spec Audit Report",
        "",
        "### Scope",
        "- Spec: spec.md (Requirements 1–2)",
        "- Implementation: src/cart.ts, test/cart.test.ts",
        "",
        "### Deviation Summary",
        "| Category | Count |",
        "|---|---|",
        "| Omissions | 0 |",
        "| Additions | 0 |",
        "| Substitutions | 0 |",
        "",
        "### Overall fidelity: 🟢 ALIGNED",
      ].join("\n"),
      usage: { inputTokens: 6120, outputTokens: 640 },
    },
    EXECUTE: {
      beats: EXECUTE_BEATS,
      writes: EXECUTE_WRITES,
      report: [
        "# EXECUTE — Iteration 1",
        "",
        "Added `applyDiscount(total, code)` to `src/cart.ts` with the SAVE10/SAVE20",
        "rates from the spec, and three cases in `test/cart.test.ts`.",
      ].join("\n"),
      usage: { inputTokens: 8214, outputTokens: 913 },
    },
    VALIDATE_STEP: {
      beats: [
        { text: "Compiling the iteration's files against the spec…\n", ms: 280 },
        { text: "src/cart.ts  no diagnostics\n", ms: 200 },
      ],
      report: [
        "# Validation Gate — Iteration 1",
        "",
        "| Check | Result |",
        "|---|---|",
        "| TypeScript execution contract | 0 diagnostics |",
        "| Requirements 1–2 implemented | yes |",
        "",
        "### Overall fidelity: 🟢 ALIGNED",
        "### Audit status: 🟢",
      ].join("\n"),
      usage: { inputTokens: 7410, outputTokens: 520 },
    },
    TEST_MODULE: {
      beats: [
        { text: "bun test — test/cart.test.ts\n", ms: 240 },
        { text: "4 pass · 0 fail\n", ms: 200 },
      ],
      report: ["# QA — Iteration 1", "", "`bun test`: 4 pass, 0 fail.", "", "### Audit status: 🟢"].join(
        "\n",
      ),
      usage: { inputTokens: 4980, outputTokens: 410 },
    },
    SECURE_CHECK: {
      beats: [{ text: "Auditing the diff for injection and secrets…\n", ms: 300 }],
      report: [
        "# Security Audit — Iteration 1",
        "",
        "Pure arithmetic on a caller-supplied total and a lookup table. No I/O, no",
        "user input reaches a query, no secret is read.",
        "",
        "### Audit status: 🟢",
      ].join("\n"),
      usage: { inputTokens: 5310, outputTokens: 380 },
    },
    REVIEW: {
      beats: [{ text: "Reviewing the diff…\n", ms: 300 }],
      report: [
        "# Code Review — Iteration 1",
        "",
        "| Finding | Severity |",
        "|---|---|",
        "| `Math.max(0, …)` documents the non-negative rule from the spec | none |",
        "",
        "No critical findings. One nit: the rate table could be `as const`.",
        "",
        "### Audit status: 🟢",
      ].join("\n"),
      usage: { inputTokens: 6040, outputTokens: 470 },
    },
    DOC_SYNC: {
      beats: [{ text: "Updating plan.md's iteration status…\n", ms: 260 }],
      writes: [
        {
          path: "spec.md",
          content: `${SPEC}\n## Status\n\n- Requirement 1 — implemented\n- Requirement 2 — implemented in iteration 1\n`,
        },
      ],
      report: ["# DOC_SYNC — Iteration 1", "", "spec.md status updated: both requirements implemented."].join(
        "\n",
      ),
      usage: { inputTokens: 3210, outputTokens: 260 },
    },
  },
};

const DEMOS: Demo[] = [LITE, HUGINN];

/** Run git and fail loudly: a demo that silently miscommits is a lie with frames. */
function git(cwd: string, args: string[]): string {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (out.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${out.stderr || out.stdout}`);
  }
  return out.stdout;
}

function writeFile(root: string, write: Write): void {
  const target = join(root, write.path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, write.content);
}

/** A throwaway repository holding the iteration the demo builds. */
function buildRepo(demo: Demo): string {
  const root = join(WORK, demo.id);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "demo@huginn.local"]);
  git(root, ["config", "user.name", "huginn demo"]);
  writeFileSync(join(root, ".gitignore"), ".huginn/\n");
  writeFileSync(join(root, "README.md"), "# tiny-cart\n\nA small cart library.\n");
  for (const file of demo.base) writeFile(root, file);
  // The *plan's* documents are the entry point, and they are committed like a
  // user's would be: the run starts from a clean tree.
  writeFileSync(join(root, "plan.md"), demo.plan);
  writeFileSync(join(root, "spec.md"), demo.spec);
  writeFileSync(join(root, "adr.md"), demo.adr);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "docs: plan iteration 1"]);
  return root;
}

/**
 * The scripted agent: a `RuntimePort` that streams a scripted turn per phase,
 * writes the iteration's files, reports usage, and returns the phase's report.
 * Everything the engine derives from that answer — the parsed verdict, the
 * receipt, the commit — is real.
 */
function scriptedRuntime(demo: Demo, phaseNow: () => string) {
  let sessionCount = 0;
  return {
    id: "pi",
    name: "scripted demo agent",
    capabilities: {
      inProcess: false,
      structuredEvents: true,
      streaming: true,
      permissions: "none",
      sessionHistory: false,
      sessionResume: false,
      modelCatalog: "none",
      structuredOutput: false,
      usageCost: true,
      mcpListing: false,
      interrupt: false,
      filesystemIsolation: "worktree",
    },
    isAvailable: async () => ({ ok: true }),
    listModels: async () => ({ models: [] }),
    resolveModel: (reference: string) => ({ ok: true as const, model: reference }),
    async createSession(options: {
      sink?: (event: { type: string; [key: string]: unknown }) => void;
    }) {
      sessionCount += 1;
      const sessionIndex = sessionCount;
      return {
        id: `demo-session-${sessionIndex}`,
        resumable: false,
        async prompt(request: { text: string; directory?: string }) {
          const phase = phaseNow() ?? phaseFromPrompt(request.text);
          const script = demo.phases[phase] ?? {
            report: `# ${phase}\n\nNothing to do for the demo.`,
          };
          for (const beat of script.beats ?? []) {
            options.sink?.({ type: "text", text: beat.text });
            await sleep(beat.ms ?? 240);
          }
          // The write lands where the engine pointed the agent: the iteration's
          // own worktree when sandboxing is on.
          const dir = request.directory ?? process.cwd();
          for (const file of script.writes ?? []) writeFile(dir, file);
          const usage = script.usage ?? { inputTokens: 0, outputTokens: 0 };
          options.sink?.({
            type: "usage",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: 0,
          });
          return { messageId: `demo-${phase.toLowerCase()}`, text: script.report, raw: script.report };
        },
        async interrupt() {},
        async close() {},
      };
    },
  };
}

/**
 * The phase a prompt belongs to, from the prompt itself.
 *
 * The engine announces every phase on `phaseStart` before it prompts, and that
 * is the primary source (`phaseNow`); this is the fallback for the one case the
 * event does not cover — a fix round, whose prompt is the thinker/executor pair
 * and not the phase's own.
 */
function phaseFromPrompt(text: string): string {
  const head = text.slice(0, 600);
  const signatures: Array<[string, RegExp]> = [
    ["SPEC_AUDIT", /spec-to-implementation contract auditor/i],
    ["REVIEW", /code reviewer|review this (diff|change)/i],
    ["SECURE_CHECK", /security auditor|security audit/i],
    ["TEST_MODULE", /qa engineer|test engineer|quality assurance/i],
    ["DOC_SYNC", /documentation (writer|sync)|technical writer/i],
    ["EXECUTE", /execute the following iteration/i],
  ];
  for (const [phase, pattern] of signatures) {
    if (pattern.test(head)) return phase;
  }
  for (const phase of [
    "FIX_VALIDATE",
    "FIX_TEST",
    "FIX_SECURITY",
    "FIX_REVIEW",
    "FIX_VERIFY",
    "REPAIR_PROMOTION",
  ]) {
    if (head.includes(phase.toLowerCase()) || head.toLowerCase().includes(phase.toLowerCase())) return phase;
  }
  return "EXECUTE";
}

/** What one recording produced, ready for the Python renderer. */
interface Recording {
  demo: string;
  columns: number;
  rows: number;
  fps: number;
  chunks: Array<{ t: number; data: string }>;
}

/** The opening of the recording: a typed command line, then the dashboard. */
async function typeCommand(stdout: PassThrough, command: string): Promise<void> {
  // The stream handler owns the timeline: never push a chunk by hand here too.
  const write = (data: string) => stdout.write(data);
  write("\u001b[38;5;244m~/tiny-cart\u001b[0m $ ");
  for (const char of command) {
    // One chunk per keystroke, so the renderer can animate the typing.
    write(char);
    await sleep(38);
  }
  write("\r\n");
  await sleep(280);
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const demos = wanted.length > 0 ? DEMOS.filter((demo) => wanted.includes(demo.id)) : DEMOS;
  if (demos.length === 0) {
    throw new Error(`unknown demo: ${wanted.join(", ")} (known: ${DEMOS.map((d) => d.id).join(", ")})`);
  }

  mkdirSync(BUILD, { recursive: true });
  const [{ CycleEngine }, { Dashboard }, React, { render }, { events }] = await Promise.all([
    import("../../src/engine/cycle"),
    import("../../src/tui/Dashboard"),
    import("react"),
    import("ink"),
    import("../../src/engine/engineEvents"),
  ]);
  const { freshState, computePlanHash } = await import("../../src/state/store");
  const { handleReportCommand } = await import("../../src/commands/report");

  for (const demo of demos) {
    const repo = buildRepo(demo);

    const cfg = {
      projectPath: repo,
      planPath: join(repo, "plan.md"),
      specPath: join(repo, "spec.md"),
      adrPath: join(repo, "adr.md"),
      thinker: "anthropic/claude-opus-4-5",
      executor: "opencode/gpt-5.1-codex",
      mode: "auto" as const,
      profile: demo.profile,
      permissions: "auto" as const,
      maxRetries: 1,
      tui: true,
      port: 0,
      serverTimeoutMs: 1000,
      phaseTimeoutMs: 60_000,
      ignorePlanChanges: true,
      // The default: each iteration runs in its own git worktree and is promoted
      // back, which is what the engine does for a real user.
      sandbox: true,
      verify: true,
    };

    const plan = {
      content: demo.plan,
      iterations: [ITERATION],
    };

    const state = freshState({
      planHash: computePlanHash([cfg.planPath, cfg.specPath, cfg.adrPath]),
      planPath: cfg.planPath,
      specPath: cfg.specPath,
      adrPath: cfg.adrPath,
      thinker: cfg.thinker,
      executor: cfg.executor,
      mode: cfg.mode,
    });

    const realLog = console.log;
    const chunks: Recording["chunks"] = [];
    const startedAt = () => Math.round(performance.now() - t0);
    const t0 = performance.now();

    const stdout = new PassThrough() as PassThrough & {
      columns: number;
      rows: number;
      // Ink only paints per-frame diffs on a TTY; without this it would write a
      // single frame at unmount and the recording would have no motion.
      isTTY: boolean;
    };
    stdout.columns = COLUMNS;
    stdout.rows = ROWS;
    stdout.isTTY = true;
    stdout.on("data", (chunk: Buffer) => {
      chunks.push({ t: startedAt(), data: chunk.toString() });
    });
    Object.defineProperty(process.stdout, "columns", { value: COLUMNS, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });

    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: () => unknown;
      ref: () => unknown;
      unref: () => unknown;
    };
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;

    await typeCommand(stdout, demo.command);
    // Two blank rows between the typed command and the dashboard: the recording
    // reads as one shell session, and the alt-screen exit below returns to it.
    stdout.write("\r\n");
    await sleep(420);

    // The engine announces each phase on `phaseStart`; the scripted agent asks
    // which one it is answering, so a prompt is never guessed from its prose.
    let currentPhase = "";
    const offPhase = events.on("phaseStart", (event) => {
      currentPhase = event.phase;
    });
    const runtime = scriptedRuntime(demo, () => currentPhase);
    const engine = new CycleEngine({ cfg, plan, state, runtime } as never);
    const app = render(
      React.createElement(Dashboard, {
        engine,
        cfg,
        autoExit: false,
        iterations: [ITERATION.title],
      }) as never,
      { stdout: stdout as never, stdin: stdin as never, interactive: true, patchConsole: false },
    );

    await sleep(120);
    // A recording must never hang on a decision: nothing human is watching this
    // engine, so an unexpected prompt is a scripted answer that no longer fits
    // the gates — abort, record, and fail loudly instead of spinning forever.
    let blockedAt: string | undefined;
    const offDecision = events.on("decision", (request) => {
      blockedAt = `${request.kind} at ${request.phase ?? "?"}: ${request.message}`;
      engine.requestAbort();
    });
    const watchdog = setTimeout(() => {
      blockedAt ??= "watchdog: the run did not finish in 60s";
      engine.requestAbort();
    }, 60_000);
    try {
      await engine.run();
    } finally {
      clearTimeout(watchdog);
      offDecision();
      offPhase();
    }
    await sleep(1600);
    app.unmount();
    await sleep(250);
    if (blockedAt) throw new Error(`[capture] ${demo.id}: ${blockedAt}`);
    if (engine.getOutcome().reason !== "completed") {
      throw new Error(`[capture] ${demo.id}: run ended as ${engine.getOutcome().reason}`);
    }

    // The dashboard is an alternate screen (`setupTuiEnvironment`), so leaving it
    // restores the shell: the typed command is still there, and the run's final
    // word plus the receipt land below it. Emit the restore explicitly.
    stdout.write("\u001b[2J\u001b[H\u001b[38;5;244m~/tiny-cart\u001b[0m $ " + demo.command + "\r\n");
    await sleep(320);
    console.log(""); // keeps the console patch honest after Ink unmounts
    const done = chalk.green.bold("\n✨ [huginn] Plan completed successfully!");
    stdout.write(done + "\r\n");
    await sleep(700);

    // The receipt is the point of the demo, so the recording ends on the command
    // that reads it back — huginn's own output, not a hand-written summary.
    const reportLines: string[] = [];
    console.log = (...args: unknown[]) => reportLines.push(args.map(String).join(" "));
    try {
      handleReportCommand({ "--project": repo });
    } finally {
      console.log = realLog;
    }
    stdout.write(`\r\n\u001b[38;5;244m~/tiny-cart\u001b[0m $ huginn report\r\n`);
    await sleep(420);
    for (const line of reportLines.length > 0 ? reportLines : ["[huginn] no receipt written"]) {
      stdout.write(line + "\r\n");
      await sleep(70);
    }
    await sleep(2200);

    const recording: Recording = { demo: demo.id, columns: COLUMNS, rows: ROWS, fps: 12, chunks };
    const target = join(BUILD, `${demo.id}.jsonl`);
    writeFileSync(target, chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n");
    writeFileSync(
      join(BUILD, `${demo.id}.json`),
      JSON.stringify(
        { demo: demo.id, columns: COLUMNS, rows: ROWS, fps: recording.fps, durationMs: chunks.at(-1)?.t ?? 0 },
        null,
        2,
      ) + "\n",
    );
    events.clear();
    console.error(
      `[capture] ${demo.id}: ${chunks.length} chunks, ${(chunks.at(-1)?.t ?? 0) / 1000}s -> ${target}`,
    );
  }
}

await main();
