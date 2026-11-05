import React from "react";
import { readFileSync, readdirSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Text } from "ink";
import { render } from "./inkRender";
import { Modal, MODAL_KEY_CONTRACT } from "../../src/tui/Modal";
import { HelpModal } from "../../src/tui/HelpModal";
import { SkillsModal } from "../../src/tui/SkillsModal";
import { AgentPickerModal } from "../../src/tui/AgentPickerModal";
import { ProfilePickerModal } from "../../src/tui/ProfilePickerModal";
import { ModelPickerModal } from "../../src/tui/ModelPickerModal";
import { McpInspectorModal } from "../../src/tui/McpInspectorModal";
import { AGENT_TARGETS } from "../../src/agents/integrator.js";
import { events } from "../../src/engine/engineEvents.js";
import type { Skill } from "../../src/engine/skills/types.js";
import type { IAgentRuntime, McpStatusReport, ModelInfo } from "../../src/engine/agent/types.js";

function createMockStdin(): PassThrough & {
  isTTY: boolean;
  setRawMode: () => PassThrough;
  ref: () => PassThrough;
  unref: () => PassThrough;
} {
  const stdin = new PassThrough() as any;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

const tick = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(
  element: React.ReactElement,
): Promise<{
  stdin: PassThrough;
  finish: () => string;
  /** The frame written so far, without unmounting (which would stop input). */
  output: () => string;
  press: (key: string) => Promise<void>;
}> {
  const stdout = new PassThrough() as any;
  stdout.columns = 120;
  stdout.rows = 40;
  // A TTY-shaped sink makes Ink flush each frame, so a test can inspect the
  // frame while the modal is still accepting keys (`output()`), not only after
  // unmount.
  stdout.isTTY = true;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const stdin = createMockStdin();
  // Ink downgrades to a non-interactive writer whenever `CI` is set
  // (`is-in-ci`), and that writer holds the frame until unmount — which is
  // exactly what `output()` below cannot wait for. Pin the interactive path
  // here: this harness already claims a TTY sink and TTY stdin, so the only
  // thing `CI` would change is *when* the frame is painted.
  const instance = render(element, {
    stdout,
    stdin,
    patchConsole: false,
    interactive: true,
  });
  await tick(120);
  const press = async (key: string): Promise<void> => {
    stdin.write(key);
    await tick(40);
  };
  // Ink flushes a non-TTY frame on unmount in this harness.
  return {
    stdin,
    finish: () => (instance.unmount(), output),
    output: () => output,
    press,
  };
}

const SKILLS: Skill[] = [
  {
    id: "audit",
    name: "Audit Code",
    description: "Run code audits.",
    triggers: ["audit"],
    body: "Audit this project.",
    filePath: "builtin:audit",
    builtin: true,
  },
];

const MODELS: ModelInfo[] = [
  { id: "anthropic/claude", name: "Claude", provider: "Anthropic" },
  { id: "openai/gpt", name: "GPT", provider: "OpenAI" },
];

const MCP_REPORT: McpStatusReport = {
  servers: [
    {
      id: "muninn",
      name: "muninn",
      status: "connected",
      transport: "stdio",
      toolsCount: 1,
      tools: [{ name: "memory_search", description: "Search memory" }],
    },
  ],
  totalTools: 1,
  healthy: true,
};

function runtime(): IAgentRuntime {
  return {
    id: "opencode",
    name: "OpenCode",
    isAvailable: async () => true,
    getAvailableModels: async () => MODELS,
    getMcpStatus: async () => MCP_REPORT,
    createSession: async () => ({} as any),
  };
}

/** Mount one modal, prove its footer names `Esc`, then press it. */
async function assertModalContract(
  name: string,
  element: (onClose: () => void) => React.ReactElement,
): Promise<void> {
  const onClose = vi.fn();
  const view = await mount(element(onClose));
  view.stdin.write("\u001B");
  await tick(60);
  expect(onClose, `${name} must close on Esc`).toHaveBeenCalledTimes(1);
  const output = view.finish();
  expect(output, `${name} footer must name Esc`).toContain("Esc");
}

const ESC = "\u001B";
const ENTER = "\r";

/** The six console modals, mounted with deterministic props. */
type Case = {
  name: string;
  mount: (handlers: {
    onClose: () => void;
    onSelect: (...args: unknown[]) => void;
  }) => React.ReactElement;
  /** `q` is the browser quick-close: only the two read-only surfaces accept it. */
  quickClose: boolean;
  /** `Enter` is the selectors' confirm key (a browser may use it for its own action). */
  confirm: boolean;
  /** How Enter's effect is observed: a select call, or the next step. */
  confirmProof?: (output: string, onSelect: ReturnType<typeof vi.fn>) => void;
};

const CASES: Case[] = [
  {
    name: "HelpModal",
    quickClose: true,
    confirm: false,
    mount: ({ onClose }) =>
      React.createElement(HelpModal, {
        runtimeName: "OpenCode",
        thinker: "anthropic/claude",
        executor: "openai/gpt",
        projectPath: "/p",
        onClose,
      }),
  },
  {
    name: "SkillsModal",
    quickClose: true,
    // Enter is this browser's own action (execute the skill), never a close.
    confirm: true,
    confirmProof: (_output, onSelect) => {
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "audit" }));
    },
    mount: ({ onClose, onSelect }) =>
      React.createElement(SkillsModal, { skills: SKILLS, onSelect, onClose }),
  },
  {
    name: "AgentPickerModal",
    quickClose: false,
    confirm: true,
    confirmProof: (_output, onSelect) => {
      // Nothing is detected, so the alphabetical fallback list renders and the
      // highlight opens on the active runtime: Enter confirms it and saves it
      // for the project (`s` is the session-only escape hatch, `g` the global).
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(AGENT_TARGETS[0], "project");
    },
    mount: ({ onClose, onSelect }) =>
      React.createElement(AgentPickerModal, {
        currentAgentId: AGENT_TARGETS[0]!,
        onSelect,
        onCancel: onClose,
        detect: async () => AGENT_TARGETS.map((id) => ({ id, available: false })),
      }),
  },
  {
    name: "ProfilePickerModal",
    quickClose: false,
    confirm: true,
    confirmProof: (_output, onSelect) => {
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith("huginn", "session");
    },
    mount: ({ onClose, onSelect }) =>
      React.createElement(ProfilePickerModal, {
        currentProfileId: "huginn",
        onSelect,
        onCancel: onClose,
      }),
  },
  {
    name: "ModelPickerModal",
    quickClose: false,
    confirm: true,
    confirmProof: (output, onSelect) => {
      // The first Enter picks the thinker and advances: the visible proof that
      // the key was consumed as a confirm instead of being swallowed.
      expect(onSelect).not.toHaveBeenCalled();
      expect(output).toContain("Step 2/3");
    },
    mount: ({ onClose, onSelect }) =>
      React.createElement(ModelPickerModal, {
        runtime: runtime(),
        onSelect,
        onCancel: onClose,
      }),
  },
  {
    name: "McpInspectorModal",
    quickClose: false,
    confirm: false,
    mount: ({ onClose }) =>
      React.createElement(McpInspectorModal, {
        runtime: runtime(),
        initialReport: MCP_REPORT,
        onClose,
      }),
  },
];

