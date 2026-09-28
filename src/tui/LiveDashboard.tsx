import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CycleEngine } from "../engine/cycle";
import { LiveAbortError, type LiveEngine } from "../engine/liveMode";
import { saveUserConfig, saveGlobalUserConfig, getProjectConfigPath, getUserConfigPath, type RunConfig } from "../config";
import { AGENT_TARGETS } from "../agents/integrator";
import { events, type LiveStage } from "../engine/engineEvents";
import type { DecisionChoice, DecisionRequest } from "../engine/types";
import { Dashboard, DecisionModal, LogsCard } from "./Dashboard";
import { MarkdownLine } from "./markdown";
import { useTerminalSize } from "./useTerminalSize";
import { ModelPickerModal, type ModelPickerResult } from "./ModelPickerModal";
import { McpInspectorModal } from "./McpInspectorModal";
import { HelpModal } from "./HelpModal";
import { SkillsModal } from "./SkillsModal";
import { findCommand, matchCommands, type SlashCommand } from "./commandRegistry.js";
import {
  NEXT_STEP,
  busyFeedback,
  causeText,
  configSaveStep,
  emptyChatHints,
  failureFeedback,
  failureHeadline,
  okFeedback,
  warnFeedback,
} from "./feedback.js";
import {
  CommandSuggestions,
  MAX_SUGGESTION_ROWS,
  buildSuggestionRows,
  suggestionOverlayHeight,
  type SuggestionRow,
} from "./CommandSuggestions.js";
import { loadSkills, findSkill, type Skill } from "../engine/skills/index.js";
import type { McpStatusReport } from "../engine/agent/types.js";
import { fetchMcpStatusWithTimeout, formatMcpBadge, MCP_STATUS_POLL_TIMEOUT_MS } from "../engine/agent/mcpStatus.js";
import { sanitizeTerminalText } from "../util/text.js";
import {
  RavenHeader,
  headerValue,
  useRavenHeaderPlan,
  type RavenHeaderPlan,
} from "./RavenHeader.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STATUS_LABEL_WIDTH = 17;
const STATUS_VALUE_WIDTH = 35;
const STATUS_LINE_WIDTH = STATUS_LABEL_WIDTH + STATUS_VALUE_WIDTH + 4;
const STATUS_TITLE = "System Diagnostics";

/** Live context rows rendered by `LiveHeader` (stage/badge + models). */
const LIVE_HEADER_CONTEXT_ROWS = 2;
/** Columns the live view's outer `paddingX={1}` spends around the header. */
const LIVE_VIEW_OUTER_INSET = 2;
/** `minHeight` both scrollable cards keep so their title row is never clipped. */
const CARD_MIN_ROWS = 4;
/** Rows a card's rounded border spends (top + bottom). */
const CARD_BORDER_ROWS = 2;
/** The card's own title row, above the body. */
const CARD_TITLE_ROWS = 1;
const INPUT_HEIGHT = 2;
const FOOTER_HEIGHT = 1;
/** The palette's own rounded border (top + bottom). */
const PALETTE_BORDER_ROWS = 2;

/**
 * Rows the header may not spend: the card floors, the input row, the footer and
 * the tallest command palette (6 content rows + border). The header's own row
 * cost is added on top when the plan is derived, so the art can never squeeze
 * the viewport (AC-29.3 / AC-28.4).
 */
const VIEWPORT_RESERVED_ROWS =
  CARD_MIN_ROWS * 2 + INPUT_HEIGHT + FOOTER_HEIGHT + MAX_SUGGESTION_ROWS + PALETTE_BORDER_ROWS;

