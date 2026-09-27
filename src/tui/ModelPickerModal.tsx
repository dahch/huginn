import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { IAgentRuntime, ModelInfo } from "../engine/agent/types.js";

export interface ModelPickerResult {
  thinker: string;
  executor: string;
  saveScope: "project" | "global" | "session";
}

export interface ModelPickerModalProps {
  runtime: IAgentRuntime;
  initialThinker?: string;
  initialExecutor?: string;
  onSelect: (result: ModelPickerResult) => void;
  onCancel: () => void;
}

const DEFAULT_FALLBACK_MODELS: ModelInfo[] = [
  {
    id: "anthropic/claude-3-7-sonnet-latest",
    name: "Claude 3.7 Sonnet",
    provider: "Anthropic",
    description: "Hybrid reasoning and code generation flagship",
  },
  {
    id: "anthropic/claude-3-5-sonnet-latest",
    name: "Claude 3.5 Sonnet",
    provider: "Anthropic",
    description: "High capability coding model",
  },
  {
    id: "anthropic/claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "Anthropic",
    description: "Advanced architectural reasoning (default thinker)",
  },
  {
    id: "opencode/gpt-5.1-codex",
    name: "GPT-5.1 Codex",
    provider: "OpenAI",
    description: "Frontier code execution model (default executor)",
  },
  {
    id: "openai/o3-mini",
    name: "o3-mini",
    provider: "OpenAI",
    description: "Fast reasoning and code synthesis",
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "Google",
    description: "Multimodal and long-context reasoning",
  },
];

type PickerStep = "thinker" | "executor" | "saveScope";

const PERSISTENCE_OPTIONS: Array<{
  id: "project" | "global" | "session";
  label: string;
  detail: string;
}> = [
  {
    id: "project",
    label: "Project Default",
    detail: "Save to .huginn/config.json (recommended for this repository)",
  },
  {
    id: "global",
    label: "Global Default",
    detail: "Save to ~/.huginn/config.json (used across all projects without config)",
  },
  {
    id: "session",
    label: "Session Only",
    detail: "Apply for current session only without writing to disk",
  },
];

const VISIBLE_ITEMS = 6;

function sanitizeKeyInput(input: string): string {
  return input
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "");
}