describe("modal frame contract (REQ-70 / H-13)", () => {
  it("draws the double border only for an alert tone", async () => {
    const normal = await mount(
      React.createElement(Modal, { title: "Title", hint: "Esc close" }, React.createElement(Text, null, "body")),
    );
    const normalOutput = normal.finish();
    expect(normalOutput).toContain("╭");

    const alert = await mount(
      React.createElement(Modal, { title: "Title", hint: "Esc close", tone: "alert" }, React.createElement(Text, null, "body")),
    );
    const alertOutput = alert.finish();
    expect(alertOutput).toContain("╔");
    expect(alertOutput).not.toContain("╭");
  });

  it("keeps every *Modal.tsx free of its own borderStyle", () => {
    const dir = new URL("../../src/tui/", import.meta.url);
    const files = readdirSync(dir).filter(
      (file) => file.endsWith("Modal.tsx") && file !== "Modal.tsx",
    );
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source, `${file} must use the shared frame`).not.toContain("borderStyle");
    }
  });

  it("renders HelpModal with an Esc footer and closes on Esc", async () => {
    await assertModalContract("HelpModal", (onClose) =>
      React.createElement(HelpModal, {
        runtimeName: "OpenCode",
        thinker: "anthropic/claude",
        executor: "openai/gpt",
        projectPath: "/p",
        onClose,
      }),
    );
  });

  it("renders SkillsModal with an Esc footer and closes on Esc", async () => {
    await assertModalContract("SkillsModal", (onClose) =>
      React.createElement(SkillsModal, { skills: SKILLS, onSelect: vi.fn(), onClose }),
    );
  });

  it("renders AgentPickerModal with an Esc footer and closes on Esc", async () => {
    await assertModalContract("AgentPickerModal", (onCancel) =>
      React.createElement(AgentPickerModal, {
        currentAgentId: AGENT_TARGETS[0]!,
        onSelect: vi.fn(),
        onCancel,
        detect: async () => AGENT_TARGETS.map((id) => ({ id, available: false })),
      }),
    );
  });

  it("renders ProfilePickerModal with an Esc footer and closes on Esc", async () => {
    await assertModalContract("ProfilePickerModal", (onCancel) =>
      React.createElement(ProfilePickerModal, {
        currentProfileId: "huginn",
        onSelect: vi.fn(),
        onCancel,
      }),
    );
  });

  it("renders ModelPickerModal with an Esc footer and closes on Esc", async () => {
    await assertModalContract("ModelPickerModal", (onCancel) =>
      React.createElement(ModelPickerModal, {
        runtime: runtime(),
        onSelect: vi.fn(),
        onCancel,
      }),
    );
  });

  it("renders McpInspectorModal with an Esc footer and closes on Esc", async () => {
    await assertModalContract("McpInspectorModal", (onClose) =>
      React.createElement(McpInspectorModal, {
        runtime: runtime(),
        initialReport: MCP_REPORT,
        onClose,
      }),
    );
  });
});