function statusRow(label: string, value: string): string {
  return `│ ${label.padEnd(STATUS_LABEL_WIDTH)} ${value.padEnd(STATUS_VALUE_WIDTH)}│`;
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

interface FormattedLine {
  id: string;
  type: "system" | "user_header" | "user_body" | "assistant_header" | "assistant_body" | "blank";
  text: string;
}

/**
 * The console's feedback channel: every acknowledgement (busy line, result,
 * failure) is a system message in the conversation, so nothing the user types
 * can end in a silent no-op (AC-31.1). The wording itself comes from
 * `feedback.ts`, which keeps the format consistent.
 */
function emitSystem(text: string): void {
  events.emit("liveChat", { role: "system", text });
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
        // requestAbort() already emitted "done"; avoid a duplicate emission.
        exit();
      } else {
        events.emit("done", { reason: "error", error: (err as Error).message });
        exit();
      }
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
  // The raven header's real row cost (raven mark + live context, or the
  // plain-text fallback) comes from the same plan the component renders, so the
  // layout budget can never disagree with the header (REQ-29 / AC-29.3).
  // `outerInset: 2` is this view's own `paddingX={1}` around the header.
  const headerPlan = useRavenHeaderPlan(
    LIVE_HEADER_CONTEXT_ROWS,
    VIEWPORT_RESERVED_ROWS,
    terminalSize,
    LIVE_VIEW_OUTER_INSET,
  );
  const headerHeight = headerPlan.height;
  /** Rows the palette must leave for the header, cards, input and footer. */
  const paletteReservedRows =
    headerHeight + INPUT_HEIGHT + FOOTER_HEIGHT + CARD_MIN_ROWS * 2 + PALETTE_BORDER_ROWS;
  const [stage, setStage] = useState<LiveStage>("refine");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [decision, setDecision] = useState<DecisionRequest | undefined>();
  const [draftInput, setDraftInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState<boolean>(initialShowModelPicker);
  const [showMcpInspector, setShowMcpInspector] = useState<boolean>(false);
  const [mcpInspectorServerId, setMcpInspectorServerId] = useState<string | undefined>(undefined);
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [showSkills, setShowSkills] = useState<boolean>(false);
  const [currentRuntimeName, setCurrentRuntimeName] = useState<string>(live.runtime.name);
  const [availableSkills, setAvailableSkills] = useState<Skill[]>(() => loadSkills(cfg.projectPath));
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatusReport | null>(null);
  const [currentThinker, setCurrentThinker] = useState(cfg.thinker);
  const [currentExecutor, setCurrentExecutor] = useState(cfg.executor);
  const [focusCard, setFocusCard] = useState<"chat" | "stream">("chat");
  const [chatScroll, setChatScroll] = useState(0);
  const [streamScroll, setStreamScroll] = useState(0);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
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
    }, 80);
    return () => clearInterval(timer);
  }, []);

  // Poll MCP status periodically (on mount, and every 15s) strictly bounded by timeout
  useEffect(() => {
    let active = true;
    const pollMcp = async () => {
      try {
        const report = await fetchMcpStatusWithTimeout(live.runtime, MCP_STATUS_POLL_TIMEOUT_MS);
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

  // ── Inline slash-command palette (REQ-28) ────────────────────────────────
  // The overlay is live only for a bare `/…` token: the first space means the
  // user is typing arguments, so the input reverts to plain text handling.
  const suggestionQuery = draftInput.startsWith("/") && !/\s/.test(draftInput) ? draftInput : null;
  const suggestionMatches = useMemo(
    () => (suggestionQuery === null ? [] : matchCommands(suggestionQuery)),
    [suggestionQuery],
  );
  // The overlay is "open" only while there is something to show, so an unmatched
  // draft (e.g. `/nope`) does not silently swallow Tab/Esc (REQ-28/AC-28.3).
  const suggestionsOpen =
    suggestionQuery !== null &&
    !suggestionsDismissed &&
    inputEnabled &&
    suggestionMatches.length > 0;
  const suggestionRowCap = Math.max(
    1,
    Math.min(MAX_SUGGESTION_ROWS, terminalSize.rows - paletteReservedRows),
  );
  const suggestionRows = useMemo<SuggestionRow[]>(
    () => (suggestionsOpen ? buildSuggestionRows(suggestionMatches, suggestionIndex, suggestionRowCap) : []),
    [suggestionsOpen, suggestionMatches, suggestionIndex, suggestionRowCap],
  );

  // Every edit re-ranks the list, so re-open the palette and go back to the best match.
  useEffect(() => {
    setSuggestionIndex(0);
    setSuggestionsDismissed(false);
  }, [draftInput]);

  const moveSuggestion = (delta: number): void => {
    setSuggestionIndex((i) =>
      Math.min(Math.max(i + delta, 0), Math.max(suggestionMatches.length - 1, 0)),
    );
  };

  /** Insert the accepted command, leaving a trailing space when it takes arguments. */
  const acceptSuggestion = (command: SlashCommand): void => {
    setDraftInput(command.takesArgs ? `${command.id} ` : command.id);
    setSuggestionIndex(0);
  };

  // Seed the CLI-provided initial idea into the conversation (matches headless).
  useEffect(() => {
    const idea = (live.ideaText ?? "").trim();
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
      // requestAbort() already emitted "done"; avoid a duplicate emission.
      exit();
      return;
    }
    // AC-31.1/AC-31.2: the failure gets one actionable line before the session
    // tears down, naming the component and the next step, with the raw cause
    // (sanitized) kept as supporting detail.
    emitSystem(failureFeedback("Live session failed", NEXT_STEP.session, err));
    events.emit("log", { level: "error", message: causeText(err) });
    events.emit("done", { reason: "error", error: causeText(err) });
    exit();
  };

  const executeSkill = useCallback(
    async (skill: Skill): Promise<void> => {
      setShowSkills(false);
      emitSystem(
        busyFeedback(
          `Executing skill: ${sanitizeTerminalText(skill.name)} (${sanitizeTerminalText(skill.id)})`,
        ),
      );
      clearStream();
      setBusy(true);
      try {
        await live.chat(skill.body);
      } catch (err) {
        failSession(err);
      } finally {
        setBusy(false);
      }
    },
    [live],
  );

  /** Reload the project skills and open the browser; returns what it loaded. */
  const openSkills = (): Skill[] => {
    const loaded = loadSkills(cfg.projectPath);
    setAvailableSkills(loaded);
    setShowSkills(true);
    return loaded;
  };

  const applyModels = (parts: string[]): void => {
    const newThinker = parts[0]!;
    const newExecutor = parts[1] || currentExecutor;
    const isValidModel = (s: string): boolean => {
      const idx = s.indexOf("/");
      return idx > 0 && idx < s.length - 1;
    };
    if (!isValidModel(newThinker)) {
      emitSystem(
        warnFeedback(
          `Invalid model format "${sanitizeTerminalText(newThinker)}" — expected "provider/model" ` +
            `(e.g. anthropic/claude-3-7-sonnet). Type /model to pick one from the list.`,
        ),
      );
      return;
    }
    if (!isValidModel(newExecutor)) {
      emitSystem(
        warnFeedback(
          `Invalid model format "${sanitizeTerminalText(newExecutor)}" — expected "provider/model" ` +
            `(e.g. anthropic/claude-3-7-sonnet). Type /model to pick one from the list.`,
        ),
      );
      return;
    }
    try {
      live.updateModels({ thinker: newThinker, executor: newExecutor });
      setCurrentThinker(newThinker);
      setCurrentExecutor(newExecutor);
      emitSystem(
        okFeedback(
          `Active models updated: thinker = ${newThinker}, executor = ${newExecutor} (session only)`,
        ),
      );
    } catch (err) {
      emitSystem(failureFeedback("Failed to update models", NEXT_STEP.modelSelection, err));
    }
  };

  /**
   * Dispatch the draft input. `override` lets the palette submit a command the
   * user accepted without retyping it; argument parsing stays per-command below.
   */
  const submit = async (override?: string): Promise<void> => {
    const text = (override ?? draftInput).trim();
    setDraftInput("");
    if (!text) return;
    if (text !== "/quit" && text !== "/abort" && confirmQuit) {
      setConfirmQuit(false);
    }

    // Command *identity* (id + aliases) is resolved through the registry (ADR-28).
    const command = findCommand(text);
    if (!command) {
      if (text.startsWith("/")) {
        emitSystem(
          warnFeedback(
            `Unknown command "${sanitizeTerminalText(text)}" — type /help for the command reference.`,
          ),
        );
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
      return;
    }

    const token = text.split(/\s+/)[0] ?? "";
    const args = text.slice(token.length).trim();

    switch (command.id) {
      case "/help": {
        // The modal covers the chat card, so the acknowledgement also lands in
        // the conversation for when it closes.
        emitSystem(okFeedback("Cheat sheet open — Esc, q or Enter closes it."));
        setShowHelp(true);
        return;
      }
      case "/skills": {
        if (!args) {
          const loaded = openSkills();
          emitSystem(
            okFeedback(
              `Skill browser open — ${loaded.length} skill(s) available; Enter runs the highlighted one.`,
            ),
          );
          return;
        }
        const matched = findSkill(availableSkills, args);
        if (matched) {
          await executeSkill(matched);
        } else {
          emitSystem(
            warnFeedback(
              `Skill "${sanitizeTerminalText(args)}" not found — type /skills to browse the available skills.`,
            ),
          );
        }
        return;
      }
      case "/status": {
        try {
          const diag = await live.getDiagnostics();
          const safeBranch = sanitizeTerminalText(diag.gitBranch).slice(0, STATUS_VALUE_WIDTH);
          const sandboxStr = diag.worktreeSandbox ? "Yes (isolated worktree)" : "No (primary tree)";
          const cleanStr = diag.gitClean ? "Clean" : "Modified / dirty";
          const memStats = diag.memoryStats;
          // AC-30.5: an unavailable DB is not an empty one — say so (sanitized,
          // and clamped to the row's value column) instead of "0 entities".
          const memStr = memStats.error
            ? `unavailable — ${sanitizeTerminalText(memStats.error)}`.slice(0, STATUS_VALUE_WIDTH)
            : `${memStats.entitiesCount} entities, ${memStats.observationsCount} observations`;
          const safeRuntime = sanitizeTerminalText(diag.runtimeName).slice(0, STATUS_VALUE_WIDTH);
          const safeThinker = sanitizeTerminalText(diag.thinkerModel).slice(0, STATUS_VALUE_WIDTH);
          const safeExecutor = sanitizeTerminalText(diag.executorModel).slice(0, STATUS_VALUE_WIDTH);
          const statusText = [
            `╭─ ${STATUS_TITLE} ${"─".repeat(STATUS_LINE_WIDTH - STATUS_TITLE.length - 5)}╮`,
            statusRow("Git Branch:", safeBranch),
            statusRow("Working Tree:", cleanStr),
            statusRow("Worktree Sandbox:", sandboxStr),
            statusRow("Active Runtime:", safeRuntime),
            statusRow("Thinker Model:", safeThinker),
            statusRow("Executor Model:", safeExecutor),
            statusRow("Muninn Memory:", memStr),
            `╰${"─".repeat(STATUS_LINE_WIDTH - 2)}╯`,
          ].join("\n");
          emitSystem(statusText);
        } catch (err) {
          emitSystem(failureFeedback("Diagnostics failed", NEXT_STEP.diagnostics, err));
        }
        return;
      }
      case "/clear": {
        setMessages([]);
        clearStream();
        setChatScroll(0);
        setStreamScroll(0);
        emitSystem(okFeedback("Conversation and stream viewport cleared."));
        return;
      }
      case "/draft": {
        clearStream();
        setBusy(true);
        emitSystem(
          busyFeedback("Drafting spec.md, adr.md and plan.md from the refined scope…"),
        );
        try {
          const outcome = await live.draft();
          if (outcome === "approved") await onApprove();
          else
            emitSystem(
              warnFeedback("Draft aborted — the documents were left unstaged; /draft retries."),
            );
        } catch (err) {
          failSession(err);
        } finally {
          setBusy(false);
        }
        return;
      }
      case "/quit": {
        if (!confirmQuit) {
          setConfirmQuit(true);
          emitSystem(
            warnFeedback("Type /quit or /abort again to confirm exit — anything else cancels."),
          );
          return;
        }
        setConfirmQuit(false);
        emitSystem(okFeedback("Exiting the live session."));
        live.requestAbort();
        failSession(new LiveAbortError());
        return;
      }
      case "/model": {
        const parts = args.split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          emitSystem(
            okFeedback(
              `Model picker open — discovering models from ${sanitizeTerminalText(currentRuntimeName)} (Esc cancels).`,
            ),
          );
          setShowModelPicker(true);
          return;
        }
        if (parts.length > 2) {
          emitSystem(
            warnFeedback("Usage: /model <thinker> [executor] — too many arguments."),
          );
          return;
        }
        applyModels(parts);
        return;
      }
      case "/mcp": {
        emitSystem(
          okFeedback(
            `MCP inspector open — probing ${sanitizeTerminalText(currentRuntimeName)} ` +
              `(Esc closes it; run /mcp again to re-inspect).`,
          ),
        );
        setMcpInspectorServerId(args || undefined);
        setShowMcpInspector(true);
        return;
      }
      case "/agent": {
        if (!args) {
          const activeAgent = live.runtime.id;
          const list = AGENT_TARGETS.map((t) => (t === activeAgent ? `${t} (active)` : t)).join(", ");
          emitSystem(
            okFeedback(`Available agent runtimes: ${list} — run /agent <id> to switch.`),
          );
          return;
        }
        if ((AGENT_TARGETS as readonly string[]).includes(args)) {
          setBusy(true);
          emitSystem(busyFeedback(`Switching runtime to "${sanitizeTerminalText(args)}"…`));
          try {
            const newRuntime = await live.switchRuntime(args);
            setCurrentRuntimeName(newRuntime.name);
          } catch (err) {
            emitSystem(
              failureFeedback("Runtime switch failed", NEXT_STEP.runtimeSwitch, err),
            );
          } finally {
            setBusy(false);
          }
        } else {
          emitSystem(
            warnFeedback(
              `Unknown agent target "${sanitizeTerminalText(args)}" — available: ${AGENT_TARGETS.join(", ")}`,
            ),
          );
        }
        return;
      }
      default: {
        // A registry entry without a handler is a programming error, not a silent no-op.
        emitSystem(
          warnFeedback(
            `Command "${command.id}" is registered but has no handler — run /help for the commands that work.`,
          ),
        );
        return;
      }
    }
  };

  const handleModelSelect = useCallback(
    (result: ModelPickerResult) => {
      // Persistence comes first so a failed write can never leave the session
      // disagreeing with the config on disk (REV-002) — and, when it fails, the
      // user is told exactly which file could not be written and how to retry
      // (AC-31.2).
      const targetPath =
        result.saveScope === "project"
          ? getProjectConfigPath(cfg.projectPath)
          : result.saveScope === "global"
            ? getUserConfigPath()
            : "";
      try {
        if (result.saveScope === "project") {
          saveUserConfig(cfg.projectPath, { thinker: result.thinker, executor: result.executor });
        } else if (result.saveScope === "global") {
          saveGlobalUserConfig({ thinker: result.thinker, executor: result.executor });
        }
      } catch (err) {
        const hint = configSaveStep(targetPath);
        emitSystem(failureFeedback("Model settings were not saved", hint, err));
        // The modal stays open and shows its own ⚠ row with the same copy.
        throw new Error(failureHeadline("Model settings were not saved", hint));
      }

      try {
        live.updateModels({ thinker: result.thinker, executor: result.executor });
      } catch (err) {
        emitSystem(failureFeedback("Failed to update models", NEXT_STEP.modelSelection, err));
        throw new Error(failureHeadline("Failed to update models", NEXT_STEP.modelSelection));
      }

      setCurrentThinker(result.thinker);
      setCurrentExecutor(result.executor);
      const scopeMsg =
        result.saveScope === "project"
          ? "saved to project config (.huginn/config.json)"
          : result.saveScope === "global"
            ? "saved to global config (~/.huginn/config.json)"
            : "session only";
      emitSystem(
        okFeedback(
          `Active models updated: thinker = ${result.thinker}, executor = ${result.executor} (${scopeMsg})`,
        ),
      );
      setShowModelPicker(false);
    },
    [live, cfg.projectPath],
  );

  // Dynamic layout calculations based on terminal size.
  // `headerPlan`/`paletteReservedRows` are derived at the top of the component.
  const decisionHeight = decision ? 6 : 0;
  // The palette is height-bounded (≤6 content rows + border) and part of the budget.
  const suggestionHeight = suggestionOverlayHeight(suggestionRows);

  let maxLogsAllowed = 0;
  if (terminalSize.rows >= 36) maxLogsAllowed = 4;
  else if (terminalSize.rows >= 30) maxLogsAllowed = 3;
  else if (terminalSize.rows >= 25) maxLogsAllowed = 2;
  else if (terminalSize.rows >= 20) maxLogsAllowed = 1;
  // While the palette is open it owns the row budget: the log tail steps aside so
  // the palette can never push the input row or the cards off-screen (AC-28.4).
  if (suggestionHeight > 0) maxLogsAllowed = 0;

  const visibleLogs = logs.slice(-maxLogsAllowed);
  const logsHeight = visibleLogs.length > 0 ? visibleLogs.length + 3 : 0;

  // Floor at 1 (not 8) so the frame still fits on very short terminals now that
  // the palette also draws rows; the cards shrink with it (AC-28.4).
  const availableHeight = Math.max(
    1,
    terminalSize.rows -
      headerHeight -
      INPUT_HEIGHT -
      FOOTER_HEIGHT -
      logsHeight -
      decisionHeight -
      suggestionHeight,
  );

  const chatHeight = Math.max(1, Math.floor(availableHeight * 0.58));
  const streamHeight = Math.max(1, availableHeight - chatHeight);

  const visibleChatLinesCount = Math.max(1, chatHeight - 3);
  const visibleStreamLinesCount = Math.max(1, streamHeight - 3);

  const maxChatScroll = Math.max(0, formattedChatLines.length - visibleChatLinesCount);
  const maxStreamScroll = Math.max(0, streamLines.length - visibleStreamLinesCount);

  useInput((input, key) => {
    if (showModelPicker || showMcpInspector || showHelp || showSkills) {
      return;
    }
    if (decision) {
      const choice = resolveDecisionKey(input);
      if (choice) live.resolveDecision(choice);
      return;
    }

    // Command palette takes precedence over focus/scroll bindings — but only while open.
    if (suggestionsOpen) {
      const selected = suggestionMatches[Math.min(suggestionIndex, suggestionMatches.length - 1)];
      // `j`/`k` navigate only on a bare slash: otherwise they are real filter input.
      const bareSlash = draftInput === "/";
      if (key.escape) {
        setSuggestionsDismissed(true);
        return;
      }
      if (key.upArrow || (bareSlash && input === "k")) {
        moveSuggestion(-1);
        return;
      }
      if (key.downArrow || (bareSlash && input === "j")) {
        moveSuggestion(1);
        return;
      }
      if (key.tab) {
        // While the palette is open it owns Tab: accept the highlight, never
        // fall through to the focus toggle (REQ-28/AC-28.3).
        if (selected) acceptSuggestion(selected);
        return;
      }
      if (key.return) {
        // A bare `/` is not a command — say so instead of guessing a match or
        // silently swallowing the key (AC-31.1).
        if (draftInput === "/") {
          emitSystem(
            warnFeedback(
              '"/" is not a command yet — keep typing, or press Tab to accept the highlighted one.',
            ),
          );
          return;
        }
        if (findCommand(draftInput)) {
          // A complete command token: run it exactly as typed.
          void submit();
        } else if (selected && !selected.takesArgs) {
          // Accept a partial no-arg command and submit it.
          void submit(selected.id);
        } else if (selected) {
          // Argument-taking command: accept it and leave room for the arguments.
          acceptSuggestion(selected);
        } else {
          // Nothing matched (e.g. `/nope`): submit so the unknown-command reply shows.
          void submit();
        }
        return;
      }
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
        plan={headerPlan}
        stage={stage}
        cfg={cfg}
        spinner={spinner}
        runtimeName={currentRuntimeName}
        runtimeId={live.runtime.id}
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
          initialServerId={mcpInspectorServerId}
          onClose={() => setShowMcpInspector(false)}
        />
      ) : showSkills ? (
        <SkillsModal
          skills={availableSkills}
          onSelect={executeSkill}
          onClose={() => setShowSkills(false)}
        />
      ) : showHelp ? (
        <HelpModal
          runtimeName={currentRuntimeName}
          thinker={currentThinker}
          executor={currentExecutor}
          projectPath={cfg.projectPath}
          onClose={() => setShowHelp(false)}
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

      {!showModelPicker && !showMcpInspector && !showHelp && !showSkills && (
        <>
          <ChatInputRow value={draftInput} enabled={inputEnabled} placeholder="Message...  type / for commands · /draft when ready · /mcp to inspect" />
          {suggestionsOpen && (
            <CommandSuggestions
              matches={suggestionMatches}
              selectedIndex={suggestionIndex}
              maxRows={suggestionRowCap}
            />
          )}
          {/* Single-line footer (AC-28.4): the hint must never wrap, or it costs
              a row the layout budget did not reserve and pushes the frame off
              screen. The stage label never shrinks; the hint truncates. */}
          <Box justifyContent="space-between" height={FOOTER_HEIGHT} overflow="hidden" flexDirection="row">
            <Box flexShrink={1} overflow="hidden">
              {suggestionsOpen ? (
                <Text dimColor wrap="truncate">[↑/↓] Select · [Tab] Accept · [Enter] Run · [Esc] Dismiss</Text>
              ) : (
                <Text dimColor wrap="truncate">[Tab] Toggle focus · [↑/↓] Scroll · [Enter] Send · / for commands</Text>
              )}
            </Box>
            <Box flexShrink={0}>
              <Text dimColor wrap="truncate">stage: {STAGE_LABEL[stage].label}</Text>
            </Box>
          </Box>
        </>
      )}
    </Box>
  );
}

function LiveHeader({
  plan,
  stage,
  cfg,
  spinner,
  runtimeName,
  runtimeId,
  thinker,
  executor,
  mcpStatus,
}: {
  plan: RavenHeaderPlan;
  stage: LiveStage;
  cfg: RunConfig;
  spinner: string;
  runtimeName: string;
  /** Active agent target, so the MCP badge attributes its numbers (AC-32.4). */
  runtimeId: string;
  thinker: string;
  executor: string;
  mcpStatus?: McpStatusReport | null;
}) {
  const s = STAGE_LABEL[stage];
  const mcpBadge = formatMcpBadge(mcpStatus, runtimeId);
  // Presence over decoration (AC-29.4): the raven brand is followed by the live
  // stage, a (truthful) MCP badge, the active runtime, the project path and the
  // active models. Every dynamic value is sanitized and clamped to the columns
  // actually left over, and detail that no longer fits is dropped rather than
  // wrapped, so each row costs exactly the one line the budget reserved (AC-29.3).
  const rowWidth = plan.contentWidth;
  const gap = 2;
  const sep = " · ";
  const stageBadge = `[${spinner} ${s.label}]`;

  // Row 1: right cell, left to right — MCP badge → runtime → project path. The
  // badge attributes its source agent, so it gets a wider budget, clamped to the
  // columns the right cell actually has (AC-29.3) before the rest is laid out.
  const rightBudget = Math.max(0, rowWidth - stageBadge.length - gap - 2);
  const mcpText = headerValue(mcpBadge.text, Math.max(0, Math.min(40, rightBudget)));
  const runtimeLabel = `${sep}runtime: `;
  const runtimeBudget = Math.max(6, Math.min(24, Math.floor(rightBudget * 0.25)));
  const runtimeValue =
    rightBudget - mcpText.length - runtimeLabel.length >= runtimeBudget
      ? headerValue(runtimeName, runtimeBudget)
      : "";
  const projectRoom =
    rightBudget - mcpText.length - (runtimeValue ? runtimeLabel.length + runtimeValue.length : 0) - sep.length;
  const projectValue = projectRoom >= 10 ? headerValue(cfg.projectPath, projectRoom) : "";

  // Row 2: thinker always, executor while both ids still fit side by side.
  const modelLabels = "thinker: ".length + "executor: ".length;
  const modelRoom = rowWidth - gap - modelLabels - 2;
  const bothModels = modelRoom >= 16;
  const thinkerBudget = Math.max(4, bothModels ? Math.ceil(modelRoom / 2) : rowWidth - "thinker: ".length - gap);
  const safeThinker = headerValue(thinker, thinkerBudget);
  const executorBudget = modelRoom - safeThinker.length;
  const safeExecutor = bothModels && executorBudget >= 4 ? headerValue(executor, executorBudget) : "";

  return (
    <RavenHeader
      plan={plan}
      suffix="LIVE"
      rows={[
        [
          <Text key="stage" bold color={s.color} wrap="truncate">
            {stageBadge}
          </Text>,
          <>
            <Text key="mcp" color={mcpBadge.color} wrap="truncate">
              {mcpText}
            </Text>
            {runtimeValue ? (
              <>
                <Text key="runtime-label" dimColor wrap="truncate">
                  {runtimeLabel}
                </Text>
                <Text key="runtime" color="yellow" wrap="truncate">
                  {runtimeValue}
                </Text>
              </>
            ) : null}
            {projectValue ? (
              <Text key="project" dimColor wrap="truncate">
                {`${sep}${projectValue}`}
              </Text>
            ) : null}
          </>,
        ],
        [
          <>
            <Text dimColor>thinker: </Text>
            <Text color="magenta" wrap="truncate">
              {safeThinker}
            </Text>
          </>,
          ...(safeExecutor
            ? [
                <>
                  <Text dimColor>executor: </Text>
                  <Text color="green" wrap="truncate">
                    {safeExecutor}
                  </Text>
                </>,
              ]
            : []),
        ],
      ]}
    />
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
  // Body rows actually available inside the fixed-height card: the effective
  // height (Yoga applies `minHeight` over `height`) minus the border and the
  // title row. The first-run hints are sliced to it, so they can never push the
  // frame past the terminal height on a short terminal (AC-31.3).
  const bodyRows = Math.max(
    0,
    Math.max(height, CARD_MIN_ROWS) - CARD_BORDER_ROWS - CARD_TITLE_ROWS,
  );
  return (
    <Box
      borderStyle="round"
      borderColor={isFocused ? "cyanBright" : "gray"}
      flexDirection="column"
      paddingX={1}
      height={height}
      minHeight={CARD_MIN_ROWS}
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
        <EmptyChatHints maxRows={bodyRows} />
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

/**
 * First-run guidance (AC-31.3): an empty conversation shows what the console can
 * do — the palette, `/draft`, `/mcp`, `/status` — in the raven's voice instead
 * of a single generic line. One row per hint, truncated rather than wrapped, and
 * sliced to the rows the card actually has, so the block can never widen the
 * frame or push it past the terminal height.
 */
function EmptyChatHints({ maxRows }: { maxRows: number }) {
  const hints = emptyChatHints(maxRows);
  if (hints.length === 0) return null;
  return (
    <Box flexDirection="column" overflow="hidden">
      {hints.map((line, index) => (
        <Text
          key={line}
          wrap="truncate"
          dimColor={index > 0}
          color={index === 0 ? "cyanBright" : undefined}
        >
          {line}
        </Text>
      ))}
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
      minHeight={CARD_MIN_ROWS}
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