import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { IAgentRuntime, ModelInfo } from "../engine/agent/types.js";
import { discoverModelCatalog } from "../engine/agent/modelCatalog.js";
import { sanitizeTerminalText } from "../util/text.js";

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

/**
 * Three-step model picker (thinker → executor → persistence).
 *
 * REQ-27 / AC-27.7: discovery is rendered truthfully — a loading state, the
 * (sanitized) discovery error, a distinct "no models discovered" empty state
 * with free-text entry, or the real catalog. There is deliberately no
 * `DEFAULT_FALLBACK_MODELS` substitution: the seeds come from the first
 * discovered model, or from the current values passed via props. Large
 * catalogs (≈600–8 000 entries) stay responsive because filtering happens in a
 * `useMemo` and only a 6-row window is rendered.
 */
export const ModelPickerModal = React.memo(function ModelPickerModal({
  runtime,
  initialThinker,
  initialExecutor,
  onSelect,
  onCancel,
}: ModelPickerModalProps) {
  const [step, setStep] = useState<PickerStep>("thinker");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryReason, setDiscoveryReason] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedThinker, setSelectedThinker] = useState(initialThinker ?? "");
  const [selectedExecutor, setSelectedExecutor] = useState(initialExecutor ?? "");
  const [persistenceIndex, setPersistenceIndex] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const safeRuntimeName = sanitizeTerminalText(runtime.name);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // AC-27.4 / REV-010: discovery is delegated to the shared helper
        // (REV-503/REV-504/REV-508) so this modal and `huginn init` share one
        // source of truth: it prefers the richer catalog (an empty result can
        // then carry the *reason* it is empty), falls back to the plain accessor,
        // and degrades any failure to an empty catalog. The `reason` is already
        // sanitized at that boundary, so it is never re-sanitized (or rendered
        // raw) here.
        const catalog = await discoverModelCatalog(runtime);

        if (!active) return;
        setAvailableModels(catalog.models);
        setDiscoveryReason(catalog.reason ?? null);
        // Seed from the runtime's own catalog (never a hardcoded list); fall
        // back to the current values passed via props when filled already.
        setSelectedThinker((prev) => prev || catalog.models[0]?.id || "");
        setSelectedExecutor(
          (prev) => prev || catalog.models[1]?.id || catalog.models[0]?.id || "",
        );
      } catch (err) {
        // The helper absorbs every discovery failure, so this branch only guards
        // against an unforeseen error: it keeps the distinct "discovery failed"
        // state rather than leaving the modal stuck on "loading".
        if (active) {
          setDiscoveryError(
            sanitizeTerminalText(err instanceof Error ? err.message : String(err)) ||
              "model discovery failed",
          );
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

  // Per-runtime seeds: the current values supplied by the caller (where known),
  // used only as free-text examples — no catalog is fabricated.
  const exampleHints = useMemo(() => {
    const hints: string[] = [];
    if (initialThinker) hints.push(`${sanitizeTerminalText(initialThinker)} (current thinker)`);
    if (initialExecutor) hints.push(`${sanitizeTerminalText(initialExecutor)} (current executor)`);
    return hints;
  }, [initialThinker, initialExecutor]);

  // Ref bridge ensures useInput callbacks always access the freshest state/props
  // even under React 19's useEffectEvent memoization in Ink reconciler.
  const stateRef = useRef({
    step,
    selectedIndex,
    filter,
    filteredModels,
    availableModels,
    selectedThinker,
    selectedExecutor,
    persistenceIndex,
    runtime,
    onSelect,
    onCancel,
  });
  stateRef.current = {
    step,
    selectedIndex,
    filter,
    filteredModels,
    availableModels,
    selectedThinker,
    selectedExecutor,
    persistenceIndex,
    runtime,
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
      let modelId: string | undefined;
      // Whether the `provider/model` shape is required. It is waived for a catalog
      // selection and for runtimes whose own catalog exposes bare ids (REQ-27 /
      // AC-27.3): `agy` and Command Code legitimately list ids with no `/`, and a
      // bare id must reach the CLI verbatim so it can resolve its own short name.
      let requireQualified = true;
      const catalogHasBareIds = cur.availableModels.some((m) => !m.id.includes("/"));
      if (chosenModel) {
        modelId = chosenModel.id;
        requireQualified = false;
      } else {
        const trimmed = cur.filter.trim();
        if (trimmed) {
          if (trimmed.includes("/") || catalogHasBareIds) {
            modelId = trimmed;
            requireQualified = trimmed.includes("/");
          } else {
            // Bare text for a fully-qualified runtime is scoped to this runtime.
            modelId = `${cur.runtime.id}/${trimmed}`;
          }
        } else {
          modelId = cur.step === "thinker" ? cur.selectedThinker : cur.selectedExecutor;
          if (catalogHasBareIds) requireQualified = false;
        }
      }

      if (!modelId) {
        setErrorMsg(
          `No models discovered from ${safeRuntimeName} — type a provider/model id and press Enter`,
        );
        return;
      }

      if (requireQualified) {
        const slashIdx = modelId.indexOf("/");
        if (slashIdx <= 0 || slashIdx === modelId.length - 1) {
          setErrorMsg("Custom models must be in provider/model format (e.g. anthropic/claude-3-5-sonnet)");
          return;
        }
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

  const emptyCatalog = !loading && !discoveryError && availableModels.length === 0;

  const renderHints = () =>
    exampleHints.length > 0 ? (
      <Text color="gray" wrap="truncate-end">
        e.g. {exampleHints.join("  ·  ")}
      </Text>
    ) : null;

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
        <Text color="gray">Runtime: {safeRuntimeName} (Esc to cancel)</Text>
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
            ⚠ {sanitizeTerminalText(errorMsg)}
          </Text>
        </Box>
      ) : null}

      {loading ? (
        <Box paddingY={1}>
          <Text color="yellow">Discovering available models from {safeRuntimeName}...</Text>
        </Box>
      ) : step === "saveScope" ? (
        <Box flexDirection="column" marginY={1}>
          <Box marginBottom={1}>
            <Text>
              Selected: <Text bold color="cyan">{sanitizeTerminalText(selectedThinker)}</Text> (Thinker) ·{" "}
              <Text bold color="green">{sanitizeTerminalText(selectedExecutor)}</Text> (Executor)
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
      ) : discoveryError ? (
        <Box flexDirection="column" paddingY={1}>
          <Text bold color="red">
            ⚠ Model discovery from {safeRuntimeName} failed: {discoveryError}
          </Text>
          <Text color="gray">Type a provider/model id and press Enter to continue.</Text>
          {/* AC-31.2: free-text entry *or* the `/model <id>` shortcut, never a bare cause. */}
          <Text color="gray">Or press Esc and retry /model &lt;id&gt; once the CLI can list models again.</Text>
          {renderHints()}
        </Box>
      ) : emptyCatalog ? (
        <Box flexDirection="column" paddingY={1}>
          <Text color="yellow">
            No models discovered from {safeRuntimeName} —{" "}
            {discoveryReason ?? "type a provider/model id and press Enter"}
          </Text>
          {discoveryReason ? (
            <Text color="gray">Type a provider/model id and press Enter to continue.</Text>
          ) : null}
          <Text color="gray">Or press Esc and retry /model &lt;id&gt; once the CLI can list models again.</Text>
          {renderHints()}
        </Box>
      ) : (
        <Box flexDirection="column" marginY={0}>
          {filteredModels.length === 0 ? (
            <Box paddingY={1} flexDirection="column">
              <Text color="yellow">No models matching "{sanitizeTerminalText(filter)}"</Text>
              <Text color="gray">
                Press Enter to use custom model string "{sanitizeTerminalText(filter.trim())}"
              </Text>
            </Box>
          ) : (
            visibleModels.map((m, relativeIdx) => {
              const actualIdx = scrollOffset + relativeIdx;
              const isSelected = actualIdx === selectedIndex;
              const providerBadge = `[${sanitizeTerminalText(m.provider)}]`;
              const modelName = sanitizeTerminalText(m.name);
              const modelId = sanitizeTerminalText(m.id);
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
                      {modelName.padEnd(24)}{" "}
                    </Text>
                    <Text color={isSelected ? "cyan" : "gray"}>
                      ({modelId})
                    </Text>
                  </Box>
                  {m.description && (
                    <Text color="gray" wrap="truncate-end">
                      {sanitizeTerminalText(m.description).slice(0, 32)}
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
          Current: T: {sanitizeTerminalText(selectedThinker) || "—"} · E: {sanitizeTerminalText(selectedExecutor) || "—"}
        </Text>
      </Box>
    </Box>
  );
});