// ── The frame's guarantees (AC: one border, one title row, one key row) ──────

describe("Modal frame — one border, one title row, one key row", () => {
  const body = React.createElement(Text, null, "BODY");

  it("draws a round box by default and a double box for the alert tone", async () => {
    const normal = await mount(
      React.createElement(Modal, { title: "TITLE", hint: "Esc close" }, body),
    );
    const normalOutput = normal.finish();
    expect(normalOutput).toContain("╭");
    expect(normalOutput).toContain("╰");
    expect(normalOutput).not.toContain("╔");
    expect(normalOutput).not.toContain("╚");

    const alert = await mount(
      React.createElement(Modal, { title: "TITLE", hint: "Esc close", tone: "alert" }, body),
    );
    const alertOutput = alert.finish();
    expect(alertOutput).toContain("╔");
    expect(alertOutput).toContain("╚");
    expect(alertOutput).not.toContain("╭");
  });

  it("paints the title, the body and the key footer on separate rows", async () => {
    const view = await mount(
      React.createElement(Modal, { title: "TITLE", hint: "Esc close" }, body),
    );
    const rows = view.finish().split("\n");
    const titleRow = rows.findIndex((row) => row.includes("TITLE"));
    const hintRow = rows.findIndex((row) => row.includes("Esc close"));
    expect(titleRow).toBeGreaterThanOrEqual(0);
    expect(hintRow).toBeGreaterThan(titleRow);
    // One row each: the title/body/footer never share a line.
    expect(rows[titleRow]).not.toContain("BODY");
    expect(rows[hintRow]).not.toContain("BODY");
    expect(rows[hintRow]).not.toContain("TITLE");
  });

  it("renders the optional subtitle as one muted row below the title", async () => {
    const view = await mount(
      React.createElement(
        Modal,
        { title: "TITLE", subtitle: "SUBTITLE", hint: "Esc close" },
        body,
      ),
    );
    const rows = view.finish().split("\n");
    const titleRow = rows.findIndex((row) => row.includes("TITLE"));
    const subtitleRow = rows.findIndex((row) => row.includes("SUBTITLE"));
    expect(subtitleRow).toBe(titleRow + 1);
  });

  it("accepts a ReactNode hint, keeping the caller's row specs intact", async () => {
    const view = await mount(
      React.createElement(
        Modal,
        { title: "TITLE", hint: React.createElement(Text, null, "Esc close") },
        body,
      ),
    );
    expect(view.finish()).toContain("Esc close");
  });

  it("pays one padding column on each side (paddingX={1})", async () => {
    const view = await mount(
      React.createElement(Modal, { title: "TITLE", hint: "Esc close" }, body),
    );
    const rows = view.finish().split("\n");
    const titleRow = rows.find((row) => row.includes("TITLE"));
    // `│ TITLE …` — the border, one padding column, then the title.
    expect(titleRow).toMatch(/│ TITLE/);
  });

  it("honours a caller-planned height and clips the overflow instead of growing", async () => {
    const tallBody = React.createElement(
      Text,
      null,
      Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"),
    );
    const view = await mount(
      React.createElement(Modal, { title: "TITLE", hint: "Esc close", height: 6 }, tallBody),
    );
    const rows = view
      .finish()
      .split("\n")
      .map((row) => row.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))
      .filter((row) => row.trim().length > 0);
    // The frame never asks the terminal for a row it was not given: `height` is
    // exact and `overflow="hidden"` clips the rest of the child.
    expect(rows).toHaveLength(6);
    expect(view.output()).toContain("line 0");
    expect(view.output()).not.toContain("line 19");
  });

  it("declares the fixed frame props that keep it from guessing the layout", () => {
    const source = readFileSync(new URL("../../src/tui/Modal.tsx", import.meta.url), "utf8");
    expect(source).toContain("paddingX={1}");
    expect(source).toContain("flexShrink={0}");
    expect(source).toContain('overflow="hidden"');
    // The tone decides the border, and the frame never accepts an override.
    expect(source).toContain('borderStyle={alert ? "double" : "round"}');
    expect(source).not.toMatch(/borderStyle\?:/);
  });
});

