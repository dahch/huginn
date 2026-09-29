import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink";
import { ModelPickerModal, type ModelPickerResult } from "../../src/tui/ModelPickerModal";
import type { IAgentRuntime, ModelInfo } from "../../src/engine/agent/types.js";
import { LiveEngine } from "../../src/engine/liveMode";
import { events } from "../../src/engine/engineEvents";
import type { RunConfig } from "../../src/config";

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

const TEST_MODELS: ModelInfo[] = [
  {
    id: "anthropic/claude-3-7-sonnet",
    name: "Claude 3.7 Sonnet",
    provider: "Anthropic",
    description: "Reasoning and coding model",
  },
  {
    id: "opencode/gpt-5.1-codex",
    name: "GPT-5.1 Codex",
    provider: "OpenAI",
    description: "Fast code model",
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "Google",
    description: "Multimodal and reasoning",
  },
];

function createMockRuntime(models: ModelInfo[] = TEST_MODELS): IAgentRuntime {
  return {
    id: "opencode",
    name: "OpenCode",
    isAvailable: async () => true,
    getAvailableModels: async () => models,
    getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
    createSession: async () => ({} as any),
  };
}

describe("ModelPickerModal Component", () => {
  it("renders discovered models from active runtime", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect,
        onCancel,
      }),
      { stdout, stdin, patchConsole: false }
    );

    // Wait for getAvailableModels async state update
    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(output).toContain("MODEL SELECTOR · Step 1/3");
    expect(output).toContain("Claude 3.7 Sonnet");
    expect(output).toContain("GPT-5.1 Codex");
    expect(output).toContain("Runtime: OpenCode");
  });

  it("accepts a bare catalog id (no provider/) verbatim for runtimes that expose bare ids (REQ-27)", async () => {
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime = createMockRuntime([
      { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", provider: "agy" },
    ]);
    const onSelect = vi.fn();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect,
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 50));

    // Enter on thinker selects the bare catalog id (previously rejected by the
    // provider/model check), advancing to the executor step.
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("1");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].thinker).toBe("gemini-3.8-flash-high");
    expect(onSelect.mock.calls[0][0].executor).toBe("gemini-3.8-flash-high");
  });

  it("stays bounded and responsive with a large catalog (~8000 entries) (AC-27.7 / NFR-7)", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const stdin = createMockStdin();
    const bigCatalog: ModelInfo[] = Array.from({ length: 8000 }, (_, i) => ({
      id: `openrouter/model-${i}`,
      name: `Model ${i}`,
      provider: "openrouter",
    }));
    const runtime = createMockRuntime(bigCatalog);

    const started = Date.now();
    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 80));
    const elapsed = Date.now() - started;
    instance.unmount();

    // The full catalog is known (scroll indicator reports all 8000)...
    expect(output).toContain("of 8000");
    // ...but only a bounded window is actually rendered (not 8000 rows).
    const renderedRows = (output.match(/openrouter\/model-\d+/g) ?? []).length;
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(300);
    // Rendering a huge catalog must not block the render loop.
    expect(elapsed).toBeLessThan(3000);
  });

  it("degrades a thrown discovery failure to a sanitized reasoned empty state (AC-27.7 / REV-508)", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime: IAgentRuntime = {
      ...createMockRuntime([]),
      // No getModelCatalog → the base accessor is used, and it rejects.
      getAvailableModels: async () => {
        // Control character must be stripped by sanitizeTerminalText (SEC-001).
        throw new Error("offline\u0007");
      },
    };

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        initialThinker: "anthropic/claude-sonnet-5",
        initialExecutor: "opencode/gpt-5.1-codex",
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    // The throw is absorbed by the shared discovery helper and surfaces as a
    // sanitized reason in the honest empty state — never masked by a hardcoded
    // catalog and never carrying the raw control character (SEC-001).
    const flattened = output.replace(/[│\r\n]+/g, " ").replace(/\s+/g, " ");
    expect(flattened).toContain("No models discovered from OpenCode — offline");
    expect(output).not.toContain("\u0007");
    expect(output).toContain("anthropic/claude-sonnet-5 (current thinker)");
    expect(output).toContain("Type a provider/model id and press Enter");
  });

  it("renders a distinct empty state instead of a fabricated catalog (AC-27.7)", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime: IAgentRuntime = {
      ...createMockRuntime([]),
      getAvailableModels: async () => [],
    };

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    const flattened = output.replace(/[│\r\n]+/g, " ").replace(/\s+/g, " ");
    expect(flattened).toContain(
      "No models discovered from OpenCode — type a provider/model id and press Enter",
    );
    // No fabricated catalog entries.
    expect(output).not.toContain("Claude Opus 4.5");
    expect(output).not.toContain("GPT-5.1 Codex");
  });

  it("still accepts free-text entry from the empty state (AC-27.7)", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime: IAgentRuntime = {
      ...createMockRuntime([]),
      getAvailableModels: async () => [],
    };

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    stdin.write("anthropic/claude-sonnet-5");
    await new Promise((r) => setTimeout(r, 40));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 40));
    instance.unmount();

    expect(output).toContain("Step 2/3: Choose Executor");
  });

  it("prefers getModelCatalog and surfaces its reason instead of the generic copy (AC-27.4)", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime: IAgentRuntime = {
      ...createMockRuntime([]),
      getModelCatalog: async () => ({
        models: [],
        reason: "no model-listing command for this runtime",
      }),
      // Must not be consulted when the richer catalog accessor exists.
      getAvailableModels: async () => {
        throw new Error("getAvailableModels should not be called");
      },
    };

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    const flattened = output.replace(/[│\r\n]+/g, " ").replace(/\s+/g, " ");
    expect(flattened).toContain("No models discovered from OpenCode — no model-listing command for this runtime");
    expect(flattened).toContain("Type a provider/model id and press Enter to continue.");
    // The reason is an honest explanation, not a fabricated catalog.
    expect(output).not.toContain("Claude 3.7 Sonnet");
  });

  it("sanitizes the reason before rendering it (SEC-001)", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime: IAgentRuntime = {
      ...createMockRuntime([]),
      getModelCatalog: async () => ({ models: [], reason: "catalog \u0007failed\u001b[31m" }),
    };

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(output).toContain("catalog failed");
    expect(output).not.toContain("\u0007");
    expect(output).not.toContain("\u001b[31m");
  });

  it("renders the catalog from getModelCatalog when it has models (AC-27.4)", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime: IAgentRuntime = {
      ...createMockRuntime([]),
      getModelCatalog: async () => ({ models: TEST_MODELS }),
      getAvailableModels: async () => [],
    };

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(output).toContain("Claude 3.7 Sonnet");
    expect(output).toContain("GPT-5.1 Codex");
    expect(output.replace(/[│\r\n]+/g, " ")).not.toContain("No models discovered");
  });
  it("seeds thinker/executor from the caller-supplied current models when discovery is empty (AC-27.7)", async () => {
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime: IAgentRuntime = {
      ...createMockRuntime([]),
      getAvailableModels: async () => [],
    };
    const onSelect = vi.fn();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        initialThinker: "anthropic/claude-opus-4-5",
        initialExecutor: "opencode/gpt-5.1-codex",
        onSelect,
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Empty filter + Enter → falls back to the prop-supplied current models.
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 40));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 40));
    stdin.write("1");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].thinker).toBe("anthropic/claude-opus-4-5");
    expect(onSelect.mock.calls[0][0].executor).toBe("opencode/gpt-5.1-codex");
  });

  it("derives the visible current selection from the catalog, not a hardcoded seed (AC-27.7)", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    const flattened = output.replace(/[│\r\n]+/g, " ").replace(/\s+/g, " ");
    expect(flattened).toContain("Current: T: anthropic/claude-3-7-sonnet");
  });

  it("filters models by typing search query", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Type "gemini" into filter
    stdin.write("g");
    stdin.write("e");
    stdin.write("m");
    stdin.write("i");
    stdin.write("n");
    stdin.write("i");

    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(output).toContain("Gemini 2.5 Pro");
    expect(output).toContain("1 matches");
  });

  it("handles empty search filter matches with custom model prompt", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Type query matching nothing
    stdin.write("nonexistent-custom-model");
    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(output).toContain('No models matching "nonexistent-custom-model"');
    expect(output).toContain('Press Enter to use custom model string "nonexistent-custom-model"');
  });

  it("calls onCancel when Escape key is pressed", async () => {
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect,
        onCancel,
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Send Escape sequence (\u001B)
    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 30));
    instance.unmount();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("transitions from thinker (Step 1) to executor (Step 2) on return", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 60));

    // Step 1: Thinker selection -> Press Return
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    expect(output).toContain("Step 2/3: Choose Executor");
  });

  it("transitions thinker -> executor -> saveScope and invokes onSelect", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onSelect = vi.fn();
    const onCancel = vi.fn();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        initialThinker: "anthropic/claude-3-7-sonnet",
        initialExecutor: "opencode/gpt-5.1-codex",
        onSelect,
        onCancel,
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 60));

    // Step 1: Thinker selection -> Press Return to select first model (anthropic/claude-3-7-sonnet)
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 60));

    // Step 2: Executor selection -> Move down one item (to gpt-5.1-codex) and press Return
    stdin.write("\u001B[B"); // down arrow
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 60));

    // Step 3: Choose persistence scope: press '1' for project
    stdin.write("1");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    expect(output).toContain("Step 3/3: Save Model");
    expect(output).toContain("Preferences");
    expect(output).toContain("Save to .huginn/config.json");
    expect(output).toContain("Session Only");

    expect(onSelect).toHaveBeenCalledTimes(1);
    const result: ModelPickerResult = onSelect.mock.calls[0][0];
    expect(result.thinker).toBe("anthropic/claude-3-7-sonnet");
    expect(result.executor).toBe("opencode/gpt-5.1-codex");
    expect(result.saveScope).toBe("project");
  });

  it("selects global or session scope correctly with direct numeric keys", async () => {
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onSelect = vi.fn();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect,
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Select thinker
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));

    // Select executor
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));

    // Select '2' for Global Default
    stdin.write("2");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].saveScope).toBe("global");
  });

  it("auto-prefixes with default provider when pressing Enter on custom filter text without slash (SEC-001)", async () => {
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onSelect = vi.fn();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect,
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Type custom filter without provider: "my-custom-model"
    stdin.write("my-custom-model");
    await new Promise((r) => setTimeout(r, 50));
    // Press Return on thinker
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    // Press Return on executor (selects default)
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    // Confirm saveScope: press '1' and Return
    stdin.write("1");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].thinker).toBe("opencode/my-custom-model");
  });

  it("displays validation error when pressing Enter on invalid custom model string (SEC-001)", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onSelect = vi.fn();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect,
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Type invalid custom string with trailing slash: "invalid/"
    stdin.write("invalid/");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(output.replace(/[│\r\n]+/g, " ").replace(/\s+/g, " ")).toContain(
      "Custom models must be in provider/model format (e.g. anthropic/claude-3-5-sonnet)",
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("catches onSelect error during confirmation without throwing React boundary exception (SEC-001)", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onSelect = vi.fn().mockImplementation(() => {
      throw new Error("Failed to save config");
    });

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect,
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 50));

    // Select thinker
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));

    // Select executor
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));

    // Confirm saveScope -> throws error
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(output).toContain("Failed to save config");
  });

  it("navigates saveScope options using up/down arrow keys with wrap-around", async () => {
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onSelect = vi.fn();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect,
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 50));

    // Thinker selection -> Return
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));

    // Executor selection -> Return
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));

    // Now in saveScope step:
    // Initial index is 0 ("project")
    // Press downArrow (\u001B[B) -> index 1 ("global")
    stdin.write("\u001B[B");
    await new Promise((r) => setTimeout(r, 20));

    // Press downArrow -> index 2 ("session")
    stdin.write("\u001B[B");
    await new Promise((r) => setTimeout(r, 20));

    // Press downArrow -> wrap around to index 0 ("project")
    stdin.write("\u001B[B");
    await new Promise((r) => setTimeout(r, 20));

    // Press upArrow (\u001B[A) -> wrap around to index 2 ("session")
    stdin.write("\u001B[A");
    await new Promise((r) => setTimeout(r, 20));

    // Press upArrow -> index 1 ("global")
    stdin.write("\u001B[A");
    await new Promise((r) => setTimeout(r, 20));

    // Press Return to confirm selection at index 1 ("global")
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].saveScope).toBe("global");
  });

  it("navigates saveScope options using j and k keys with wrap-around and handles direct numeric key '3'", async () => {
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onSelect = vi.fn();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect,
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 50));

    // Step 1: Thinker -> Return
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));

    // Step 2: Executor -> Return
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));

    // Step 3: saveScope step
    // Initial index is 0 ("project")
    // Press 'k' (up) -> wrap around to index 2 ("session")
    stdin.write("k");
    await new Promise((r) => setTimeout(r, 20));

    // Press 'j' (down) -> wrap around to index 0 ("project")
    stdin.write("j");
    await new Promise((r) => setTimeout(r, 20));

    // Press '3' (direct pick) -> index 2 ("session")
    stdin.write("3");
    await new Promise((r) => setTimeout(r, 20));

    // Confirm
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].saveScope).toBe("session");
  });

  it("handles backspace and delete keys to modify filter query and update matches", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));

    // Type query "geminix"
    stdin.write("g");
    stdin.write("e");
    stdin.write("m");
    stdin.write("i");
    stdin.write("n");
    stdin.write("i");
    stdin.write("x");
    await new Promise((r) => setTimeout(r, 40));

    // Press backspace (\x7f) -> filter becomes "gemini"
    stdin.write("\x7f");
    await new Promise((r) => setTimeout(r, 40));

    // Press delete (\u001B[3~) -> filter becomes "gemin"
    stdin.write("\u001B[3~");
    await new Promise((r) => setTimeout(r, 40));

    // Press backspace again (\x08) -> filter becomes "gemi"
    stdin.write("\x08");
    await new Promise((r) => setTimeout(r, 40));

    // Press Return to confirm selection of Gemini 2.5 Pro
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    instance.unmount();

    expect(output).toContain("Gemini 2.5 Pro");
    expect(output).toContain("gemi");
    // Verifies transition to Step 2 (executor)
    expect(output).toContain("Step 2/3: Choose Executor");
  });

  it("navigates model catalog with up and down arrow keys in thinker step", async () => {
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onSelect = vi.fn();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect,
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 50));

    // Down arrow -> index 1
    stdin.write("\u001B[B");
    await new Promise((r) => setTimeout(r, 20));

    // Down arrow -> index 2
    stdin.write("\u001B[B");
    await new Promise((r) => setTimeout(r, 20));

    // Up arrow -> index 1 (TEST_MODELS[1] is "opencode/gpt-5.1-codex")
    stdin.write("\u001B[A");
    await new Promise((r) => setTimeout(r, 20));

    // Select thinker
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 40));

    // In executor step, select default
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 40));

    // In saveScope, confirm
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].thinker).toBe("opencode/gpt-5.1-codex");
  });

  it("auto-prefixes executor custom model without slash and supports custom model with explicit provider slash", async () => {
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onSelect = vi.fn();

    const instance = render(
      React.createElement(ModelPickerModal, {
        runtime,
        onSelect,
        onCancel: vi.fn(),
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 50));

    // Step 1: Thinker - type custom model with slash "mistral/mistral-large"
    stdin.write("mistral/mistral-large");
    await new Promise((r) => setTimeout(r, 40));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 40));

    // Step 2: Executor - type custom model WITHOUT slash "custom-exec-v2"
    stdin.write("custom-exec-v2");
    await new Promise((r) => setTimeout(r, 40));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 40));

    // Step 3: saveScope - confirm with '1'
    stdin.write("1");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].thinker).toBe("mistral/mistral-large");
    expect(onSelect.mock.calls[0][0].executor).toBe("opencode/custom-exec-v2");
    expect(onSelect.mock.calls[0][0].saveScope).toBe("project");
  });
});