export const ModelPickerModal = React.memo(function ModelPickerModal({
  runtime,
  initialThinker = "anthropic/claude-opus-4-5",
  initialExecutor = "opencode/gpt-5.1-codex",
  onSelect,
  onCancel,
}: ModelPickerModalProps) {
  const [step, setStep] = useState<PickerStep>("thinker");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedThinker, setSelectedThinker] = useState(initialThinker);
  const [selectedExecutor, setSelectedExecutor] = useState(initialExecutor);
  const [persistenceIndex, setPersistenceIndex] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const catalog = await runtime.getAvailableModels();
        if (active) {
          if (catalog && catalog.length > 0) {
            setAvailableModels(catalog);
          } else {
            setAvailableModels(DEFAULT_FALLBACK_MODELS);
          }
        }
      } catch {
        if (active) {
          setAvailableModels(DEFAULT_FALLBACK_MODELS);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [runtime]);

  const filteredModels = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return availableModels;
    return availableModels.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q) ||
        (m.description && m.description.toLowerCase().includes(q)),
    );
  }, [availableModels, filter]);

  // Keep selected index within bounds
  useEffect(() => {
    if (selectedIndex >= filteredModels.length) {
      setSelectedIndex(Math.max(0, filteredModels.length - 1));
    }
  }, [filteredModels.length, selectedIndex]);

  // Ref bridge ensures useInput callbacks always access the freshest state/props
  // even under React 19's useEffectEvent memoization in Ink reconciler.
  const stateRef = useRef({
    step,
    selectedIndex,
    filter,
    filteredModels,
    selectedThinker,
    selectedExecutor,
    persistenceIndex,
    runtime,
    initialThinker,
    initialExecutor,
    onSelect,
    onCancel,
  });
  stateRef.current = {
    step,
    selectedIndex,
    filter,
    filteredModels,
    selectedThinker,
    selectedExecutor,
    persistenceIndex,
    runtime,
    initialThinker,
    initialExecutor,
    onSelect,
    onCancel,
  };

  useInput((input, key) => {
    const cur = stateRef.current;
    if (key.escape) {
      cur.onCancel();
      return;
    }

    if (cur.step === "saveScope") {
      if (key.upArrow || input === "k") {
        setErrorMsg(null);
        setPersistenceIndex((i) => (i > 0 ? i - 1 : PERSISTENCE_OPTIONS.length - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setErrorMsg(null);
        setPersistenceIndex((i) => (i < PERSISTENCE_OPTIONS.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        const chosen = PERSISTENCE_OPTIONS[cur.persistenceIndex]?.id ?? "project";
        try {
          cur.onSelect({
            thinker: cur.selectedThinker,
            executor: cur.selectedExecutor,
            saveScope: chosen,
          });
        } catch (err) {
          setErrorMsg((err as Error).message || "Failed to confirm model selection");
        }
        return;
      }
      if (input === "1") {
        setErrorMsg(null);
        setPersistenceIndex(0);
        return;
      }
      if (input === "2") {
        setErrorMsg(null);
        setPersistenceIndex(1);
        return;
      }
      if (input === "3") {
        setErrorMsg(null);
        setPersistenceIndex(2);
        return;
      }
      return;
    }

    // Step thinker or executor
    if (key.upArrow) {
      setErrorMsg(null);
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setErrorMsg(null);
      setSelectedIndex((i) => Math.min(Math.max(0, cur.filteredModels.length - 1), i + 1));
      return;
    }
    if (key.return) {
      setErrorMsg(null);
      const chosenModel = cur.filteredModels[cur.selectedIndex];
      let modelId: string;
      if (chosenModel) {
        modelId = chosenModel.id;
      } else {
        const trimmed = cur.filter.trim();
        if (!trimmed) {
          modelId = cur.step === "thinker" ? cur.initialThinker : cur.initialExecutor;
        } else if (!trimmed.includes("/")) {
          modelId = `${cur.runtime.id}/${trimmed}`;
        } else {
          modelId = trimmed;
        }
      }

      const slashIdx = modelId.indexOf("/");
      if (slashIdx <= 0 || slashIdx === modelId.length - 1) {
        setErrorMsg("Custom models must be in provider/model format (e.g. anthropic/claude-3-5-sonnet)");
        return;
      }

      if (cur.step === "thinker") {
        setSelectedThinker(modelId);
        setStep("executor");
        setFilter("");
        setSelectedIndex(0);
      } else {
        setSelectedExecutor(modelId);
        setStep("saveScope");
        setFilter("");
        setSelectedIndex(0);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setErrorMsg(null);
      setFilter((f) => f.slice(0, -1));
      setSelectedIndex(0);
      return;
    }

    const clean = sanitizeKeyInput(input);
    if (clean) {
      setErrorMsg(null);
      setFilter((f) => f + clean);
      setSelectedIndex(0);
    }
  });

  // Calculate scroll slice for long model lists
  const scrollOffset = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(VISIBLE_ITEMS / 2),
      Math.max(0, filteredModels.length - VISIBLE_ITEMS),
    ),
  );
  const visibleModels = filteredModels.slice(scrollOffset, scrollOffset + VISIBLE_ITEMS);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      width="100%"
    >
      <Box justifyContent="space-between" marginBottom={0}>
        <Text bold color="cyan">
          {step === "thinker"
            ? "🤖 MODEL SELECTOR · Step 1/3: Choose Thinker (Architect & Fixes)"
            : step === "executor"
              ? "⚡ MODEL SELECTOR · Step 2/3: Choose Executor (Coder & Gates)"
              : "💾 PERSISTENCE · Step 3/3: Save Model Preferences"}
        </Text>
        <Text color="gray">Runtime: {runtime.name} (Esc to cancel)</Text>
      </Box>

      {step !== "saveScope" && (
        <Box marginY={0}>
          <Text bold color="gray">
            Search:{" "}
          </Text>
          <Text color="white">{filter}</Text>
          <Text color="cyan">▎</Text>
          {filter ? (
            <Text color="gray"> ({filteredModels.length} matches)</Text>
          ) : (
            <Text color="gray"> (type to filter or type custom provider/model)</Text>
          )}
        </Box>
      )}

      {errorMsg ? (
        <Box marginY={0}>
          <Text bold color="red">
            ⚠ {errorMsg}
          </Text>
        </Box>
      ) : null}

      {loading ? (
        <Box paddingY={1}>
          <Text color="yellow">Discovering available models from {runtime.name}...</Text>
        </Box>
      ) : step === "saveScope" ? (
        <Box flexDirection="column" marginY={1}>
          <Box marginBottom={1}>
            <Text>
              Selected: <Text bold color="cyan">{selectedThinker}</Text> (Thinker) ·{" "}
              <Text bold color="green">{selectedExecutor}</Text> (Executor)
            </Text>
          </Box>
          <Text bold color="yellow">
            Where would you like to save these model settings as default?
          </Text>
          {PERSISTENCE_OPTIONS.map((opt, idx) => {
            const isSelected = idx === persistenceIndex;
            return (
              <Box key={opt.id} marginY={0}>
                <Text bold color={isSelected ? "cyan" : "gray"}>
                  {isSelected ? " › " : "   "}
                  [{idx + 1}] {opt.label.padEnd(18)}
                </Text>
                <Text color={isSelected ? "white" : "gray"}>— {opt.detail}</Text>
              </Box>
            );
          })}
        </Box>
      ) : (
        <Box flexDirection="column" marginY={0}>
          {filteredModels.length === 0 ? (
            <Box paddingY={1} flexDirection="column">
              <Text color="yellow">No models matching "{filter}"</Text>
              <Text color="gray">
                Press Enter to use custom model string "{filter.trim()}"
              </Text>
            </Box>
          ) : (
            visibleModels.map((m, relativeIdx) => {
              const actualIdx = scrollOffset + relativeIdx;
              const isSelected = actualIdx === selectedIndex;
              const providerBadge = `[${m.provider}]`;
              return (
                <Box key={m.id} justifyContent="space-between">
                  <Box>
                    <Text bold color={isSelected ? "cyan" : "gray"}>
                      {isSelected ? " › " : "   "}
                    </Text>
                    <Text bold color={isSelected ? "magenta" : "gray"}>
                      {providerBadge.padEnd(12)}{" "}
                    </Text>
                    <Text bold color={isSelected ? "white" : "white"}>
                      {m.name.padEnd(24)}{" "}
                    </Text>
                    <Text color={isSelected ? "cyan" : "gray"}>
                      ({m.id})
                    </Text>
                  </Box>
                  {m.description && (
                    <Text color="gray" wrap="truncate-end">
                      {m.description.slice(0, 32)}
                    </Text>
                  )}
                </Box>
              );
            })
          )}
          {filteredModels.length > VISIBLE_ITEMS && (
            <Box justifyContent="center" marginTop={0}>
              <Text color="gray" dimColor>
                showing {scrollOffset + 1}-{Math.min(filteredModels.length, scrollOffset + VISIBLE_ITEMS)} of {filteredModels.length} (use ↑/↓ to scroll)
              </Text>
            </Box>
          )}
        </Box>
      )}

      <Box
        borderStyle="single"
        borderTop={true}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor="gray"
        paddingTop={0}
        marginTop={0}
        justifyContent="space-between"
      >
        <Text color="gray">
          {step === "saveScope"
            ? "↑/↓: navigate · 1/2/3: direct pick · Enter: confirm · Esc: cancel"
            : "↑/↓: navigate · Enter: select · Type: filter/custom · Esc: cancel"}
        </Text>
        <Text color="gray">
          Current: T: {selectedThinker} · E: {selectedExecutor}
        </Text>
      </Box>
    </Box>
  );
});