// ── The key grammar, proven from outside every modal ─────────────────────────

describe("modal key grammar — Esc closes, everywhere, without exception", () => {
  for (const testCase of CASES) {
    it(`${testCase.name} closes on Esc`, async () => {
      const onClose = vi.fn();
      const view = await mount(testCase.mount({ onClose, onSelect: vi.fn() }));
      await view.press(ESC);
      const output = view.finish();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(output, `${testCase.name} footer must name Esc`).toContain("Esc");
    });
  }
});

describe("modal key grammar — q closes only the two read-only browsers", () => {
  for (const testCase of CASES) {
    it(`${testCase.name} ${testCase.quickClose ? "closes" : "stays open"} on q`, async () => {
      const onClose = vi.fn();
      const view = await mount(testCase.mount({ onClose, onSelect: vi.fn() }));
      await view.press("q");
      view.finish();
      expect(onClose).toHaveBeenCalledTimes(testCase.quickClose ? 1 : 0);
    });
  }
});

describe("modal key grammar — Enter confirms only in the selectors", () => {
  for (const testCase of CASES) {
    it(`${testCase.name} never closes on Enter`, async () => {
      const onClose = vi.fn();
      const view = await mount(testCase.mount({ onClose, onSelect: vi.fn() }));
      await view.press(ENTER);
      view.finish();
      expect(onClose).not.toHaveBeenCalled();
    });
  }

  for (const testCase of CASES.filter((c) => c.confirm)) {
    it(`${testCase.name} acts on Enter instead of ignoring it`, async () => {
      const onSelect = vi.fn();
      const view = await mount(testCase.mount({ onClose: vi.fn(), onSelect }));
      await view.press(ENTER);
      const output = view.finish();
      testCase.confirmProof!(output, onSelect);
    });
  }

  it("McpInspectorModal does not move its pane on Enter (Tab owns the pane)", async () => {
    const view = await mount(
      CASES.find((c) => c.name === "McpInspectorModal")!.mount({
        onClose: vi.fn(),
        onSelect: vi.fn(),
      }),
    );
    await view.press(ENTER);
    const afterEnter = view.finish();
    expect(afterEnter).not.toContain("Focus: tools");

    const tabbed = await mount(
      CASES.find((c) => c.name === "McpInspectorModal")!.mount({
        onClose: vi.fn(),
        onSelect: vi.fn(),
      }),
    );
    await tabbed.press("\t");
    expect(tabbed.finish()).toContain("Focus: tools");
  });
});

