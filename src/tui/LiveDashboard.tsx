import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CycleEngine } from "../engine/cycle";
import { LiveAbortError, type LiveEngine } from "../engine/liveMode";
import { saveUserConfig, saveGlobalUserConfig, type RunConfig } from "../config";
import { AGENT_TARGETS } from "../agents/integrator";
import { events, type LiveStage } from "../engine/engineEvents";
import type { DecisionChoice, DecisionRequest } from "../engine/types";
import { Dashboard, DecisionModal, LogsCard } from "./Dashboard";
import { MarkdownLine } from "./markdown";
import { useTerminalSize } from "./useTerminalSize";
import { ModelPickerModal, type ModelPickerResult } from "./ModelPickerModal";
import { McpInspectorModal } from "./McpInspectorModal";
import type { McpStatusReport } from "../engine/agent/types.js";
import { fetchMcpStatusWithTimeout, formatMcpBadge } from "../engine/agent/mcpStatus.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

interface FormattedLine {
  id: string;
  type: "system" | "user_header" | "user_body" | "assistant_header" | "assistant_body" | "blank";
  text: string;
}

const STAGE_LABEL: Record<LiveStage, { label: string; color: string }> = {
  refine: { label: "REFINE", color: "cyan" },
  draft: { label: "DRAFT", color: "yellow" },
  approve: { label: "APPROVE", color: "magenta" },
  execute: { label: "EXECUTE", color: "green" },
};

export function LiveApp({
  live,
  cfg,
  initialShowModelPicker,
}: {
  live: LiveEngine;
  cfg: RunConfig;
  initialShowModelPicker?: boolean;
}) {
  const { exit } = useApp();
  const [cycle, setCycle] = useState<CycleEngine | null>(null);
  const seededIdea = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        await live.start();
      } catch (err) {
        events.emit("done", { reason: "error", error: (err as Error).message });
        exit();
      }
    })();
  }, [live, exit]);

  const onApprove = async (): Promise<void> => {
    try {
      const ce = await live.execute();
      setCycle(ce);
    } catch (err) {
      if (err instanceof LiveAbortError) {
        events.emit("done", { reason: "aborted", error: "live session aborted" });
      } else {
        events.emit("done", { reason: "error", error: (err as Error).message });
      }
      exit();
    }
  };

  useEffect(() => {
    if (!cycle) return;
    void (async () => {
      try {
        await cycle.run();
        const choice = await live.ask({
          id: crypto.randomUUID(),
          kind: "post-cycle-live",
          iteration: 0,
          phase: "LIVE",
          attempt: 1,
          message:
            "Cycle completed! All iterations finished successfully.\n\n" +
            "Would you like to exit or return to Live mode to continue refinement?",
        });
        if (choice === "retry") {
          setCycle(null);
          events.emit("liveChat", {
            role: "system",
            text: "Cycle complete. Live mode reactivated. Describe what you want to build or change next.",
          });
        } else {
          events.emit("done", { reason: "completed" });
          exit();
        }
      } catch (err) {
        events.emit("done", { reason: "error", error: (err as Error).message });
        exit();
      }
    })();
  }, [cycle, exit, live]);

  if (cycle) return <Dashboard engine={cycle} cfg={cfg} autoExit={false} />;
  return (
    <RefineView
      live={live}
      cfg={cfg}
      onApprove={onApprove}
      seededIdeaRef={seededIdea}
      initialShowModelPicker={initialShowModelPicker ?? Boolean(cfg.chooseModel)}
    />
  );
}

