import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { SkillsModal } from "../../src/tui/SkillsModal";
import { sanitizeTerminalText } from "../../src/util/text";
import type { Skill } from "../../src/engine/skills/types.js";

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

const SAMPLE_SKILLS: Skill[] = [
  {
    id: "audit",
    name: "Audit Code",
    description: "Run code audits and security/quality checks.",
    triggers: ["audit", "security"],
    body: "Please audit recently modified files in this project.",
    filePath: "builtin:audit",
    builtin: true,
  },
  {
    id: "custom-perf",
    name: "Performance Check",
    description: "Benchmark query latency and bottlenecks.",
    triggers: ["perf", "bench"],
    body: "Analyze latency hotspots across database queries.",
    filePath: "/proj/.huginn/skills/perf.md",
    builtin: false,
  },
];

describe("SkillsModal Component", () => {
  it("renders skills with [builtin] and [project] badges and shows details", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const onSelect = vi.fn();
    const onClose = vi.fn();

    const instance = render(
      React.createElement(SkillsModal, {
        skills: SAMPLE_SKILLS,
        onSelect,
        onClose,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(output).toContain("PROJECT SKILLS BROWSER");
    expect(output).toContain("Available Skills (2)");
    expect(output).toContain("Audit Code");
    expect(output).toContain("[builtin]");
    expect(output).toContain("Performance Check");
    expect(output).toContain("[project]");
    expect(output).toContain("Run code audits");
    expect(output).toContain("Triggers: audit, security");
    expect(output).toContain("Please audit recently");
  });

  it("navigates skills on down/up arrow and selects with return", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const onSelect = vi.fn();
    const onClose = vi.fn();

    const instance = render(
      React.createElement(SkillsModal, {
        skills: SAMPLE_SKILLS,
        onSelect,
        onClose,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 50));

    // Press down arrow (\u001B[B) then up arrow (\u001B[A) then down arrow
    stdin.write("\u001B[B");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\u001B[A");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\u001B[B");
    await new Promise((r) => setTimeout(r, 30));

    // Press Enter to select
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    instance.unmount();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(SAMPLE_SKILLS[1]);
  });

  it("switches pane focus on Tab and closes on escape or q", async () => {
    // 1. Initial render focuses the list pane
    {
      const stdout = new PassThrough() as any;
      stdout.columns = 120;
      stdout.rows = 30;
      let output = "";
      stdout.on("data", (chunk: any) => {
        output += chunk.toString();
      });

      const instance = render(
        React.createElement(SkillsModal, {
          skills: SAMPLE_SKILLS,
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
        { stdout, stdin: createMockStdin(), patchConsole: false },
      );
      await new Promise((r) => setTimeout(r, 60));
      instance.unmount();
      expect(sanitizeTerminalText(output)).toContain("Focus: LIST");
    }

    // 2. Tab switches focus to the preview pane; q closes the modal
    {
      const stdout = new PassThrough() as any;
      stdout.columns = 120;
      stdout.rows = 30;
      let output = "";
      stdout.on("data", (chunk: any) => {
        output += chunk.toString();
      });

      const stdin = createMockStdin();
      const onClose = vi.fn();

      const instance = render(
        React.createElement(SkillsModal, {
          skills: SAMPLE_SKILLS,
          onSelect: vi.fn(),
          onClose,
        }),
        { stdout, stdin, patchConsole: false },
      );

      await new Promise((r) => setTimeout(r, 60));
      stdin.write("\t");
      await new Promise((r) => setTimeout(r, 40));
      stdin.write("q");
      await new Promise((r) => setTimeout(r, 40));
      instance.unmount();

      expect(sanitizeTerminalText(output)).toContain("Focus: PREVIEW");
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  });

  it("scrolls prompt preview pane with PageDown and PageUp keys", async () => {
    const longBody = Array.from({ length: 16 }, (_, i) => `Instruction line ${i + 1}`).join("\n");
    const skillWithLongBody: Skill = {
      id: "long-skill",
      name: "Long Skill",
      description: "A skill with a long prompt body",
      triggers: ["long"],
      body: longBody,
      filePath: "builtin:long",
      builtin: true,
    };

    // 1. Initial render shows line 1-8
    {
      const stdout = new PassThrough() as any;
      stdout.columns = 120;
      stdout.rows = 30;
      let output = "";
      stdout.on("data", (chunk: any) => {
        output += chunk.toString();
      });

      const instance = render(
        React.createElement(SkillsModal, {
          skills: [skillWithLongBody],
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
        { stdout, stdin: createMockStdin(), patchConsole: false },
      );
      await new Promise((r) => setTimeout(r, 60));
      instance.unmount();
      expect(output).toContain("line 1-8 / 16");
      expect(output).toContain("Instruction line 1");
    }

    // 2. PageDown (\u001b[6~) advances by 4 lines
    {
      const stdout = new PassThrough() as any;
      stdout.columns = 120;
      stdout.rows = 30;
      let output = "";
      stdout.on("data", (chunk: any) => {
        output += chunk.toString();
      });

      const stdin = createMockStdin();
      const instance = render(
        React.createElement(SkillsModal, {
          skills: [skillWithLongBody],
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
        { stdout, stdin, patchConsole: false },
      );
      await new Promise((r) => setTimeout(r, 60));
      stdin.write("\u001b[6~");
      await new Promise((r) => setTimeout(r, 60));
      instance.unmount();
      expect(output).toContain("line 5-12 / 16");
      expect(output).toContain("Instruction line 5");
    }

    // 3. PageDown twice reaches max scroll (8)
    {
      const stdout = new PassThrough() as any;
      stdout.columns = 120;
      stdout.rows = 30;
      let output = "";
      stdout.on("data", (chunk: any) => {
        output += chunk.toString();
      });

      const stdin = createMockStdin();
      const instance = render(
        React.createElement(SkillsModal, {
          skills: [skillWithLongBody],
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
        { stdout, stdin, patchConsole: false },
      );
      await new Promise((r) => setTimeout(r, 60));
      stdin.write("\u001b[6~");
      await new Promise((r) => setTimeout(r, 40));
      stdin.write("\u001b[6~");
      await new Promise((r) => setTimeout(r, 60));
      instance.unmount();
      expect(output).toContain("line 9-16 / 16");
      expect(output).toContain("Instruction line 9");
    }

    // 4. PageDown then PageUp scrolls back
    {
      const stdout = new PassThrough() as any;
      stdout.columns = 120;
      stdout.rows = 30;
      let output = "";
      stdout.on("data", (chunk: any) => {
        output += chunk.toString();
      });

      const stdin = createMockStdin();
      const instance = render(
        React.createElement(SkillsModal, {
          skills: [skillWithLongBody],
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
        { stdout, stdin, patchConsole: false },
      );
      await new Promise((r) => setTimeout(r, 60));
      stdin.write("\u001b[6~");
      await new Promise((r) => setTimeout(r, 40));
      stdin.write("\u001b[5~");
      await new Promise((r) => setTimeout(r, 60));
      instance.unmount();
      expect(output).toContain("line 1-8 / 16");
    }
  });

  it("scrolls prompt preview pane with up/down arrows and j/k when preview pane is focused", async () => {
    const longBody = Array.from({ length: 16 }, (_, i) => `Instruction line ${i + 1}`).join("\n");
    const skillWithLongBody: Skill = {
      id: "long-skill",
      name: "Long Skill",
      description: "A skill with a long prompt body",
      triggers: ["long"],
      body: longBody,
      filePath: "builtin:long",
      builtin: true,
    };

    // 1. Tab switches to preview, down arrow scrolls by 1 line
    {
      const stdout = new PassThrough() as any;
      stdout.columns = 120;
      stdout.rows = 30;
      let output = "";
      stdout.on("data", (chunk: any) => {
        output += chunk.toString();
      });

      const stdin = createMockStdin();
      const instance = render(
        React.createElement(SkillsModal, {
          skills: [skillWithLongBody, SAMPLE_SKILLS[1]!],
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
        { stdout, stdin, patchConsole: false },
      );

      await new Promise((r) => setTimeout(r, 60));
      // Switch focus to preview via Tab
      stdin.write("\t");
      await new Promise((r) => setTimeout(r, 40));
      // Down arrow in preview pane
      stdin.write("\u001b[B");
      await new Promise((r) => setTimeout(r, 60));
      instance.unmount();

      expect(output).toContain("Focus: PREVIEW");
      expect(output).toContain("line 2-9 / 16");
      expect(output).toContain("Selected: Long Skill");
    }

    // 2. Tab switches to preview, 'j' scrolls down, 'k' scrolls back up
    {
      const stdout = new PassThrough() as any;
      stdout.columns = 120;
      stdout.rows = 30;
      let output = "";
      stdout.on("data", (chunk: any) => {
        output += chunk.toString();
      });

      const stdin = createMockStdin();
      const instance = render(
        React.createElement(SkillsModal, {
          skills: [skillWithLongBody, SAMPLE_SKILLS[1]!],
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
        { stdout, stdin, patchConsole: false },
      );

      await new Promise((r) => setTimeout(r, 60));
      stdin.write("\t");
      await new Promise((r) => setTimeout(r, 40));
      stdin.write("j");
      await new Promise((r) => setTimeout(r, 40));
      stdin.write("k");
      await new Promise((r) => setTimeout(r, 60));
      instance.unmount();

      expect(output).toContain("line 1-8 / 16");
    }
  });

  it("renders properly when skills array is empty", async () => {
    const stdout = new PassThrough() as any;
    stdout.columns = 120;
    stdout.rows = 30;
    let output = "";
    stdout.on("data", (chunk: any) => {
      output += chunk.toString();
    });

    const instance = render(
      React.createElement(SkillsModal, {
        skills: [],
        onSelect: vi.fn(),
        onClose: vi.fn(),
      }),
      { stdout, stdin: createMockStdin(), patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    expect(output).toContain("No skills found in project or built-ins");
    expect(output).toContain("No skill selected");
  });
});