describe("modal key grammar — k/j only where they already were", () => {
  it("AgentPickerModal moves with j and selects the next runtime alphabetically", async () => {
    const onSelect = vi.fn();
    const view = await mount(
      React.createElement(AgentPickerModal, {
        currentAgentId: "cursor",
        onSelect,
        onCancel: vi.fn(),
        detect: async () => AGENT_TARGETS.map((id) => ({ id, available: true })),
      }),
    );
    await view.press("j");
    await view.press(ENTER);
    view.finish();
    // The list is alphabetical, so the row after `cursor` is `devin`, not the
    // next entry of the registry.
    expect(onSelect).toHaveBeenCalledWith("devin", "project");
  });

  it("AgentPickerModal moves with k back to the active target", async () => {
    const onSelect = vi.fn();
    const view = await mount(
      React.createElement(AgentPickerModal, {
        currentAgentId: "claude",
        onSelect,
        onCancel: vi.fn(),
        detect: async () => AGENT_TARGETS.map((id) => ({ id, available: true })),
      }),
    );
    await view.press("k");
    await view.press(ENTER);
    view.finish();
    expect(onSelect).toHaveBeenCalledWith("agy", "project");
  });

  it("ProfilePickerModal moves with j before Enter applies it", async () => {
    const onSelect = vi.fn();
    const view = await mount(
      React.createElement(ProfilePickerModal, {
        currentProfileId: "huginn",
        onSelect,
        onCancel: vi.fn(),
      }),
    );
    await view.press("j");
    await view.press(ENTER);
    view.finish();
    expect(onSelect).toHaveBeenCalledWith("sdd", "session");
  });

  it("ProfilePickerModal moves back with k, and clamps at the first row", async () => {
    const onSelect = vi.fn();
    const view = await mount(
      React.createElement(ProfilePickerModal, {
        currentProfileId: "sdd",
        onSelect,
        onCancel: vi.fn(),
      }),
    );
    await view.press("k");
    // A second `k` at the first row must not wrap or select out of bounds.
    await view.press("k");
    await view.press(ENTER);
    view.finish();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("huginn", "session");
  });

  it("SkillsModal moves with j before Enter executes the skill", async () => {
    const onSelect = vi.fn();
    const view = await mount(
      React.createElement(SkillsModal, {
        skills: [
          ...SKILLS,
          {
            id: "refactor",
            name: "Refactor",
            description: "Refactor code.",
            triggers: [],
            body: "Refactor.",
            filePath: "builtin:refactor",
            builtin: true,
          },
        ],
        onSelect,
        onClose: vi.fn(),
      }),
    );
    await view.press("j");
    await view.press(ENTER);
    view.finish();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "refactor" }));
  });

  it("ModelPickerModal keeps j/k as filter text on its search steps", async () => {
    const view = await mount(
      React.createElement(ModelPickerModal, {
        runtime: runtime(),
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    await view.press("j");
    await view.press("k");
    const output = view.finish();
    // The letters reached the filter, so the empty '' match state is rendered —
    // a vim movement here would have left the catalog untouched.
    expect(output).toContain('No models matching "jk"');
  });

  it("HelpModal ignores j/k, which are not its move keys", async () => {
    const onClose = vi.fn();
    const view = await mount(
      React.createElement(HelpModal, {
        runtimeName: "OpenCode",
        thinker: "t",
        executor: "e",
        projectPath: "/p",
        onClose,
      }),
    );
    await view.press("j");
    await view.press("k");
    view.finish();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ── Drift guards: the contract is one literal, three surfaces ───────────────

const TUI_DIR = new URL("../../src/tui/", import.meta.url);

describe("the key grammar is documented, not just implemented", () => {
  it("exports the same literals the docs and the handlers use", () => {
    expect(MODAL_KEY_CONTRACT.close).toBe("Esc");
    expect([...MODAL_KEY_CONTRACT.quickClose].sort()).toEqual(["HelpModal", "SkillsModal"]);
    expect([...MODAL_KEY_CONTRACT.confirm].sort()).toEqual([
      "AgentPickerModal",
      "ModelPickerModal",
      "ProfilePickerModal",
    ]);
    expect(MODAL_KEY_CONTRACT.move).toBe("↑/↓");
    expect(MODAL_KEY_CONTRACT.vimMove).toBe("k/j");
  });

  it("covers every console modal the frame claims to unify", () => {
    const files = readdirSync(TUI_DIR)
      .filter((file) => file.endsWith("Modal.tsx") && file !== "Modal.tsx")
      .sort();
    // Six console modals plus the decision surface, which shares the frame and
    // owns the `alert` tone (its rows are specs, not a one-row hint).
    expect(files).toEqual([
      "AgentPickerModal.tsx",
      "DecisionModal.tsx",
      "HelpModal.tsx",
      "McpInspectorModal.tsx",
      "ModelPickerModal.tsx",
      "ProfilePickerModal.tsx",
      "SkillsModal.tsx",
    ]);
    for (const testCase of CASES) {
      expect(files).toContain(`${testCase.name}.tsx`);
    }
  });

  it("makes every *Modal.tsx render through the shared frame", () => {
    const files = readdirSync(TUI_DIR).filter(
      (file) => file.endsWith("Modal.tsx") && file !== "Modal.tsx",
    );
    for (const file of files) {
      const source = readFileSync(new URL(file, TUI_DIR), "utf8");
      expect(source, `${file} must import the shared frame`).toContain('from "./Modal.js"');
      expect(source, `${file} must render <Modal>`).toContain("<Modal");
      // The frame owns the border: no modal may draw its own.
      expect(source, `${file} must not own a borderStyle`).not.toMatch(/borderStyle/);
    }
  });

  it("keeps the README's key-grammar paragraph honest", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain("Every modal shares one key grammar");
    expect(readme).toContain("`q` closes only the cheat sheet and the skills");
    expect(readme).toContain("`Enter` confirms only in the runtime, profile and model selectors");
    // The inspector's pane switch is Tab-only; Enter is not a pane key.
    expect(readme).toMatch(/`\[Tab\]` to switch focus between servers and tools panes/);
  });

  it("keeps DESIGN's modal frame section next to the key table", () => {
    const design = readFileSync(new URL("../../DESIGN.md", import.meta.url), "utf8");
    expect(design).toContain("The shared modal frame and the uniform key grammar");
    expect(design).toContain("`Esc` | all six");
    expect(design).toContain("`q` | `HelpModal`, `SkillsModal` only");
    expect(design).toContain("`Enter` | `AgentPickerModal`, `ProfilePickerModal`, `ModelPickerModal` only");
    expect(design).toContain("Focus Toggle**: `[Tab]` toggles");
  });
});

describe("both dashboards read the one footer policy", () => {
  for (const dashboard of ["LiveDashboard.tsx", "Dashboard.tsx"]) {
    it(`${dashboard} asks footerHints instead of composing a fixed sentence`, () => {
      const source = readFileSync(new URL(dashboard, TUI_DIR), "utf8");
      expect(source).toContain('from "./footer.js"');
      expect(source).toContain("footerHints(");
      // No dashboard may re-inline the keys the policy now owns (H-13).
      for (const literal of ["[Tab] Focus:", "[↑/↓] History", "[Space] Pause", "[y] Copy"]) {
        expect(source, `${dashboard} must not inline ${literal}`).not.toContain(literal);
      }
    });
  }
});

// ── Error and empty paths the frame must keep honest ─────────────────────────

describe("modal error paths stay inside the frame", () => {
  it("AgentPickerModal survives a failing probe and says nothing is installed", async () => {
    const html = await mount(
      React.createElement(AgentPickerModal, {
        currentAgentId: AGENT_TARGETS[0]!,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        detect: async () => {
          throw new Error("detection exploded");
        },
      }),
    );
    const output = html.finish();
    // Detection failure is not fatal: the picker still lists every target, and
    // every one of them reads unavailable instead of the modal disappearing.
    expect(output).toContain("— not installed");
    expect(output).toContain("Esc");
  });

  it("AgentPickerModal windows the list and marks both hidden ends", async () => {
    const view = await mount(
      React.createElement(AgentPickerModal, {
        currentAgentId: AGENT_TARGETS[0]!,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        detect: async () => AGENT_TARGETS.map((id) => ({ id, available: false })),
        maxRows: 3,
      }),
    );
    expect(view.output()).toContain("more below");
    // Walk the window down so the head marker has something to announce.
    await view.press("j");
    await view.press("j");
    await view.press("j");
    const output = view.finish();
    expect(output).toContain("more below");
    expect(output).toContain("more above");
  });

  it("ModelPickerModal refuses to advance when the catalog has no model to choose", async () => {
    const view = await mount(
      React.createElement(ModelPickerModal, {
        runtime: {
          ...runtime(),
          getAvailableModels: async () => [],
        } as any,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    await view.press(ENTER);
    const output = view.finish();
    expect(output).toContain("No models discovered from");
    expect(output).not.toContain("Step 2/3");
  });

  it("ModelPickerModal reaches the persistence step and honours the direct 1/2/3 keys", async () => {
    const onSelect = vi.fn();
    const view = await mount(
      React.createElement(ModelPickerModal, {
        runtime: runtime(),
        onSelect,
        onCancel: vi.fn(),
      }),
    );
    await view.press(ENTER); // thinker
    await view.press(ENTER); // executor
    await view.press("x"); // not this step's key
    const beforeConfirm = view.output();
    expect(beforeConfirm).toContain("Step 3/3");
    expect(onSelect).not.toHaveBeenCalled();

    await view.press("3"); // Session Only
    await view.press(ENTER);
    view.finish();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ thinker: "anthropic/claude", saveScope: "session" }),
    );
  });

  it("McpInspectorModal clamps a long server detail to one column", async () => {
    const view = await mount(
      React.createElement(McpInspectorModal, {
        runtime: runtime(),
        initialReport: {
          servers: [
            {
              id: "muninn",
              name: "muninn",
              status: "connected",
              transport: "stdio",
              toolsCount: 0,
              detail: "a very long command line that cannot fit in the server row",
              tools: [],
            },
          ],
          totalTools: 0,
          healthy: true,
        },
        onClose: vi.fn(),
      }),
    );
    const output = view.finish();
    expect(output).toContain("…");
    expect(output).not.toContain("a very long command line that cannot fit in the server row");
  });
});

describe("modal empty-but-said states (no silent no-op)", () => {
  it("ProfilePickerModal falls back to the first row for an unknown active profile", async () => {
    const onSelect = vi.fn();
    const view = await mount(
      React.createElement(ProfilePickerModal, {
        currentProfileId: "does-not-exist",
        onSelect,
        onCancel: vi.fn(),
      }),
    );
    const output = view.output();
    // No row is marked active — an unknown id is not silently mapped onto one.
    expect(output).not.toContain("● active");
    await view.press(ENTER);
    view.finish();
    expect(onSelect).toHaveBeenCalledWith("huginn", "session");
  });

  it("McpInspectorModal says an unknown /mcp id matched nothing instead of ignoring it", async () => {
    const messages: string[] = [];
    const off = events.on("liveChat", (event) => {
      if (event.role === "system") messages.push(event.text);
    });
    try {
      const view = await mount(
        React.createElement(McpInspectorModal, {
          runtime: runtime(),
          initialReport: MCP_REPORT,
          initialServerId: "not-a-server",
          onClose: vi.fn(),
        }),
      );
      view.finish();
      expect(messages.join("\n")).toContain('No MCP server named "not-a-server"');
      expect(messages.join("\n")).toContain("1 registered server(s)");
    } finally {
      off();
    }
  });
});