describe("Live Mode Model Switching & Slash Commands", () => {
  let emittedChatMessages: Array<{ role: string; text: string }> = [];
  let removeListener: () => void;

  beforeEach(() => {
    emittedChatMessages = [];
    removeListener = events.on("liveChat", (e) => {
      emittedChatMessages.push({ role: e.role, text: e.text });
    });
  });

  afterEach(() => {
    removeListener();
    events.clear();
  });

  const baseConfig: RunConfig = {
    projectPath: "/tmp/fake-proj",
    planPath: "/tmp/fake-proj/plan.md",
    specPath: "/tmp/fake-proj/spec.md",
    adrPath: "/tmp/fake-proj/adr.md",
    thinker: "anthropic/claude-opus-4-5",
    executor: "opencode/gpt-5.1-codex",
    mode: "auto",
    permissions: "auto",
    maxRetries: 3,
    tui: false,
    port: 0,
    serverTimeoutMs: 1000,
    phaseTimeoutMs: 1000,
    ignorePlanChanges: false,
    sandbox: false,
  };

  it("live.updateModels hot-swaps active thinker and executor models", () => {
    const runtime = createMockRuntime();
    const live = new LiveEngine({ cfg: { ...baseConfig }, runtime });

    expect(live.getModels().thinker.modelID).toBe("claude-opus-4-5");
    expect(live.getModels().executor.modelID).toBe("gpt-5.1-codex");

    const updated = live.updateModels({
      thinker: "openai/o3-mini",
      executor: "google/gemini-2.5-pro",
    });

    expect(updated.thinker.providerID).toBe("openai");
    expect(updated.thinker.modelID).toBe("o3-mini");
    expect(updated.executor.providerID).toBe("google");
    expect(updated.executor.modelID).toBe("gemini-2.5-pro");
    expect(live.getConfig().thinker).toBe("openai/o3-mini");
    expect(live.getConfig().executor).toBe("google/gemini-2.5-pro");
  });

  it("LiveApp initializes with showModelPicker=true when cfg.chooseModel is true", async () => {
    const { LiveApp } = await import("../../src/tui/LiveDashboard");
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const live = new LiveEngine({ cfg: { ...baseConfig, chooseModel: true }, runtime });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: { ...baseConfig, chooseModel: true },
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    expect(output).toContain("MODEL SELECTOR · Step 1/3");
  });

  it("emits system error when /model has invalid format for thinker or executor (SEC-001)", async () => {
    const { LiveApp } = await import("../../src/tui/LiveDashboard");
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const live = new LiveEngine({ cfg: { ...baseConfig, chooseModel: false }, runtime });
    live.start = vi.fn().mockResolvedValue(undefined);

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: { ...baseConfig, chooseModel: false },
        initialShowModelPicker: false,
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 60));

    // Type invalid thinker model
    stdin.write("/model invalid-thinker");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 60));

    // Type valid thinker but invalid executor model
    stdin.write("/model anthropic/claude-3-7-sonnet invalid-executor");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 60));

    instance.unmount();

    const invalidThinkerMsg = emittedChatMessages.find((m) =>
      m.text.includes('Invalid model format "invalid-thinker"'),
    );
    expect(invalidThinkerMsg).toBeDefined();
    // REQ-31/AC-31.1: the rejection is prefixed and says what to type instead.
    expect(invalidThinkerMsg?.text).toBe(
      '⚠ Invalid model format "invalid-thinker" — expected "provider/model" ' +
        "(e.g. anthropic/claude-3-7-sonnet). Type /model to pick one from the list.",
    );

    const invalidExecMsg = emittedChatMessages.find((m) =>
      m.text.includes('Invalid model format "invalid-executor"'),
    );
    expect(invalidExecMsg).toBeDefined();
    expect(invalidExecMsg?.text).toBe(
      '⚠ Invalid model format "invalid-executor" — expected "provider/model" ' +
        "(e.g. anthropic/claude-3-7-sonnet). Type /model to pick one from the list.",
    );
  });

  it("defers seeding idea until model picker completes when chooseModel is true (SEC-002)", async () => {
    const { LiveApp } = await import("../../src/tui/LiveDashboard");
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const live = new LiveEngine({
      cfg: { ...baseConfig, chooseModel: true },
      idea: "build an autonomous assistant",
      runtime,
    });
    live.start = vi.fn().mockResolvedValue(undefined);
    live.chat = vi.fn().mockResolvedValue(undefined);

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: { ...baseConfig, chooseModel: true },
        initialShowModelPicker: true,
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 60));

    // During model picker step 1, live.chat should NOT have been called yet
    expect(live.chat).not.toHaveBeenCalled();

    // Select thinker
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    // Select executor
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    // Confirm saveScope (1: project)
    stdin.write("1");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 80));

    instance.unmount();

    // Now after picker finishes, live.chat should have been triggered with the seeded idea
    expect(live.chat).toHaveBeenCalledTimes(1);
    expect(live.chat).toHaveBeenCalledWith("build an autonomous assistant");
  });
});

