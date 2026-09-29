import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CycleEngine } from "../engine/cycle";
import {
  LiveAbortError,
  type DiagnosticsInfo,
  type LiveEngine,
  type TranscriptTurn,
} from "../engine/liveMode";
import { saveUserConfig, saveGlobalUserConfig, getProjectConfigPath, getUserConfigPath, type RunConfig } from "../config";
import { AGENT_TARGETS } from "../agents/integrator";
import { isAgentTarget } from "../engine/agent/registry";
import { events, type LiveStage } from "../engine/engineEvents";
import type { DecisionChoice, DecisionRequest } from "../engine/types";
import { Dashboard, DecisionModal, LogsCard } from "./Dashboard";
import { MarkdownLine } from "./markdown";
import { useTerminalSize } from "./useTerminalSize";
import { THEME, mcpStatusToken, type ThemeToken } from "./theme.js";
import { ModelPickerModal, type ModelPickerResult } from "./ModelPickerModal";
import { McpInspectorModal } from "./McpInspectorModal";
import { HelpModal } from "./HelpModal";
import { SkillsModal } from "./SkillsModal";
import { AgentPickerModal } from "./AgentPickerModal";
import { findCommand, matchCommands, type SlashCommand } from "./commandRegistry.js";
import { profileSpec } from "../engine/profiles.js";
import {
  NEXT_STEP,
  busyFeedback,
  causeText,
  configSaveStep,
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
import {
  caretRowEnd,
  caretRowStart,
  composerRowBudget,
  composerScroll,
  cursorIndexAtRow,
  cursorLineParts,
  deleteAt,
  deleteBefore,
  deleteWordAfter,
  deleteWordBefore,
  insertAt,
  layoutComposer,
  moveCursorLeft,
  moveCursorRight,
  sanitizeComposerInput,
} from "./composer.js";
import { loadSkills, findSkill, type Skill } from "../engine/skills/index.js";
import type { McpStatusReport } from "../engine/agent/types.js";
import {
  fetchMcpStatusWithTimeout,
  formatMcpBadge,
  MCP_STATUS_POLL_TIMEOUT_MS,
  type McpBadge,
} from "../engine/agent/mcpStatus.js";
import { sanitizeTerminalText } from "../util/text.js";
import {
  RavenHeader,
  headerValue,
  ravenHeaderPlan,
  useRavenHeaderPlan,
  type RavenHeaderPlan,
} from "./RavenHeader.js";
import { InfoPanel, sidePanelPlan, type PanelData } from "./InfoPanel.js";
import { LiveHero } from "./LiveHero.js";
import {
  sessionStat,
  stageTip,
  type ContextStat,
  type GitSummary,
} from "./sessionContext.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STATUS_LABEL_WIDTH = 17;
const STATUS_VALUE_WIDTH = 35;
const STATUS_LINE_WIDTH = STATUS_LABEL_WIDTH + STATUS_VALUE_WIDTH + 4;
const STATUS_TITLE = "System Diagnostics";

/** Live context rows rendered by `LiveHeader` (stage/badge + models). */
const LIVE_HEADER_CONTEXT_ROWS = 2;
/**
 * Columns the live view's outer `paddingX={1}` spends: around the header and
 * around the main row (cards + side panel) below it.
 */
const LIVE_VIEW_OUTER_INSET = 2;
/** `minHeight` both scrollable cards keep so their title row is never clipped. */
const CARD_MIN_ROWS = 4;
/** Rows a card's rounded border spends (top + bottom). */
const CARD_BORDER_ROWS = 2;
/** Columns a card's rounded border spends (left + right). */
const CARD_BORDER_COLUMNS = 2;
/** Columns a card's `paddingX={1}` spends. */
const CARD_PADDING_COLUMNS = 2;
/** Everything a card spends around its body, horizontally. */
const CARD_HORIZONTAL_CHROME = CARD_BORDER_COLUMNS + CARD_PADDING_COLUMNS;
/** The card's own title row, above the body. */
const CARD_TITLE_ROWS = 1;
/** Rows the composer's `marginTop={1}` spends. */
const INPUT_MARGIN_ROWS = 1;
/** Rows the composer's rounded border spends (top + bottom). */
const INPUT_BORDER_ROWS = 2;
/** Everything the composer spends around its content lines. */
const INPUT_CHROME_ROWS = INPUT_MARGIN_ROWS + INPUT_BORDER_ROWS;
/** The composer's footprint with a single content line — its budget floor. */
const INPUT_HEIGHT = INPUT_CHROME_ROWS + 1;
/**
 * Columns the composer spends before the draft text itself: this view's own
 * `paddingX={1}` (2), the composer's border (2) and `paddingX={1}` (2), and the
 * `❯ ` prompt glyph (2). A row may never widen past these (REV-3201).
 */
const COMPOSER_TEXT_INSET = 8;
/** Submitted prompts kept for ↑/↓ recall (REQ-34 / AC-34.1). */
const INPUT_HISTORY_LIMIT = 50;
const FOOTER_HEIGHT = 1;
/** The palette's own rounded border (top + bottom). */
const PALETTE_BORDER_ROWS = 2;

/**
 * Rows the header may not spend: the card floors, the input row, the footer and
 * the tallest command palette (6 content rows + border). The header's own row
 * cost is added on top when the plan is derived, so the art can never squeeze
 * the viewport (AC-29.3 / AC-28.4).
 *
 * The side panel is deliberately absent from this figure: it shares the cards'
 * row rather than claiming one of its own, so it can never take a row from the
 * composer, the palette or the footer (REQ-12).
 */
const VIEWPORT_RESERVED_ROWS =
  CARD_MIN_ROWS * 2 + INPUT_HEIGHT + FOOTER_HEIGHT + MAX_SUGGESTION_ROWS + PALETTE_BORDER_ROWS;

/**
 * How long a diagnostics probe stays good (Phase 7B / REQ-12). The side panel and
 * `/status` read the *same* probe through this window, so a wide terminal does not
 * double the git work the command does, and two `/status` presses a second apart
 * do not each spawn `git`. A *failed* probe is never cached, so a retry after a
 * failure always re-probes.
 */
const DIAGNOSTICS_TTL_MS = 3_000;
/**
 * How often the side panel refreshes the git/Muninn lines while it is on screen.
 * Slow on purpose: it is a status panel, not a monitor, and each refresh costs a
 * `git status` on the project.
 */
const DIAGNOSTICS_POLL_MS = 15_000;
/** Share of the header's second row the git/sandbox/context summary may claim. */
const HEADER_STATUS_SHARE = 0.4;
/** Columns the header keeps for the models before it shows that summary at all. */
const HEADER_MIN_MODEL_COLUMNS = 30;

function statusRow(label: string, value: string): string {
  return `│ ${label.padEnd(STATUS_LABEL_WIDTH)} ${value.padEnd(STATUS_VALUE_WIDTH)}│`;
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

/**
 * Phase 4D (REQ-2.3) — the conversation a freshly mounted view starts from.
 *
 * The engine's transcript is the source of truth for what was said, so a view that
 * mounts on a live session already in progress shows the conversation again
 * instead of an empty card. That is what makes the return from a cycle keep the
 * chat: `LiveApp` swaps this view for the cycle `Dashboard` and back, which
 * *unmounts* it, and only the transcript outlives the remount.
 *
 * Every turn is sanitized on the way in, exactly like a live `liveChat` payload:
 * a resumed or hand-made session, or an agent turn, can carry terminal escapes
 * (SEC-001) and this text goes straight to the terminal.
 */
function transcriptToChatMessages(turns: ReadonlyArray<TranscriptTurn>): ChatMessage[] {
  return turns.map((turn) => ({ role: turn.role, text: sanitizeTerminalText(turn.text) }));
}

/**
 * Phase 4D (REQ-2.3) — true when `event` only re-announces the newest turn the
 * engine had already recorded when this view hydrated, so appending it would show
 * that turn twice.
 *
 * The engine records a turn *before* it emits the event that announces it, and a
 * remount (returning from a cycle) can land between the two: the turn is then
 * hydrated from the transcript *and* announced by an event this instance is
 * already listening for. They are the same turn only while the transcript is still
 * — turn for turn — the one that was hydrated, which is why the whole snapshot is
 * compared rather than a count: an appended, dropped (the transcript is capped at
 * 100 turns) or cleared turn always invalidates it, so a genuine later message is
 * never swallowed, even one that repeats the same text (a repeat is a later
 * position). Pure — exported for the hydration tests.
 */
export function isHydratedReplay(
  transcript: ReadonlyArray<TranscriptTurn>,
  hydrated: ReadonlyArray<TranscriptTurn>,
  event: { role: ChatMessage["role"]; text: string },
): boolean {
  // Nothing was hydrated: every event is news (a `/clear`ed view included).
  if (hydrated.length === 0) return false;
  if (transcript.length !== hydrated.length) return false;
  for (let i = 0; i < transcript.length; i++) {
    const turn = transcript[i]!;
    const seen = hydrated[i]!;
    if (turn.role !== seen.role || turn.text !== seen.text) return false;
  }
  const newest = transcript[transcript.length - 1]!;
  return newest.role === event.role && sanitizeTerminalText(newest.text) === sanitizeTerminalText(event.text);
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

/**
 * Stage badge colour per stage, as a theme token rather than a literal chalk
 * name, so the accent moves with the palette (Phase 7A / REQ-12). The token is
 * resolved through `THEME` at render time.
 */
const STAGE_LABEL: Record<LiveStage, { label: string; token: ThemeToken }> = {
  refine: { label: "REFINE", token: "accent" },
  draft: { label: "DRAFT", token: "warn" },
  approve: { label: "APPROVE", token: "thinker" },
  execute: { label: "EXECUTE", token: "executor" },
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
  /**
   * The composer's draft and the caret into it (Phase 6 / REQ-6). They live in
   * one state object so every edit moves both together — and so the fast path
   * (a paste, a held key) can use a functional update that never reads a stale
   * draft. The caret is a code-unit index over the text, and every edit goes
   * through the pure helpers in `composer.ts`, so the model and what is rendered
   * can never drift apart.
   */
  const [draft, setDraft] = useState<{ text: string; cursor: number }>({
    text: "",
    cursor: 0,
  });
  const draftInput = draft.text;
  const cursor = draft.cursor;
  /** Submitted prompts of this session, oldest first (REQ-34 / AC-34.1). */
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  /** Position while recalling: `null` means "not recalling". */
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  /** The recall hint the composer shows to the right of its first row, if any. */
  const historyHint =
    inputHistory.length > 0
      ? historyIndex !== null
        ? `history ${inputHistory.length}`
        : "↑ history"
      : "";
  const historyHintWidth = historyHint.length > 0 ? historyHint.length + 1 : 0;
  /** Columns left for the draft once the chrome and the recall hint are paid for. */
  const composerTextWidth = Math.max(
    1,
    terminalSize.columns - COMPOSER_TEXT_INSET - historyHintWidth,
  );
  /** The wrapped draft (its rows and the caret's place in them). */
  const composerLayout = useMemo(
    () => layoutComposer(draftInput, cursor, composerTextWidth),
    [draftInput, cursor, composerTextWidth],
  );
  // The composer's row budget itself is derived below, next to the rest of the
  // frame budget: it is the *last* claim on the terminal's rows, so it needs the
  // header, the log tail, a pending decision and the palette to be known first
  // (REV-6001).
  const [stage, setStage] = useState<LiveStage>("refine");
  /**
   * The transcript this view hydrated from (Phase 4D). It is what tells a
   * *replayed* `liveChat` event — the turn was recorded before the remount that
   * put this instance back on screen — from a genuinely new turn: see
   * {@link isHydratedReplay}. Read once, with the state below, at mount.
   */
  const hydratedTranscript = useRef<ReadonlyArray<TranscriptTurn>>([]);
  /**
   * The conversation as rendered. It starts from the engine's transcript rather
   * than from `[]`, so returning from a cycle (which remounts this view) shows the
   * conversation again instead of an empty card (REQ-2.3); from then on it grows
   * from the `liveChat` events, exactly as before.
   */
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const transcript = live.getTranscript();
    hydratedTranscript.current = transcript;
    return transcriptToChatMessages(transcript);
  });
  const [decision, setDecision] = useState<DecisionRequest | undefined>();
  const [busy, setBusy] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState<boolean>(initialShowModelPicker);
  const [showMcpInspector, setShowMcpInspector] = useState<boolean>(false);
  const [mcpInspectorServerId, setMcpInspectorServerId] = useState<string | undefined>(undefined);
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [showSkills, setShowSkills] = useState<boolean>(false);
  const [showAgentPicker, setShowAgentPicker] = useState<boolean>(false);
  const [currentRuntimeName, setCurrentRuntimeName] = useState<string>(live.runtime.name);
  const [availableSkills, setAvailableSkills] = useState<Skill[]>(() => loadSkills(cfg.projectPath));
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatusReport | null>(null);
  /**
   * The last diagnostics probe (Phase 7B / REQ-12): what feeds the side panel's
   * git/Muninn lines and the header's git summary. `null` means "not known yet" —
   * the panel then omits those rows rather than inventing them (NFR-10).
   */
  const [diagnostics, setDiagnostics] = useState<DiagnosticsInfo | null>(null);
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
  /**
   * The in-flight/last diagnostics probe, with the time it was taken (Phase 7B /
   * REQ-12). Sharing it keeps the panel and `/status` on one `git` call per
   * {@link DIAGNOSTICS_TTL_MS}; the entry is dropped on failure so the next
   * `/status` really does retry (AC-31.2).
   */
  const diagnosticsProbe = useRef<{ at: number; probe: Promise<DiagnosticsInfo> } | null>(null);
  const loadDiagnostics = useCallback((): Promise<DiagnosticsInfo> => {
    const cached = diagnosticsProbe.current;
    if (cached && Date.now() - cached.at < DIAGNOSTICS_TTL_MS) return cached.probe;
    const probe = live.getDiagnostics();
    diagnosticsProbe.current = { at: Date.now(), probe };
    // A failed probe is not an answer: never let the cache answer the retry with
    // the same failure. (The handler also keeps the rejection from going
    // unhandled while the panel is the only reader.)
    probe.catch(() => {
      if (diagnosticsProbe.current?.probe === probe) diagnosticsProbe.current = null;
    });
    return probe;
  }, [live]);

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
        // Phase 4D (REQ-2.3): a turn that was hydrated from the transcript at mount
        // is not rendered a second time when its own event reaches this instance.
        if (isHydratedReplay(live.getTranscript(), hydratedTranscript.current, e)) return;
        setMessages((m) => [...m, { role: e.role, text: sanitizeTerminalText(e.text) }]);
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
  }, [exit, live]);

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

  // ── Frame budget (REQ-6 / REV-6001) ──────────────────────────────────────
  // Every row of the frame is claimed here, in the order it must be paid for:
  // the header, the log tail, a pending decision, the palette — and only then
  // the composer, which is the part that has to give. That is what keeps the
  // input row and the footer on screen at any terminal size, with no line ever
  // spilling over it.
  // The decision modal's own frame, reserved before the composer so a pending
  // decision can never be the reason the input row scrolls away.
  const decisionHeight = decision ? 6 : 0;

  let maxLogsAllowed = 0;
  if (terminalSize.rows >= 36) maxLogsAllowed = 4;
  else if (terminalSize.rows >= 30) maxLogsAllowed = 3;
  else if (terminalSize.rows >= 25) maxLogsAllowed = 2;
  else if (terminalSize.rows >= 20) maxLogsAllowed = 1;
  // While the palette or the agent picker is open it owns the row budget: the log
  // tail steps aside so neither can push the input row or the frame off-screen
  // (AC-28.4 / REV-303).
  if (suggestionsOpen || showAgentPicker) maxLogsAllowed = 0;

  const visibleLogs = logs.slice(-maxLogsAllowed);
  const logsHeight = visibleLogs.length > 0 ? visibleLogs.length + 3 : 0;

  // The header's own cost with the composer at its floor. Growing the composer
  // only ever *raises* the reserved-rows figure the art has to fit under, so the
  // header can only get shorter — this is the worst case the composer pays for.
  const headerFloorHeight = useMemo(
    () =>
      ravenHeaderPlan({
        columns: terminalSize.columns,
        rows: terminalSize.rows,
        contextRows: LIVE_HEADER_CONTEXT_ROWS,
        reservedRows: VIEWPORT_RESERVED_ROWS,
        outerInset: LIVE_VIEW_OUTER_INSET,
      }).height,
    [terminalSize.columns, terminalSize.rows],
  );
  // The palette's tallest possible cost while it is open. It is reserved in full
  // so the composer can never claim rows the palette needs: the palette's own
  // height is derived from the *real* input height below, so it absorbs whatever
  // the composer grows by and the reservation is only ever an upper bound.
  const paletteReservedWhileOpen = suggestionsOpen
    ? MAX_SUGGESTION_ROWS + PALETTE_BORDER_ROWS
    : 0;
  /**
   * Rows the frame needs however tall the composer gets: the header, the
   * composer's chrome (margin + border), the footer, the visible log tail, a
   * pending decision, the open palette, and one {@link CARD_MIN_ROWS} floor for
   * the conversation — a card is never shorter than its floor, because Yoga
   * applies `minHeight` over `height` (REV-6001).
   */
  const composerShellRows =
    headerFloorHeight +
    INPUT_CHROME_ROWS +
    FOOTER_HEIGHT +
    logsHeight +
    decisionHeight +
    paletteReservedWhileOpen +
    CARD_MIN_ROWS;
  /**
   * Content rows the composer claims: the wrapped draft, floored at 1, capped at
   * its scrolling limit and by the rows the shell above actually leaves — so a
   * short terminal keeps the composer at its floor instead of pushing the frame
   * off-screen (REQ-6 / REV-6001).
   */
  const composerRows = composerRowBudget(
    terminalSize.rows,
    composerShellRows,
    composerLayout.rows.length,
  );
  /** The composer's real row cost, which the layout budget below pays for. */
  const inputHeight = INPUT_CHROME_ROWS + composerRows;

  // The raven header's real row cost (raven mark + live context, or the
  // plain-text fallback) comes from the same plan the component renders, so the
  // layout budget can never disagree with the header (REQ-29 / AC-29.3).
  // `outerInset: 2` is this view's own `paddingX={1}` around the header.
  // The composer's growth is added to the viewport floor so the header keeps
  // degrading instead of squeezing the conversation (AC-29.3).
  const headerPlan = useRavenHeaderPlan(
    LIVE_HEADER_CONTEXT_ROWS,
    VIEWPORT_RESERVED_ROWS + (composerRows - 1),
    terminalSize,
    LIVE_VIEW_OUTER_INSET,
  );
  const headerHeight = headerPlan.height;
  /** Rows the palette must leave for the header, cards, input and footer. */
  const paletteReservedRows =
    headerHeight + inputHeight + FOOTER_HEIGHT + CARD_MIN_ROWS * 2 + PALETTE_BORDER_ROWS;

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
    const next = command.takesArgs ? `${command.id} ` : command.id;
    setDraft({ text: next, cursor: next.length });
    setSuggestionIndex(0);
    setHistoryIndex(null);
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

  /**
   * Map a keypress to a decision (REQ-37 / AC-37.3). For a clarifying question the
   * *answer* is the chosen option's label — a digit picks that option directly, and
   * `c`/Enter accepts the recommended one — rather than only "accept or reject".
   */
  const resolveDecisionKey = (
    input: string,
    key?: { escape?: boolean; return?: boolean; tab?: boolean },
  ): { choice: DecisionChoice; answers?: string[] } | undefined => {
    const c = input.toLowerCase();
    // Never match on `input === ""`: Ink sends it for *every* non-alphanumeric key
    // — including Escape — so that silently answered with the first option
    // (REV-002). Decision keys are matched explicitly instead.
    if (decision?.kind === "permission") {
      if (c === "a") return { choice: "continue" };
      if (c === "o") return { choice: "retry" };
      if (c === "d") return { choice: "deny" };
      return undefined;
    }
    if (decision?.kind === "question") {
      if (key?.escape) return { choice: "abort" };
      if (c === "d" || c === "n") return { choice: "deny" };
      const options = decision.questionItems?.[0]?.options ?? [];
      // A digit selects that option verbatim; Enter accepts the recommended one.
      const picked = /^[1-9]$/.test(c) ? options[Number(c) - 1] : undefined;
      if (picked) return { choice: "continue", answers: [picked.label] };
      if (c === "c" || c === "a" || c === "y" || key?.return) {
        return { choice: "continue", answers: options[0] ? [options[0].label] : [] };
      }
      return undefined;
    }
    if (key?.escape) return { choice: "abort" };
    if (key?.return || c === "c") return { choice: "continue" };
    if (c === "r") return { choice: "retry" };
    if (c === "a") return { choice: "abort" };
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
   * Switch the active runtime (REQ-33). Shared by `/agent <id>` and the picker so
   * both report the same busy/✓/⚠ feedback and never crash the view on failure.
   */
  const switchAgent = async (id: string): Promise<boolean> => {
    if (id === live.runtime.id) {
      emitSystem(okFeedback(`Already using ${sanitizeTerminalText(live.runtime.name)}.`));
      return true;
    }
    setBusy(true);
    emitSystem(busyFeedback(`Switching runtime to "${sanitizeTerminalText(id)}"…`));
    try {
      const newRuntime = await live.switchRuntime(id);
      setCurrentRuntimeName(newRuntime.name);
      emitSystem(okFeedback(`Runtime switched to ${sanitizeTerminalText(newRuntime.name)}.`));
      return true;
    } catch (err) {
      emitSystem(failureFeedback("Runtime switch failed", NEXT_STEP.runtimeSwitch, err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Dispatch the draft input. `override` lets the palette submit a command the
   * user accepted without retyping it; argument parsing stays per-command below.
   */
  const submit = async (override?: string): Promise<void> => {
    const text = (override ?? draftInput).trim();
    setDraft({ text: "", cursor: 0 });
    setHistoryIndex(null);
    if (!text) return;
    // Remember what the user actually asked for. Slash commands are not prompts,
    // and an immediately-repeated prompt is not stored twice (de-duplication is
    // consecutive only: A, B, A keeps both A entries).
    if (!text.startsWith("/")) {
      setInputHistory((h) =>
        h[h.length - 1] === text ? h : [...h, text].slice(-INPUT_HISTORY_LIMIT),
      );
    }
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
          // Same probe the side panel reads (Phase 7B / REQ-12): one `git` call
          // serves both, and what `/status` prints can never contradict the panel.
          const diag = await loadDiagnostics();
          setDiagnostics(diag);
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
          statusRow("Methodology:", sanitizeTerminalText(profileSpec(cfg.profile).name).slice(0, STATUS_VALUE_WIDTH)),
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
        // Phase 4D (REQ-2.3): the view rehydrates from the engine transcript
        // whenever it mounts (returning from a cycle remounts it), so clearing only
        // the render state would hand the user back the turns they just cleared. The
        // engine's copy goes with it — and the hydrated snapshot with it, so the next
        // turns are never taken for a replay of what was cleared.
        live.clearTranscript();
        hydratedTranscript.current = [];
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
          // AC-33.1: selectable, not memorised — the picker replaces the old list.
          setShowAgentPicker(true);
          return;
        }
        if (isAgentTarget(args)) {
          await switchAgent(args);
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
  // `headerPlan`/`paletteReservedRows`, the composer's row budget and the log
  // tail are all derived in the frame-budget block at the top of the component.
  // The palette is height-bounded (≤6 content rows + border) and part of the budget.
  const suggestionHeight = suggestionOverlayHeight(suggestionRows);

  // Floor at 1 (not 8) so the frame still fits on very short terminals now that
  // the palette also draws rows; the cards shrink with it (AC-28.4). Everything
  // subtracted here is already paid for by `composerRows`, so the cards keep at
  // least their `CARD_MIN_ROWS` floor and the input row and the footer always
  // land inside the terminal (REV-6001).
  const availableHeight = Math.max(
    1,
    terminalSize.rows -
      headerHeight -
      inputHeight -
      FOOTER_HEIGHT -
      logsHeight -
      decisionHeight -
      suggestionHeight,
  );

  // The agent-output panel is adaptive (REQ-35 / AC-35.2): most frontier models
  // no longer expose reasoning, so an empty bordered box would just steal rows
  // from the conversation. Only *real* content shows it — a blank line (which the
  // stream buffer yields for any phase that emitted nothing) does not count, and
  // nor does "work in flight", so the panel is never an empty box.
  const hasStreamContent = streamLines.some((line) => line.trim().length > 0);
  const showStreamPanel = hasStreamContent;
  const chatHeight = showStreamPanel
    ? Math.max(1, Math.floor(availableHeight * 0.58))
    : Math.max(1, availableHeight);
  const streamHeight = showStreamPanel ? Math.max(1, availableHeight - chatHeight) : 0;

  // ── Side panel (REQ-12) ──────────────────────────────────────────────────
  // The panel shares the row the cards live in, so it changes no frame budget: the
  // conversation keeps `cardsWidth` columns and the panel takes the rest, and on
  // anything narrow (or short, or with the palette open) `sidePanelPlan` says "no
  // panel" and the row is exactly what it was before.
  const panelPlan = useMemo(
    () =>
      sidePanelPlan({
        columns: terminalSize.columns,
        availableHeight,
        inset: LIVE_VIEW_OUTER_INSET,
      }),
    [terminalSize.columns, availableHeight],
  );

  // The panel's git/Muninn lines refresh on a slow timer while it is on screen —
  // and only then: a narrow terminal pays for no probe at all (REQ-12).
  useEffect(() => {
    if (!panelPlan.visible) return;
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const info = await loadDiagnostics();
        if (active) setDiagnostics(info);
      } catch {
        // A failed probe is reported by `/status`; the panel just drops the rows
        // it cannot fill instead of showing stale or invented values (NFR-10).
        if (active) setDiagnostics(null);
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), DIAGNOSTICS_POLL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [panelPlan.visible, loadDiagnostics]);

  // ── Live status summaries (REQ-12) ───────────────────────────────────────
  const spinner = SPINNER_FRAMES[spinnerIndex] ?? "⠋";
  /**
   * The conversation the live prompt carries, counted from the turns on screen.
   * System notices are the console's own feedback, not conversation, so they are
   * not counted — and an empty conversation reports nothing at all, rather than a
   * fabricated zero (NFR-10).
   */
  const sessionContext = useMemo<ContextStat>(() => {
    let turns = 0;
    let chars = 0;
    for (const message of messages) {
      if (message.role === "system") continue;
      turns += 1;
      chars += message.text.length;
    }
    return { turns, chars };
  }, [messages]);
  /** The working tree as last probed, or `null` while nothing is known yet. */
  const gitSummary: GitSummary | null = diagnostics
    ? {
        branch: diagnostics.gitBranch,
        clean: diagnostics.gitClean,
        sandbox: diagnostics.worktreeSandbox,
      }
    : null;
  /** The attributed MCP badge, shared by the header and the panel (AC-32.4). */
  const mcpBadge = useMemo(
    () => formatMcpBadge(mcpStatus, live.runtime.id),
    [mcpStatus, live.runtime],
  );
  /** The one reminder the panel and the hero's tip box show for this stage. */
  const tip = stageTip(stage);
  const panelData: PanelData = {
    stageLabel: STAGE_LABEL[stage].label,
    stageToken: STAGE_LABEL[stage].token,
    busy,
    spinner,
    agentName: currentRuntimeName,
    thinker: currentThinker,
    executor: currentExecutor,
    mcpText: mcpBadge.text,
    mcpToken: mcpStatusToken(mcpBadge.status),
    git: gitSummary,
    memory: diagnostics?.memoryStats ?? null,
    context: sessionContext,
    tip,
  };
  /** Columns the cards column keeps beside the panel (all of them without one). */
  const cardsWidth = panelPlan.cardsWidth;

  // Never leave focus on a card that is not rendered.
  useEffect(() => {
    if (!showStreamPanel && focusCard === "stream") setFocusCard("chat");
  }, [showStreamPanel, focusCard]);

  const visibleChatLinesCount = Math.max(1, chatHeight - 3);
  const visibleStreamLinesCount = Math.max(1, streamHeight - 3);

  const maxChatScroll = Math.max(0, formattedChatLines.length - visibleChatLinesCount);
  const maxStreamScroll = Math.max(0, streamLines.length - visibleStreamLinesCount);

  useInput((input, key) => {
    if (showModelPicker || showMcpInspector || showHelp || showSkills || showAgentPicker) {
      return;
    }
    if (decision) {
      const resolved = resolveDecisionKey(input, key);
      if (resolved) {
        live.resolveDecision(resolved.choice, resolved.answers);
      } else if (decision.questionItems?.length) {
        // Never swallow a keypress silently on a question (AC-37.3).
        const count = decision.questionItems[0]?.options?.length ?? 0;
        events.emit("liveChat", {
          role: "system",
          text:
            count > 0
              ? `Press 1-${count} to pick an option, Enter for the recommended one, or d to skip.`
              : "Press Enter to accept, or d to skip this question.",
        });
      }
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
      // Focus only has meaning while both cards are mounted (REV-3207).
      if (showStreamPanel) setFocusCard((f) => (f === "chat" ? "stream" : "chat"));
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

    // Composer history (REQ-34 / AC-34.1): ↑ recalls the previous submission when
    // the draft is empty (or while already recalling); ↓ walks forward and ends at
    // the empty draft. PageUp/Down and the focused stream card still scroll.
    if (inputEnabled) {
      // The focused stream card keeps the arrow keys for scrolling (AC-34.3):
      // recall lives on the composer, which is the only place you type.
      const canRecall = (draftInput === "" && focusCard === "chat") || historyIndex !== null;
      if (key.upArrow && canRecall && inputHistory.length > 0) {
        const next = historyIndex === null ? inputHistory.length - 1 : Math.max(0, historyIndex - 1);
        const recalled = inputHistory[next] ?? "";
        setHistoryIndex(next);
        setDraft({ text: recalled, cursor: recalled.length });
        return;
      }
      if (key.downArrow && historyIndex !== null) {
        const next = historyIndex + 1;
        const recalled = next >= inputHistory.length ? "" : inputHistory[next] ?? "";
        setHistoryIndex(next >= inputHistory.length ? null : next);
        setDraft({ text: recalled, cursor: recalled.length });
        return;
      }
    }

    // Multi-line caret (REQ-6): with a draft that wraps onto several visual rows,
    // ↑/↓ move the caret between them. A single-row draft has nowhere to move, so
    // the key is swallowed — the terminal still never scrolls (AC-21.4).
    if (inputEnabled && focusCard === "chat" && draftInput !== "" && (key.upArrow || key.downArrow)) {
      setDraft((current) => {
        const layout = layoutComposer(current.text, current.cursor, composerTextWidth);
        if (layout.rows.length <= 1) return current;
        const target = key.upArrow
          ? Math.max(0, layout.cursorRow - 1)
          : Math.min(layout.rows.length - 1, layout.cursorRow + 1);
        if (target === layout.cursorRow) return current;
        return { text: current.text, cursor: cursorIndexAtRow(layout, target, layout.cursorCol) };
      });
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

    // With the composer disabled (busy / decision) nothing edits the draft; `q` on
    // an empty draft is the one remaining shortcut, exactly as before.
    if (!inputEnabled) {
      if (input === "q" && draftInput === "") {
        live.requestAbort();
        failSession(new LiveAbortError());
      }
      return;
    }

    // Caret movement and in-place editing (REQ-6): ←/→ move by character, with
    // Ctrl/⌥ for whole words; Home/End jump to the ends; Backspace and Delete act
    // on the caret; printable text is inserted where the caret is. Every update is
    // functional, so a held key or a pasted block can never read a stale draft.
    if (key.leftArrow) {
      setHistoryIndex(null);
      setDraft((current) => ({
        text: current.text,
        cursor: moveCursorLeft(current.text, current.cursor, key.ctrl || key.meta),
      }));
      return;
    }
    if (key.rightArrow) {
      setHistoryIndex(null);
      setDraft((current) => ({
        text: current.text,
        cursor: moveCursorRight(current.text, current.cursor, key.ctrl || key.meta),
      }));
      return;
    }
    // Ctrl/⌥+Backspace and Ctrl/⌥+Delete delete a whole word (REV-6006). They are
    // matched *before* the Ctrl guard below, which used to swallow the key; plain
    // Backspace/Delete arrive without the flag, so nothing else changes. A
    // terminal that sends Ctrl+Backspace as ^H (0x08) is reported by Ink as a
    // plain Backspace and keeps deleting one character.
    if ((key.ctrl || key.meta) && (key.backspace || key.delete)) {
      setHistoryIndex(null);
      setDraft((current) =>
        key.backspace
          ? deleteWordBefore(current.text, current.cursor)
          : deleteWordAfter(current.text, current.cursor),
      );
      return;
    }
    // Any other Ctrl/Meta chord is a shortcut, never draft text.
    if (key.ctrl || key.meta) {
      return;
    }
    // Home/End act on the caret's own *visual* row, so a wrapped draft can be
    // edited row by row (REV-6004); a one-row draft behaves exactly as before.
    if (key.home) {
      setHistoryIndex(null);
      setDraft((current) => {
        const layout = layoutComposer(current.text, current.cursor, composerTextWidth);
        return { text: current.text, cursor: caretRowStart(layout) };
      });
      return;
    }
    if (key.end) {
      setHistoryIndex(null);
      setDraft((current) => {
        const layout = layoutComposer(current.text, current.cursor, composerTextWidth);
        return { text: current.text, cursor: caretRowEnd(layout) };
      });
      return;
    }
    if (key.return) {
      void submit();
      return;
    }
    if (key.delete) {
      setHistoryIndex(null);
      setDraft((current) => deleteAt(current.text, current.cursor));
      return;
    }
    if (key.backspace) {
      setHistoryIndex(null);
      setDraft((current) => deleteBefore(current.text, current.cursor));
      return;
    }
    const sanitized = sanitizeComposerInput(input);
    if (sanitized) {
      setHistoryIndex(null);
      setDraft((current) => insertAt(current.text, current.cursor, sanitized));
    }
  });

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
        thinker={currentThinker}
        executor={currentExecutor}
        mcpBadge={mcpBadge}
        git={gitSummary}
        context={sessionContext}
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
      ) : showAgentPicker ? (
        <AgentPickerModal
          currentAgentId={live.runtime.id}
          onSelect={(id) => {
            void (async () => {
              // Keep the picker open when the switch fails, so the user can pick a
              // different runtime without re-typing /agent (plan Iteration 31).
              if (await switchAgent(id)) setShowAgentPicker(false);
            })();
          }}
          onCancel={() => setShowAgentPicker(false)}
        />
      ) : (
        // The main row (REQ-12): the cards keep `cardsWidth` columns and the side
        // panel takes the rest. Without a panel `cardsWidth` is the whole content
        // width, so this row is pixel-for-pixel what the column used to be.
        <Box flexDirection="row" width={terminalSize.columns - LIVE_VIEW_OUTER_INSET}>
          <Box flexDirection="column" width={cardsWidth}>
            <ScrollableChatCard
              lines={visibleChatLines}
              totalLines={formattedChatLines.length}
              scrollOffset={chatScroll}
              maxScroll={maxChatScroll}
              isFocused={focusCard === "chat"}
              busy={busy}
              spinner={spinner}
              height={chatHeight}
              width={cardsWidth}
              // One home per tip: the panel already carries it on a wide
              // terminal, so the hero's tip box only fills that role when there
              // is no panel beside the conversation.
              tip={panelPlan.visible ? "" : tip}
            />

            {showStreamPanel && (
              <ScrollableStreamCard
                lines={visibleStreamLines}
                totalLines={streamLines.length}
                scrollOffset={streamScroll}
                chars={streamChars}
                isFocused={focusCard === "stream"}
                spinner={spinner}
                busy={busy}
                height={streamHeight}
                width={cardsWidth}
              />
            )}
          </Box>

          <InfoPanel plan={panelPlan} data={panelData} />
        </Box>
      )}

      {visibleLogs.length > 0 && <LogsCard logs={visibleLogs} />}

      {decision ? <DecisionModal req={decision} /> : null}

      {!showModelPicker && !showMcpInspector && !showHelp && !showSkills && !showAgentPicker && (
        <>
          <ChatInputRow
            value={draftInput}
            enabled={inputEnabled}
            placeholder="Message...  type / for commands · /draft when ready · /mcp to inspect"
            historyHint={historyHint}
            width={composerTextWidth}
            rows={composerLayout.rows}
            cursorRow={composerLayout.cursorRow}
            cursorCol={composerLayout.cursorCol}
            visibleRows={composerRows}
          />
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
                <Text color={THEME.muted} wrap="truncate">[↑/↓] Select · [Tab] Accept · [Enter] Run · [Esc] Dismiss</Text>
              ) : (
                <Text color={THEME.muted} wrap="truncate">[Tab] Focus · [PgUp/Dn] Scroll · [↑/↓] History · [Enter] Send · / commands</Text>
              )}
            </Box>
            <Box flexShrink={0}>
              <Text color={THEME.muted} wrap="truncate">stage: {STAGE_LABEL[stage].label}</Text>
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
  thinker,
  executor,
  mcpBadge,
  git,
  context,
}: {
  plan: RavenHeaderPlan;
  stage: LiveStage;
  cfg: RunConfig;
  spinner: string;
  runtimeName: string;
  thinker: string;
  executor: string;
  /** The attributed MCP badge (already resolved by the caller, AC-32.4). */
  mcpBadge: McpBadge;
  /** The working tree as last probed, or `null` while nothing is known. */
  git: GitSummary | null;
  /** The conversation's own size, for the header's context counter. */
  context: ContextStat;
}) {
  const s = STAGE_LABEL[stage];
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

  // Row 2 (REQ-12): the models on the left, the session's own status on the
  // right — branch and whether the tree is dirty, the worktree sandbox, and the
  // conversation counter. The status cell is whole-or-nothing: it only claims
  // columns while the models keep `HEADER_MIN_MODEL_COLUMNS` of their own, so a
  // squeezed row loses the summary rather than the model names, and it is
  // clamped to its share of the row so it can never wrap.
  const statusRoom = Math.min(
    Math.max(0, rowWidth - HEADER_MIN_MODEL_COLUMNS),
    Math.floor(rowWidth * HEADER_STATUS_SHARE),
  );
  const statusText = statusRoom > 0 ? sessionStat(git, context, statusRoom) : "";
  const modelsWidth = rowWidth - (statusText.length > 0 ? statusText.length + gap : 0);
  const modelLabels = "thinker: ".length + "executor: ".length;
  const modelRoom = modelsWidth - gap - modelLabels - 2;
  const bothModels = modelRoom >= 16;
  const thinkerBudget = Math.max(4, bothModels ? Math.ceil(modelRoom / 2) : modelsWidth - "thinker: ".length - gap);
  const safeThinker = headerValue(thinker, thinkerBudget);
  const executorBudget = modelRoom - safeThinker.length;
  const safeExecutor = bothModels && executorBudget >= 4 ? headerValue(executor, executorBudget) : "";

  return (
    <RavenHeader
      plan={plan}
      suffix="LIVE"
      rows={[
        [
          <Text key="stage" bold color={THEME[s.token]} wrap="truncate">
            {stageBadge}
          </Text>,
          <>
            <Text key="mcp" color={mcpStatusToken(mcpBadge.status)} wrap="truncate">
              {mcpText}
            </Text>
            {runtimeValue ? (
              <>
                <Text key="runtime-label" color={THEME.muted} wrap="truncate">
                  {runtimeLabel}
                </Text>
                <Text key="runtime" color={THEME.warn} wrap="truncate">
                  {runtimeValue}
                </Text>
              </>
            ) : null}
            {projectValue ? (
              <Text key="project" color={THEME.muted} wrap="truncate">
                {`${sep}${projectValue}`}
              </Text>
            ) : null}
          </>,
        ],
        [
          <>
            <Text color={THEME.muted}>thinker: </Text>
            <Text color={THEME.thinker} wrap="truncate">
              {safeThinker}
            </Text>
          </>,
          ...(safeExecutor
            ? [
                <>
                  <Text color={THEME.muted}>executor: </Text>
                  <Text color={THEME.executor} wrap="truncate">
                    {safeExecutor}
                  </Text>
                </>,
              ]
            : []),
          ...(statusText
            ? [
                <Text key="status" color={THEME.muted} wrap="truncate">
                  {statusText}
                </Text>,
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
  width,
  tip,
}: {
  lines: FormattedLine[];
  totalLines: number;
  scrollOffset: number;
  maxScroll: number;
  isFocused: boolean;
  busy: boolean;
  spinner: string;
  height: number;
  /** Columns the card occupies (the panel takes the rest of the row). */
  width: number;
  /** The stage's reminder, shown in the hero's tip box while the card is empty. */
  tip: string;
}) {
  // Body rows actually available inside the fixed-height card: the effective
  // height (Yoga applies `minHeight` over `height`) minus the border and the
  // title row. The hero is sliced to it, so it can never push the frame past the
  // terminal height on a short terminal (AC-31.3).
  const bodyRows = Math.max(
    0,
    Math.max(height, CARD_MIN_ROWS) - CARD_BORDER_ROWS - CARD_TITLE_ROWS,
  );
  /** Columns the body really has — the hero's own width budget (REQ-12). */
  const bodyColumns = Math.max(0, width - CARD_HORIZONTAL_CHROME);
  return (
    <Box
      borderStyle="round"
      borderColor={isFocused ? THEME.borderFocus : THEME.border}
      flexDirection="column"
      paddingX={1}
      height={height}
      width={width}
      minHeight={CARD_MIN_ROWS}
    >
      {/* The title row is exactly one clipped row: with the side panel beside it
          the card can be much narrower than the terminal, and a wrapped title
          would cost a body row the layout never reserved (REV-6001). */}
      <Box justifyContent="space-between" height={CARD_TITLE_ROWS} overflow="hidden">
        <Text bold color={isFocused ? THEME.borderFocus : THEME.accent} wrap="truncate">
          Conversation {isFocused ? "● [Focused]" : "○ [Tab to focus]"}
        </Text>
        <Box flexShrink={1} overflow="hidden">
          {maxScroll > 0 && (
            <Text color={THEME.muted} wrap="truncate">
              {scrollOffset > 0 ? `▲ +${scrollOffset} up ` : "▼ bottom "}
              ({totalLines} lines){" "}
            </Text>
          )}
          {busy && <Text color={THEME.warn} wrap="truncate">{spinner} thinking...</Text>}
        </Box>
      </Box>
      {lines.length === 0 ? (
        <LiveHero rows={bodyRows} columns={bodyColumns} tip={tip} />
      ) : (
        lines.map((l) => {
          if (l.type === "blank") {
            return <Text key={l.id}> </Text>;
          }
          if (l.type === "system") {
            return (
              <Box key={l.id}>
                <MarkdownLine text={l.text} defaultColor={THEME.system} wrap="wrap" />
              </Box>
            );
          }
          if (l.type === "user_header") {
            return (
              <Text key={l.id} bold color={THEME.ok}>
                {l.text}
              </Text>
            );
          }
          if (l.type === "user_body") {
            return (
              <Box key={l.id} paddingLeft={2}>
                <MarkdownLine text={l.text} defaultColor={THEME.text} wrap="wrap" />
              </Box>
            );
          }
          if (l.type === "assistant_header") {
            return (
              <Text key={l.id} bold color={THEME.accentStrong}>
                {l.text}
              </Text>
            );
          }
          return (
            <Box key={l.id} paddingLeft={2}>
              <MarkdownLine text={l.text} defaultColor={THEME.text} wrap="wrap" />
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
  width,
}: {
  lines: string[];
  totalLines: number;
  scrollOffset: number;
  chars: number;
  isFocused: boolean;
  spinner: string;
  busy: boolean;
  height: number;
  /** Columns the card occupies (the panel takes the rest of the row). */
  width: number;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={isFocused ? THEME.borderFocus : THEME.border}
      flexDirection="column"
      paddingX={1}
      height={height}
      width={width}
      minHeight={CARD_MIN_ROWS}
    >
      {/* One clipped title row, exactly like the conversation card: beside the
          side panel the card is narrower than the terminal and a wrapped title
          would steal a body row from the stream. */}
      <Box justifyContent="space-between" height={CARD_TITLE_ROWS} overflow="hidden">
        <Text bold color={isFocused ? THEME.borderFocus : THEME.accent} wrap="truncate">
          THINKING & LIVE AGENT STREAM {isFocused ? "● [Focused]" : "○ [Tab to focus]"}
        </Text>
        <Box flexShrink={1} overflow="hidden">
          {chars > 0 && (
            <Text color={THEME.muted} wrap="truncate">
              {(chars / 1024).toFixed(1)} KB{" "}
            </Text>
          )}
          {busy && <Text color={THEME.warn} wrap="truncate">{spinner} streaming </Text>}
        </Box>
      </Box>
      {lines.length === 0 ? (
        <Box justifyContent="center" marginY={0}>
          <Text color={THEME.muted}>Real-time thinking and agent output will stream here while the model runs.</Text>
        </Box>
      ) : (
        lines.map((l, i) => (
          <MarkdownLine
            key={i}
            text={l}
            defaultColor={l.startsWith("⚡") ? THEME.warn : l.startsWith("✓") ? THEME.ok : THEME.muted}
            wrap="truncate"
          />
        ))
      )}
    </Box>
  );
}

/**
 * The composer (REQ-34 / AC-34.2, REQ-6): deliberately the most prominent row in
 * the view — its own accent border, a clear prompt glyph, a visible caret and,
 * while it is empty, a hint that the previous inputs can be recalled.
 *
 * Phase 6 turns it into a real editor: the draft soft-wraps onto as many content
 * rows as the frame can afford it (`height` grows with them, pushing the rest of
 * the frame up), the caret block is painted on its own row, and past the cap the
 * box scrolls so the caret's row is always the one on screen.
 */
function ChatInputRow({
  value,
  enabled,
  placeholder,
  historyHint = "",
  width,
  rows,
  cursorRow,
  cursorCol,
  visibleRows,
}: {
  value: string;
  enabled: boolean;
  placeholder: string;
  /** Recall hint shown beside the first row (`""` hides it). */
  historyHint?: string;
  /** Columns one draft row may occupy, caret included. */
  width: number;
  /** Every wrapped row of the draft. */
  rows: string[];
  /** Absolute row the caret sits on. */
  cursorRow: number;
  /** Column the caret sits at within its row. */
  cursorCol: number;
  /** Content rows the box shows (the composer's budget); the rest scroll. */
  visibleRows: number;
}) {
  const accent: string | undefined = enabled ? THEME.executor : THEME.border;
  const contentRows = Math.max(1, visibleRows);
  const scroll = composerScroll(cursorRow, rows.length, contentRows);
  const window = rows.slice(scroll, scroll + contentRows);
  return (
    // height/overflow/border keep the promise `inputHeight` makes: the box is
    // `visibleRows` content rows plus its two border rows, whatever the text or
    // the recall hint length — nothing here may widen or lengthen past that.
    <Box
      marginTop={INPUT_MARGIN_ROWS}
      borderStyle="round"
      borderColor={accent}
      paddingX={1}
      flexDirection="row"
      justifyContent="space-between"
      height={contentRows + INPUT_BORDER_ROWS}
      overflow="hidden"
    >
      <Box flexDirection="column" flexShrink={1} flexGrow={1} overflow="hidden">
        {value.length > 0 ? (
          window.map((line, index) => {
            const row = scroll + index;
            return (
              <Box key={row} flexDirection="row" height={1}>
                <Text bold color={accent}>{index === 0 ? "❯ " : "  "}</Text>
                <CursorLine
                  line={line}
                  width={width}
                  cursor={row === cursorRow ? cursorCol : null}
                  color={accent}
                />
              </Box>
            );
          })
        ) : (
          <Box flexDirection="row" height={1}>
            <Text bold color={accent}>{enabled ? "❯ " : "· "}</Text>
            <Text color={THEME.muted} wrap="truncate">
              {placeholder}
            </Text>
          </Box>
        )}
      </Box>
      {historyHint.length > 0 && (
        <Box flexShrink={0}>
          <Text color={THEME.muted}>{" "}{historyHint}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * One composer row with the caret painted in it (REQ-6). The caret is a reverse
 * block that costs exactly one column, so a row can never render wider than
 * `width` and the frame stays inside the terminal. When the row has no free
 * column left the block is painted *over* the character it sits on — the
 * character stays readable and is never dropped to make room for a glyph
 * (REV-6002).
 */
function CursorLine({
  line,
  width,
  cursor,
  color,
}: {
  line: string;
  width: number;
  /** Caret column on this row, or `null` when the caret is elsewhere. */
  cursor: number | null;
  color: string | undefined;
}) {
  if (cursor === null || width <= 0) {
    return (
      <Text color={THEME.text} wrap="truncate">
        {line.slice(0, Math.max(0, width))}
      </Text>
    );
  }
  // `before` + caret cell + `tail` is at most `width` wide and spells the whole
  // row out, so the caret can neither widen the row past the composer's column
  // budget nor hide what it sits next to (see `cursorLineParts`).
  const { before, caret, tail } = cursorLineParts(line, cursor, width);
  return (
    <Text color={THEME.text} wrap="truncate">
      {before}
      <Text inverse color={color}>{caret}</Text>
      {tail}
    </Text>
  );
}