function RefineView({
  live,
  cfg,
  onApprove,
  seededIdeaRef,
  initialShowModelPicker = false,
}: {
  live: LiveEngine;
  cfg: RunConfig;
  onApprove: () => Promise<void>;
  seededIdeaRef: React.MutableRefObject<boolean>;
  initialShowModelPicker?: boolean;
}) {
  const { exit } = useApp();
  const terminalSize = useTerminalSize();
  const [stage, setStage] = useState<LiveStage>("refine");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [decision, setDecision] = useState<DecisionRequest | undefined>();
  const [draftInput, setDraftInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState<boolean>(initialShowModelPicker);
  const [showMcpInspector, setShowMcpInspector] = useState<boolean>(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatusReport | null>(null);
  const [currentThinker, setCurrentThinker] = useState(cfg.thinker);
  const [currentExecutor, setCurrentExecutor] = useState(cfg.executor);
  const [focusCard, setFocusCard] = useState<"chat" | "stream">("chat");
  const [chatScroll, setChatScroll] = useState(0);
  const [streamScroll, setStreamScroll] = useState(0);
  const [logs, setLogs] = useState<Array<{ level: "info" | "warn" | "error"; message: string; timestamp: string }>>(() => {
    return events.getRecentLogs().map((e) => ({
      level: e.level,
      message: e.message,
      timestamp: e.timestamp
        ? new Date(e.timestamp).toTimeString().split(" ")[0] ?? ""
        : new Date().toTimeString().split(" ")[0] ?? "",
    }));
  });
  const [streamLines, setStreamLines] = useState<string[]>([]);
  const [streamChars, setStreamChars] = useState(0);
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const [now, setNow] = useState(Date.now());
  const streamBuf = useRef("");
  const pendingChars = useRef(0);
  const streamTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushTime = useRef(0);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logBuf = useRef<typeof logs>(logs);

  const clearStream = () => {
    if (streamTimer.current) {
      clearTimeout(streamTimer.current);
      streamTimer.current = null;
    }
    streamBuf.current = "";
    pendingChars.current = 0;
    setStreamLines([]);
    setStreamChars(0);
    setStreamScroll(0);
  };

  const flushStream = () => {
    if (streamTimer.current) {
      clearTimeout(streamTimer.current);
      streamTimer.current = null;
    }
    lastFlushTime.current = Date.now();
    const allLines = streamBuf.current.split("\n");
    const lines =
      allLines.length > 1000
        ? allLines.slice(-1000)
        : allLines;
    if (allLines.length > 1000) {
      streamBuf.current = lines.join("\n");
    }
    setStreamLines(lines);
    if (pendingChars.current > 0) {
      const added = pendingChars.current;
      pendingChars.current = 0;
      setStreamChars((c) => c + added);
    }
  };

  useEffect(() => {
    const timer = setInterval(() => {
      setSpinnerIndex((i) => (i + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, 80);
    return () => clearInterval(timer);
  }, []);

  // Poll MCP status periodically (on mount, and every 15s) strictly bounded by timeout
  useEffect(() => {
    let active = true;
    const pollMcp = async () => {
      try {
        const report = await fetchMcpStatusWithTimeout(live.runtime, 1500);
        if (active) {
          setMcpStatus(report);
        }
      } catch {
        if (active) {
          setMcpStatus({
            servers: [],
            totalTools: 0,
            healthy: false,
            degraded: true,
            error: "Failed to poll MCP status",
          });
        }
      }
    };

    void pollMcp();
    const interval = setInterval(pollMcp, 15000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [live.runtime]);

  // Format messages into distinct lines for scrolling
  const formattedChatLines = useMemo<FormattedLine[]>(() => {
    const lines: FormattedLine[] = [];
    messages.forEach((m, mIdx) => {
      if (m.role === "system") {
        lines.push({ id: `sys-${mIdx}`, type: "system", text: `─ ${m.text}` });
        return;
      }
      if (m.role === "user") {
        lines.push({ id: `u-h-${mIdx}`, type: "user_header", text: "you »" });
        m.text.split("\n").forEach((l, lIdx) => {
          lines.push({ id: `u-b-${mIdx}-${lIdx}`, type: "user_body", text: l });
        });
        lines.push({ id: `u-sp-${mIdx}`, type: "blank", text: "" });
        return;
      }
      lines.push({ id: `a-h-${mIdx}`, type: "assistant_header", text: "thinker »" });
      m.text.split("\n").forEach((l, lIdx) => {
        lines.push({ id: `a-b-${mIdx}-${lIdx}`, type: "assistant_body", text: l });
      });
      lines.push({ id: `a-sp-${mIdx}`, type: "blank", text: "" });
    });
    return lines;
  }, [messages]);

  useEffect(() => {
    const offs: Array<() => void> = [
      events.on("liveStage", (e) => setStage(e.stage)),
      events.on("liveChat", (e) => {
        setMessages((m) => [...m, { role: e.role, text: e.text }]);
        setChatScroll(0); // auto-scroll to bottom on new message
      }),
      events.on("phaseStart", () => {
        clearStream();
      }),
      events.on("phaseStream", (e) => {
        streamBuf.current += e.text;
        pendingChars.current += e.text.length;
        const now = Date.now();
        if (now - lastFlushTime.current >= 60) {
          flushStream();
        } else if (!streamTimer.current) {
          streamTimer.current = setTimeout(flushStream, 60);
        }
      }),
      events.on("phaseEnd", () => {
        flushStream();
      }),
      events.on("log", (e) => {
        const time = e.timestamp
          ? new Date(e.timestamp).toTimeString().split(" ")[0] ?? ""
          : new Date().toTimeString().split(" ")[0] ?? "";
        logBuf.current = [
          ...logBuf.current.slice(-19),
          { level: e.level, message: e.message, timestamp: time },
        ];
        setLogs(logBuf.current);
      }),
      events.on("decision", (req) => setDecision(req)),
      events.on("decisionResolved", () => setDecision(undefined)),
      events.on("done", () => {
        flushStream();
        if (exitTimer.current) clearTimeout(exitTimer.current);
        exitTimer.current = setTimeout(() => exit(), 500);
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      if (streamTimer.current) {
        clearTimeout(streamTimer.current);
        streamTimer.current = null;
      }
      if (exitTimer.current) {
        clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
    };
  }, [exit]);

  const inputEnabled = !busy && stage !== "draft" && !decision;

  // Seed the CLI-provided initial idea into the conversation (matches headless).
  useEffect(() => {
    const idea = live.ideaText.trim();
    if (!idea || seededIdeaRef.current || showModelPicker) return;
    seededIdeaRef.current = true;
    clearStream();
    void (async () => {
      setBusy(true);
      try {
        await live.chat(idea);
      } catch {
        // aborted/errored chat is surfaced by the done/exit path
      } finally {
        setBusy(false);
      }
    })();
  }, [live, seededIdeaRef, showModelPicker]);

  const resolveDecisionKey = (input: string): DecisionChoice | undefined => {
    const c = input.toLowerCase();
    if (decision?.kind === "permission") {
      if (c === "a") return "continue";
      if (c === "o") return "retry";
      if (c === "d") return "deny";
      return undefined;
    }
    if (decision?.kind === "question") {
      if (c === "c" || c === "a" || c === "1" || c === "y") return "continue";
      if (c === "d" || c === "n") return "deny";
      return undefined;
    }
    if (c === "r") return "retry";
    if (c === "c") return "continue";
    if (c === "a") return "abort";
    return undefined;
  };

  const failSession = (err: unknown): void => {
    if (err instanceof LiveAbortError) {
      events.emit("done", { reason: "aborted", error: "live session aborted" });
    } else {
      events.emit("log", { level: "error", message: (err as Error).message });
      events.emit("done", { reason: "error", error: (err as Error).message });
    }
    exit();
  };

  const submit = async (): Promise<void> => {
    const text = draftInput.trim();
    setDraftInput("");
    if (!text) return;
    if (text === "/draft" || text === "/go") {
      clearStream();
      setBusy(true);
      try {
        const outcome = await live.draft();
        if (outcome === "approved") await onApprove();
      } catch (err) {
        failSession(err);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (text === "/quit" || text === "/abort") {
      live.requestAbort();
      failSession(new LiveAbortError());
      return;
    }
    if (text === "/models" || text === "/model") {
      setShowModelPicker(true);
      return;
    }
    if (text === "/mcp" || text.startsWith("/mcp ")) {
      setShowMcpInspector(true);
      return;
    }
    if (text.startsWith("/model ")) {
      const parts = text.slice(7).trim().split(/\s+/).filter(Boolean);
      if (parts.length > 0) {
        const newThinker = parts[0]!;
        const newExecutor = parts[1] || currentExecutor;
        const isValidModel = (s: string) => {
          const idx = s.indexOf("/");
          return idx > 0 && idx < s.length - 1;
        };
        if (!isValidModel(newThinker)) {
          events.emit("liveChat", {
            role: "system",
            text: `Invalid model format "${newThinker}". Expected "provider/model" (e.g. anthropic/claude-3-7-sonnet).`,
          });
          return;
        }
        if (!isValidModel(newExecutor)) {
          events.emit("liveChat", {
            role: "system",
            text: `Invalid model format "${newExecutor}". Expected "provider/model" (e.g. anthropic/claude-3-7-sonnet).`,
          });
          return;
        }
        try {
          live.updateModels({ thinker: newThinker, executor: newExecutor });
          setCurrentThinker(newThinker);
          setCurrentExecutor(newExecutor);
          events.emit("liveChat", {
            role: "system",
            text: `Active models updated: thinker = ${newThinker}, executor = ${newExecutor} (session only)`,
          });
        } catch (err) {
          events.emit("liveChat", {
            role: "system",
            text: (err as Error).message,
          });
        }
        return;
      }
    }
    if (text === "/agent") {
      events.emit("liveChat", {
        role: "system",
        text: `Available agent runtimes: ${AGENT_TARGETS.join(", ")} (active: ${live.runtime.name})`,
      });
      return;
    }
    if (text.startsWith("/agent ")) {
      const target = text.slice(7).trim();
      if ((AGENT_TARGETS as readonly string[]).includes(target)) {
        events.emit("liveChat", {
          role: "system",
          text: `Agent runtime selected: ${target} (active: ${live.runtime.name})`,
        });
      } else {
        events.emit("liveChat", {
          role: "system",
          text: `Unknown agent target "${target}". Available: ${AGENT_TARGETS.join(", ")}`,
        });
      }
      return;
    }
    clearStream();
    setBusy(true);
    try {
      await live.chat(text);
    } catch (err) {
      failSession(err);
    } finally {
      setBusy(false);
    }
  };

  const handleModelSelect = useCallback(
    (result: ModelPickerResult) => {
      try {
        if (result.saveScope === "project") {
          saveUserConfig(cfg.projectPath, { thinker: result.thinker, executor: result.executor });
        } else if (result.saveScope === "global") {
          saveGlobalUserConfig({ thinker: result.thinker, executor: result.executor });
        }
        live.updateModels({ thinker: result.thinker, executor: result.executor });
        setCurrentThinker(result.thinker);
        setCurrentExecutor(result.executor);
        const scopeMsg =
          result.saveScope === "project"
            ? "saved to project config (.huginn/config.json)"
            : result.saveScope === "global"
              ? "saved to global config (~/.huginn/config.json)"
              : "session only";
        events.emit("liveChat", {
          role: "system",
          text: `Active models updated: thinker = ${result.thinker}, executor = ${result.executor} (${scopeMsg})`,
        });
        setShowModelPicker(false);
      } catch (err) {
        events.emit("liveChat", {
          role: "system",
          text: `Failed to update models: ${(err as Error).message}`,
        });
        throw err;
      }
    },
    [live, cfg.projectPath],
  );

  // Dynamic layout calculations based on terminal size
  const headerHeight = 4;
  const inputHeight = 2;
  const footerHeight = 1;
  const decisionHeight = decision ? 6 : 0;

  let maxLogsAllowed = 0;
  if (terminalSize.rows >= 36) maxLogsAllowed = 4;
  else if (terminalSize.rows >= 30) maxLogsAllowed = 3;
  else if (terminalSize.rows >= 25) maxLogsAllowed = 2;
  else if (terminalSize.rows >= 20) maxLogsAllowed = 1;

  const visibleLogs = logs.slice(-maxLogsAllowed);
  const logsHeight = visibleLogs.length > 0 ? visibleLogs.length + 3 : 0;

  const availableHeight = Math.max(
    8,
    terminalSize.rows - headerHeight - inputHeight - footerHeight - logsHeight - decisionHeight,
  );

  const chatHeight = Math.max(4, Math.floor(availableHeight * 0.58));
  const streamHeight = Math.max(4, availableHeight - chatHeight);

  const visibleChatLinesCount = Math.max(1, chatHeight - 3);
  const visibleStreamLinesCount = Math.max(1, streamHeight - 3);

  const maxChatScroll = Math.max(0, formattedChatLines.length - visibleChatLinesCount);
  const maxStreamScroll = Math.max(0, streamLines.length - visibleStreamLinesCount);

  useInput((input, key) => {
    if (showModelPicker || showMcpInspector) {
      return;
    }
    if (decision) {
      const choice = resolveDecisionKey(input);
      if (choice) live.resolveDecision(choice);
      return;
    }
    if (key.escape) {
      live.requestAbort();
      failSession(new LiveAbortError());
      return;
    }
    if (key.tab) {
      setFocusCard((f) => (f === "chat" ? "stream" : "chat"));
      return;
    }

    // Scroll controls (PageUp / PageDown always scroll focused card)
    if (key.pageUp) {
      if (focusCard === "chat") setChatScroll((s) => Math.min(s + 4, maxChatScroll));
      else setStreamScroll((s) => Math.min(s + 4, maxStreamScroll));
      return;
    }
    if (key.pageDown) {
      if (focusCard === "chat") setChatScroll((s) => Math.max(s - 4, 0));
      else setStreamScroll((s) => Math.max(s - 4, 0));
      return;
    }

    // Arrow keys scroll when input is empty or when stream card is focused
    if ((draftInput === "" || focusCard === "stream") && key.upArrow) {
      if (focusCard === "chat") setChatScroll((s) => Math.min(s + 2, maxChatScroll));
      else setStreamScroll((s) => Math.min(s + 2, maxStreamScroll));
      return;
    }
    if ((draftInput === "" || focusCard === "stream") && key.downArrow) {
      if (focusCard === "chat") setChatScroll((s) => Math.max(s - 2, 0));
      else setStreamScroll((s) => Math.max(s - 2, 0));
      return;
    }

    // Trap arrow keys when typing to prevent terminal window scroll leakage
    if (key.upArrow || key.downArrow) {
      return;
    }

    if (key.leftArrow || key.rightArrow || key.delete || key.ctrl || key.meta) {
      return;
    }

    if (inputEnabled) {
      if (key.return) {
        void submit();
        return;
      }
      if (key.backspace) {
        setDraftInput((d) => d.slice(0, -1));
        return;
      }
      const sanitized = input
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
        .replace(/[\x00-\x1F\x7F-\x9F]/g, "");
      if (sanitized) {
        setDraftInput((d) => d + sanitized);
      }
    } else if (input === "q" && draftInput === "") {
      live.requestAbort();
      failSession(new LiveAbortError());
    }
  });

  const spinner = SPINNER_FRAMES[spinnerIndex] ?? "⠋";

  // Slice visible lines for Chat
  const chatStart = Math.max(0, formattedChatLines.length - visibleChatLinesCount - chatScroll);
  const visibleChatLines = formattedChatLines.slice(chatStart, chatStart + visibleChatLinesCount);

  // Slice visible lines for Stream
  const streamStart = Math.max(0, streamLines.length - visibleStreamLinesCount - streamScroll);
  const visibleStreamLines = streamLines.slice(streamStart, streamStart + visibleStreamLinesCount);

  return (
    <Box
      flexDirection="column"
      width={terminalSize.columns}
      height={terminalSize.rows}
      paddingX={1}
      paddingY={0}
    >
      <LiveHeader
        stage={stage}
        cfg={cfg}
        now={now}
        spinner={spinner}
        runtimeName={live.runtime.name}
        thinker={currentThinker}
        executor={currentExecutor}
        mcpStatus={mcpStatus}
      />

      {showModelPicker ? (
        <ModelPickerModal
          runtime={live.runtime}
          initialThinker={currentThinker}
          initialExecutor={currentExecutor}
          onSelect={handleModelSelect}
          onCancel={() => setShowModelPicker(false)}
        />
      ) : showMcpInspector ? (
        <McpInspectorModal
          runtime={live.runtime}
          initialReport={mcpStatus ?? undefined}
          onClose={() => setShowMcpInspector(false)}
        />
      ) : (
        <>
          <ScrollableChatCard
            lines={visibleChatLines}
            totalLines={formattedChatLines.length}
            scrollOffset={chatScroll}
            maxScroll={maxChatScroll}
            isFocused={focusCard === "chat"}
            busy={busy}
            spinner={spinner}
            height={chatHeight}
          />

          <ScrollableStreamCard
            lines={visibleStreamLines}
            totalLines={streamLines.length}
            scrollOffset={streamScroll}
            chars={streamChars}
            isFocused={focusCard === "stream"}
            spinner={spinner}
            busy={busy}
            height={streamHeight}
          />
        </>
      )}

      {visibleLogs.length > 0 && <LogsCard logs={visibleLogs} />}

      {decision ? <DecisionModal req={decision} /> : null}

      {!showModelPicker && !showMcpInspector && (
        <>
          <ChatInputRow value={draftInput} enabled={inputEnabled} placeholder="Message...  /draft when ready · /mcp to inspect · /quit to abort" />
          <Box justifyContent="space-between">
            <Text dimColor>[Tab] Toggle focus · [PageUp/Down, ↑/↓] Scroll · [Enter] Send · /draft to draft · /mcp to inspect · /quit to abort</Text>
            <Text dimColor>stage: {STAGE_LABEL[stage].label}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

function LiveHeader({
  stage,
  cfg,
  now,
  spinner,
  runtimeName,
  thinker,
  executor,
  mcpStatus,
}: {
  stage: LiveStage;
  cfg: RunConfig;
  now: number;
  spinner: string;
  runtimeName: string;
  thinker: string;
  executor: string;
  mcpStatus?: McpStatusReport | null;
}) {
  const s = STAGE_LABEL[stage];
  const mcpBadge = formatMcpBadge(mcpStatus);

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text bold color="cyan">🦅 HUGINN LIVE </Text>
          <Text bold color={s.color}>
            [{spinner} {s.label}]
          </Text>
        </Box>
        <Box>
          <Text color={mcpBadge.color}>{mcpBadge.text}</Text>
          <Text dimColor> · runtime: </Text>
          <Text color="yellow">{runtimeName}</Text>
          <Text dimColor> · project: {cfg.projectPath}</Text>
        </Box>
      </Box>
      <Box justifyContent="space-between">
        <Box>
          <Text dimColor>thinker: </Text>
          <Text color="magenta">{thinker}</Text>
        </Box>
        <Box>
          <Text dimColor>executor: </Text>
          <Text color="green">{executor}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function ScrollableChatCard({
  lines,
  totalLines,
  scrollOffset,
  maxScroll,
  isFocused,
  busy,
  spinner,
  height,
}: {
  lines: FormattedLine[];
  totalLines: number;
  scrollOffset: number;
  maxScroll: number;
  isFocused: boolean;
  busy: boolean;
  spinner: string;
  height: number;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={isFocused ? "cyanBright" : "gray"}
      flexDirection="column"
      paddingX={1}
      height={height}
      minHeight={4}
    >
      <Box justifyContent="space-between" marginBottom={0}>
        <Text bold color={isFocused ? "cyanBright" : "cyan"}>
          REFINEMENT CONVERSATION {isFocused ? "● [Focused: ↑/↓ Scroll]" : "○ [Tab to focus]"}
        </Text>
        <Box>
          {maxScroll > 0 && (
            <Text dimColor>
              {scrollOffset > 0 ? `▲ +${scrollOffset} up ` : "▼ bottom "}
              ({totalLines} lines){" "}
            </Text>
          )}
          {busy && <Text color="yellow">{spinner} thinking...</Text>}
        </Box>
      </Box>
      {lines.length === 0 ? (
        <Box marginY={0} justifyContent="center">
          <Text dimColor>Describe what you want to build or change. I'll help you refine the scope.</Text>
        </Box>
      ) : (
        lines.map((l) => {
          if (l.type === "blank") {
            return <Text key={l.id}> </Text>;
          }
          if (l.type === "system") {
            return (
              <Box key={l.id}>
                <MarkdownLine text={l.text} defaultColor="gray" wrap="wrap" />
              </Box>
            );
          }
          if (l.type === "user_header") {
            return (
              <Text key={l.id} bold color="greenBright">
                {l.text}
              </Text>
            );
          }
          if (l.type === "user_body") {
            return (
              <Box key={l.id} paddingLeft={2}>
                <MarkdownLine text={l.text} defaultColor="white" wrap="wrap" />
              </Box>
            );
          }
          if (l.type === "assistant_header") {
            return (
              <Text key={l.id} bold color="cyanBright">
                {l.text}
              </Text>
            );
          }
          return (
            <Box key={l.id} paddingLeft={2}>
              <MarkdownLine text={l.text} defaultColor="white" wrap="wrap" />
            </Box>
          );
        })
      )}
    </Box>
  );
}

function ScrollableStreamCard({
  lines,
  totalLines,
  scrollOffset,
  chars,
  isFocused,
  spinner,
  busy,
  height,
}: {
  lines: string[];
  totalLines: number;
  scrollOffset: number;
  chars: number;
  isFocused: boolean;
  spinner: string;
  busy: boolean;
  height: number;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={isFocused ? "cyanBright" : "gray"}
      flexDirection="column"
      paddingX={1}
      height={height}
      minHeight={4}
    >
      <Box justifyContent="space-between" marginBottom={0}>
        <Text bold color={isFocused ? "cyanBright" : "cyan"}>
          THINKING & LIVE AGENT STREAM {isFocused ? "● [Focused: ↑/↓ Scroll]" : "○ [Tab to focus]"}
        </Text>
        <Box>
          {chars > 0 && <Text dimColor>{(chars / 1024).toFixed(1)} KB </Text>}
          {busy && <Text color="yellow">{spinner} streaming </Text>}
        </Box>
      </Box>
      {lines.length === 0 ? (
        <Box justifyContent="center" marginY={0}>
          <Text dimColor>Real-time thinking and agent output will stream here while the model runs.</Text>
        </Box>
      ) : (
        lines.map((l, i) => (
          <MarkdownLine
            key={i}
            text={l}
            defaultColor={l.startsWith("⚡") ? "yellow" : l.startsWith("✓") ? "green" : "gray"}
            wrap="truncate"
          />
        ))
      )}
    </Box>
  );
}

function ChatInputRow({ value, enabled, placeholder }: { value: string; enabled: boolean; placeholder: string }) {
  return (
    <Box marginTop={1} flexDirection="row">
      <Text color={enabled ? "green" : "gray"}>{enabled ? "❯ " : "· "}</Text>
      {value.length > 0 ? (
        <Text color="white">{value}</Text>
      ) : (
        <Text dimColor>{placeholder}</Text>
      )}
    </Box>
  );
}