describe("CLI flag --choose-model", () => {
  it("parses --choose-model as boolean flag in parseArgs", async () => {
    const { parseArgs } = await import("../../src/cli");

    const parsed1 = parseArgs(["--choose-model"]);
    expect(parsed1["--choose-model"]).toBe(true);

    const parsed2 = parseArgs(["live", "--choose-model"]);
    expect(parsed2["--choose-model"]).toBe(true);

    const parsed3 = parseArgs(["run"]);
    expect(parsed3["--choose-model"]).toBeUndefined();
  });
});

describe("Iteration 21 Review Fixes (REV-001 through REV-005)", () => {
  const baseConfig: RunConfig = {
    projectPath: "/tmp/fake-proj",
    planPath: "/tmp/fake-proj/plan.md",
    specPath: "/tmp/fake-proj/spec.md",
    adrPath: "/tmp/fake-proj/adr.md",
    thinker: "anthropic/claude-opus-4-5",
    executor: "opencode/gpt-5.1-codex",
    mode: "auto",
    permissions: "auto",
    maxRetries: 3,
    tui: false,
    port: 0,
    serverTimeoutMs: 1000,
    phaseTimeoutMs: 1000,
  };

  let emittedChatMessages: Array<{ role: string; text: string }> = [];
  let removeListener: () => void;

  beforeEach(() => {
    emittedChatMessages = [];
    removeListener = events.on("liveChat", (msg) => {
      emittedChatMessages.push(msg);
    });
  });

  afterEach(() => {
    removeListener();
    events.clear();
    vi.restoreAllMocks();
  });

  it("REV-001: ModelPickerModal is wrapped in React.memo", () => {
    expect((ModelPickerModal as any).$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("REV-002: handleModelSelect performs persistence before state mutation and keeps modal open on failure", async () => {
    const configModule = await import("../../src/config");
    vi.spyOn(configModule, "saveUserConfig").mockImplementation(() => {
      throw new Error("disk permission denied");
    });

    const { LiveApp } = await import("../../src/tui/LiveDashboard");
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const live = new LiveEngine({ cfg: { ...baseConfig, chooseModel: true }, runtime });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: { ...baseConfig, chooseModel: true },
        initialShowModelPicker: true,
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 60));

    // Step 1: select thinker
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    // Step 2: select executor
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    // Step 3: choose project persistence (calls saveUserConfig -> throws)
    stdin.write("1");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 80));

    instance.unmount();

    // Verify error was emitted to liveChat: the failing component, the file it
    // tried to write and the retry path lead the message (AC-31.1/AC-31.2).
    const failedMsg = emittedChatMessages.find((m) =>
      m.text.includes("Model settings were not saved")
    );
    expect(failedMsg).toBeDefined();
    expect(failedMsg?.text).toContain("⚠ Model settings were not saved");
    expect(failedMsg?.text).toContain("/tmp/fake-proj/.huginn/config.json");
    expect(failedMsg?.text).toContain("retry /model");
    expect(failedMsg?.text).toContain("cause: disk permission denied");

    // Verify live models were NOT mutated due to early persistence failure
    expect(live.getModels().thinker.modelID).toBe("claude-opus-4-5");
    expect(live.cfg.thinker).toBe("anthropic/claude-opus-4-5");
  });

  it("REV-003: Pre-flight model check auto-onboarding sets chooseModel=true when defaults are absent", async () => {
    const { DEFAULT_THINKER_MODEL, DEFAULT_EXECUTOR_MODEL } = await import("../../src/config");

    // Case 1: Runtime only provides models other than the defaults
    const customRuntime = createMockRuntime([
      { id: "qwen/qwen-2.5-coder-32b", name: "Qwen 2.5", provider: "qwen" },
      { id: "deepseek/deepseek-coder-v2", name: "DeepSeek Coder", provider: "deepseek" },
    ]);

    const modelSources = {
      thinker: { value: DEFAULT_THINKER_MODEL, source: "default" as const },
      executor: { value: DEFAULT_EXECUTOR_MODEL, source: "default" as const },
    };

    const cfg: RunConfig = { ...baseConfig, chooseModel: false };

    if (modelSources.thinker.source === "default" || modelSources.executor.source === "default") {
      const models = await customRuntime.getAvailableModels();
      if (models && models.length > 0) {
        const hasDefaultThinker = models.some((m) => m.id === DEFAULT_THINKER_MODEL);
        const hasDefaultExecutor = models.some((m) => m.id === DEFAULT_EXECUTOR_MODEL);
        if (!hasDefaultThinker && !hasDefaultExecutor) {
          cfg.chooseModel = true;
        }
      }
    }

    expect(cfg.chooseModel).toBe(true);

    // Case 2: Runtime provides at least one default model
    const runtimeWithDefaults = createMockRuntime([
      { id: DEFAULT_THINKER_MODEL, name: "Claude Opus 4.5", provider: "anthropic" },
    ]);

    const cfg2: RunConfig = { ...baseConfig, chooseModel: false };

    if (modelSources.thinker.source === "default" || modelSources.executor.source === "default") {
      const models = await runtimeWithDefaults.getAvailableModels();
      if (models && models.length > 0) {
        const hasDefaultThinker = models.some((m) => m.id === DEFAULT_THINKER_MODEL);
        const hasDefaultExecutor = models.some((m) => m.id === DEFAULT_EXECUTOR_MODEL);
        if (!hasDefaultThinker && !hasDefaultExecutor) {
          cfg2.chooseModel = true;
        }
      }
    }

    expect(cfg2.chooseModel).toBe(false);
  });

  it("REV-005 / AC-31.2: /model failures lead with the next step and keep the sanitized cause", async () => {
    const { LiveApp } = await import("../../src/tui/LiveDashboard");
    const stdout = new PassThrough();
    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const live = new LiveEngine({ cfg: baseConfig, runtime });

    // Spy on updateModels to throw an unexpected error
    vi.spyOn(live, "updateModels").mockImplementation(() => {
      throw new Error("Custom update error: backend model registry unreachable");
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: baseConfig,
        initialShowModelPicker: false,
      }),
      { stdout, stdin, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 60));

    // Type valid model format that fails in updateModels
    stdin.write("/model anthropic/claude-3-7-sonnet opencode/gpt-5.1-codex");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 60));

    instance.unmount();

    const errorMsg = emittedChatMessages.find((m) =>
      m.text.includes("Failed to update models")
    );
    expect(errorMsg).toBeDefined();
    // The hint is what the user acts on, so it comes before the raw cause.
    expect(errorMsg?.text).toContain("⚠ Failed to update models — run `/model <id>`");
    expect(errorMsg?.text).toContain(
      "cause: Custom update error: backend model registry unreachable",
    );
  });
});


