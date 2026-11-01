import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CycleEngine } from "../engine/cycle";
import type { RunConfig } from "../config";
import { events } from "../engine/engineEvents";
import type { PhaseResult, DecisionRequest, DecisionChoice, Verdict } from "../engine/types";
import { formatDurationSec, formatDurationTerse, formatUsage, verdictIcon, verdictToken } from "../format";
import { MarkdownBlock } from "./markdown";
import { useTerminalSize } from "./useTerminalSize";
import type { PromotionRecord } from "../state/schema";
import { phasesForProfile, type ProfileName } from "../engine/profiles";
import { sanitizeTerminalText } from "../util/text";
import { THEME, mcpStatusToken } from "./theme.js";
import { TWO_RAVENS } from "../brand.js";
import { idleAgentPhrase } from "./feedback.js";
import { STATUS_GLYPHS } from "./glyphs.js";
import { Card, cardChrome } from "./Card.js";
import { DECISION_MIN_ROWS, decisionModalHeight } from "./decision.js";
import { DecisionModal } from "./DecisionModal.js";
import type { McpStatusReport } from "../engine/agent/types.js";
import {
  MCP_STATUS_POLL_TIMEOUT_MS,
  fetchMcpStatusWithTimeout,
  formatMcpBadge,
} from "../engine/agent/mcpStatus.js";
import {
  RavenHeader,
  headerValue,
  useRavenHeaderPlan,
  type RavenHeaderPlan,
} from "./RavenHeader.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Footer row (always reserved). */
const FOOTER_HEIGHT = 1;
/** Columns the dashboard's outer `paddingX={1}` spends around the header. */
const VIEW_OUTER_INSET = 2;
/** The pipeline/stream cards' floor, so their title row is never clipped. */
const MIDDLE_MIN_ROWS = 6;
/** Tallest log tail the dashboard renders, before its tertiary title row. */
const LOGS_MAX_ENTRIES = 5;
/** The log tail's full row cost, imported from the one chrome table. */
const LOGS_MAX_ROWS = LOGS_MAX_ENTRIES + cardChrome("tertiary").rows;
/** The last-report pill. */
const REPORT_HEIGHT = 1;
/** The promotion-failure notice row, shown only when an integration failed. */
const PROMOTION_HEIGHT = 1;

/**
 * Rows the header may not spend: the middle cards' floor, the footer, the
 * tallest log tail and the decision/report pills. The header's own row cost is
 * added when the plan is derived (REQ-29 / AC-29.3).
 */
const VIEWPORT_RESERVED_ROWS =
  MIDDLE_MIN_ROWS +
  FOOTER_HEIGHT +
  LOGS_MAX_ROWS +
  decisionModalHeight() +
  REPORT_HEIGHT +
  PROMOTION_HEIGHT;

interface PhaseStatus {
  verdict?: Verdict;
  attempt: number;
  durationMs?: number;
  startedAt?: number;
}

interface UiState {
  currentIteration: number;
  totalIterations: number;
  iterationTitle: string;
  iterationModules: string[];
  currentPhase: string;
  phaseStartedAt: number;
  runStartedAt: number;
  paused: boolean;
  phases: Record<string, PhaseStatus>;
  streamTotalChars: number;
  logs: Array<{ level: "info" | "warn" | "error"; message: string; timestamp: string }>;
  decision?: DecisionRequest;
  lastReport?: PhaseResult;
  /** Outcome of integrating the iteration's sandbox (ADR-48); shown when it failed. */
  promotion?: PromotionRecord;
  verbose: boolean;
}

function renderProgressBar(current: number, total: number, width = 16): string {
  if (total <= 0) return "[]";
  const pct = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${Math.round(pct * 100)}%`;
}

export function Dashboard({
  engine,
  cfg,
  autoExit = true,
}: {
  engine: CycleEngine;
  cfg: RunConfig;
  autoExit?: boolean;
}) {
  const { exit } = useApp();
  const terminalSize = useTerminalSize();
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [streamScroll, setStreamScroll] = useState(0);
  const [streamLines, setStreamLines] = useState<string[]>([]);

  const [ui, setUi] = useState<UiState>(() => {
    const st = engine.getState();
    const initialLogs = events.getRecentLogs().map((e) => ({
      level: e.level,
      message: e.message,
      timestamp: e.timestamp
        ? new Date(e.timestamp).toTimeString().split(" ")[0] ?? ""
        : new Date().toTimeString().split(" ")[0] ?? "",
    }));
    return {
      currentIteration: st.currentIteration,
      totalIterations: 1,
      iterationTitle: "",
      iterationModules: [],
      currentPhase: st.currentPhase,
      phaseStartedAt: Date.now(),
      runStartedAt: Date.now(),
      paused: false,
      phases: {},
      streamTotalChars: 0,
      logs: initialLogs,
      verbose: false,
    };
  });

  const streamBuf = useRef<string>("");
  const logBuf = useRef<Array<{ level: "info" | "warn" | "error"; message: string; timestamp: string }>>(
    ui.logs,
  );

  const [mcpStatus, setMcpStatus] = useState<McpStatusReport | null>(null);

  // Idle cost: both timers run only while a cycle is executing. The spinner needs
  // ~12 fps, the elapsed clock only needs whole seconds.
  const running = engine?.isRunning === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setSpinnerIndex((i) => (i + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!running) return;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [running]);

  // Poll MCP status periodically (on mount, and every 15s) strictly bounded by timeout
  useEffect(() => {
    if (!engine?.runtime) return;
    let active = true;
    const poll = async () => {
      try {
        const report = await fetchMcpStatusWithTimeout(engine.runtime, MCP_STATUS_POLL_TIMEOUT_MS);
        if (active) setMcpStatus(report);
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
    void poll();
    const timer = setInterval(poll, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [engine?.runtime]);

  useEffect(() => {
    let streamTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingStreamChars = 0;
    let lastFlushTime = 0;

    const flushStream = () => {
      if (streamTimer) {
        clearTimeout(streamTimer);
        streamTimer = null;
      }
      lastFlushTime = Date.now();
      const allLines = streamBuf.current.split("\n");
      const lines =
        allLines.length > 1000
          ? allLines.slice(-1000)
          : allLines;
      if (allLines.length > 1000) {
        streamBuf.current = lines.join("\n");
      }
      setStreamLines(lines);
      if (pendingStreamChars > 0) {
        const added = pendingStreamChars;
        pendingStreamChars = 0;
        setUi((s) => ({
          ...s,
          streamTotalChars: s.streamTotalChars + added,
        }));
      }
    };

    const offs: Array<() => void> = [
      events.on("iterationStart", (e) => {
        setUi((s) => ({
          ...s,
          currentIteration: e.iteration,
          totalIterations: e.totalIterations,
          iterationTitle: e.title,
          iterationModules: e.modules ?? [],
          phases: {},
        }));
      }),
      events.on("phaseStart", (e) => {
        if (streamTimer) {
          clearTimeout(streamTimer);
          streamTimer = null;
        }
        pendingStreamChars = 0;
        streamBuf.current = "";
        setStreamLines([]);
        setStreamScroll(0);
        setUi((s) => ({
          ...s,
          currentIteration: e.iteration,
          totalIterations: e.totalIterations ?? s.totalIterations,
          iterationTitle: e.iterationTitle ?? s.iterationTitle,
          currentPhase: e.phase,
          phaseStartedAt: Date.now(),
          phases: {
            ...s.phases,
            [e.phase]: {
              attempt: e.attempt,
              startedAt: Date.now(),
            },
          },
        }));
      }),
      events.on("phaseStream", (e) => {
        streamBuf.current += e.text;
        pendingStreamChars += e.text.length;
        const now = Date.now();
        if (now - lastFlushTime >= 60) {
          flushStream();
        } else if (!streamTimer) {
          streamTimer = setTimeout(flushStream, 60);
        }
      }),
      events.on("phaseEnd", (r) => {
        flushStream();
        setUi((s) => ({
          ...s,
          lastReport: r.result,
        }));
      }),
      events.on("verdict", (e) => {
        setUi((s) => ({
          ...s,
          phases: {
            ...s.phases,
            [e.phase]: {
              verdict: e.verdict,
              attempt: e.attempt,
              durationMs: e.durationMs,
            },
          },
        }));
      }),
      events.on("decision", (req) => setUi((s) => ({ ...s, decision: req }))),
      events.on("decisionResolved", () => setUi((s) => ({ ...s, decision: undefined }))),
      events.on("log", (e) => {
        const time = e.timestamp
          ? new Date(e.timestamp).toTimeString().split(" ")[0] ?? ""
          : new Date().toTimeString().split(" ")[0] ?? "";
        logBuf.current = [
          ...logBuf.current.slice(-19),
          { level: e.level, message: e.message, timestamp: time },
        ];
        setUi((s) => ({ ...s, logs: logBuf.current }));
      }),
      events.on("done", () => {
        flushStream();
        // A failed promotion strands the iteration on its sandbox branch; name it
        // instead of leaving only a generic end state (AC-49.3).
        const promotion = engine.getState().promotion;
        if (promotion) setUi((s) => ({ ...s, promotion }));
        if (autoExit) {
          if (exitTimer) clearTimeout(exitTimer);
          exitTimer = setTimeout(() => exit(), 500);
        }
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      if (streamTimer) {
        clearTimeout(streamTimer);
        streamTimer = null;
      }
      if (exitTimer) {
        clearTimeout(exitTimer);
        exitTimer = null;
      }
    };
  }, [exit, autoExit]);

  // Calculate dynamic heights. The raven header's row cost is derived from the
  // same plan the header renders, so art never eats into the cards (AC-29.3).
  const headerContextRows = ui.iterationModules.length > 0 ? 4 : 3;
  const headerPlan = useRavenHeaderPlan(
    headerContextRows,
    VIEWPORT_RESERVED_ROWS,
    terminalSize,
    VIEW_OUTER_INSET,
  );
  const headerHeight = headerPlan.height;
  const footerHeight = FOOTER_HEIGHT;
  const reportHeight = ui.lastReport && !ui.decision ? REPORT_HEIGHT : 0;
  const promotionFailed =
    ui.promotion?.status === "conflict" || ui.promotion?.status === "failed";
  const promotionHeight = promotionFailed && !ui.decision ? PROMOTION_HEIGHT : 0;

  // Dynamically allocate log count to ensure middle cards remain comfortably visible
  let maxLogsAllowed = 0;
  if (terminalSize.rows >= 36) maxLogsAllowed = 5;
  else if (terminalSize.rows >= 30) maxLogsAllowed = 3;
  else if (terminalSize.rows >= 24) maxLogsAllowed = 2;
  else if (terminalSize.rows >= 20) maxLogsAllowed = 1;

  const visibleLogs = ui.logs.slice(-maxLogsAllowed);
  const logsHeight =
    visibleLogs.length > 0 ? visibleLogs.length + cardChrome("tertiary").rows : 0;

  // The decision modal charges before the middle cards, but it can never charge
  // more than the frame has: this is everything left once the header, the middle
  // floor, the log tail, the report pill, the notice and the footer are paid for
  // (REQ-69). `decisionModalHeight` turns that budget into the exact row cost.
  const decisionMaxRows = Math.max(
    DECISION_MIN_ROWS,
    terminalSize.rows -
      headerHeight -
      footerHeight -
      MIDDLE_MIN_ROWS -
      logsHeight -
      reportHeight -
      promotionHeight -
      1,
  );
  const decisionHeight = ui.decision
    ? decisionModalHeight(ui.decision, decisionMaxRows)
    : 0;

  const middleHeight = Math.max(
    MIDDLE_MIN_ROWS,
    terminalSize.rows -
      headerHeight -
      footerHeight -
      logsHeight -
      decisionHeight -
      reportHeight -
      promotionHeight -
      1,
  );
  const streamLinesCount = Math.max(1, middleHeight - cardChrome("secondary").rows);
  const maxStreamScroll = Math.max(0, streamLines.length - streamLinesCount);

  useInput((input, key) => {
    if (ui.decision) {
      const c = input.toLowerCase();
      if (ui.decision.kind === "permission") {
        if (c === "a") engine.resolveDecision("continue");
        else if (c === "o") engine.resolveDecision("retry");
        else if (c === "d") engine.resolveDecision("deny");
      } else if (ui.decision.kind === "question") {
        if (c === "c" || c === "a" || c === "1" || c === "y") engine.resolveDecision("continue");
        else if (c === "d" || c === "n") engine.resolveDecision("deny");
      } else {
        // `post-cycle-live` is the only kind that can offer the promotion
        // recovery, and it says so through `choices` (ADR-62): a key the prompt
        // did not advertise must stay a no-op.
        const offers = (choice: DecisionChoice): boolean =>
          !ui.decision?.choices || ui.decision.choices.includes(choice);
        if (c === "t" && offers("retry-promotion")) engine.resolveDecision("retry-promotion");
        else if (c === "p" && offers("repair")) engine.resolveDecision("repair");
        else if (c === "r") engine.resolveDecision("retry");
        else if (c === "c") engine.resolveDecision("continue");
        else if (c === "a") engine.resolveDecision("abort");
      }
      return;
    }

    // Scroll controls — trapped in card to prevent terminal window scroll leakage
    if (key.pageUp) {
      setStreamScroll((s) => Math.min(s + 4, maxStreamScroll));
      return;
    }
    if (key.pageDown) {
      setStreamScroll((s) => Math.max(s - 4, 0));
      return;
    }
    if (key.upArrow) {
      setStreamScroll((s) => Math.min(s + 2, maxStreamScroll));
      return;
    }
    if (key.downArrow) {
      setStreamScroll((s) => Math.max(s - 2, 0));
      return;
    }

    if (input === "p" || input === " ") {
      if (ui.paused) engine.resume();
      else engine.pause();
      setUi((s) => ({ ...s, paused: !s.paused }));
    } else if (input === "v") {
      setUi((s) => ({ ...s, verbose: !s.verbose }));
    } else if (key.escape || input === "q") {
      engine.requestAbort();
    }
  });

  const totalElapsed = now - ui.runStartedAt;
  const phaseElapsed = now - ui.phaseStartedAt;
  const spinner = SPINNER_FRAMES[spinnerIndex] ?? "⠋";

  // The stream column's real width: the outer `paddingX={1}` inset plus the
  // same percentage share the layout below gives its Box. Markdown rules use
  // this, so a `---` is one row at any terminal width.
  const contentColumns = Math.max(1, terminalSize.columns - VIEW_OUTER_INSET);
  const streamWidth = Math.max(1, Math.floor(contentColumns * (ui.verbose ? 0.65 : 0.58)));

  const streamStart = Math.max(0, streamLines.length - streamLinesCount - streamScroll);
  const visibleStreamLines = streamLines.slice(streamStart, streamStart + streamLinesCount);

  return (
    <Box
      flexDirection="column"
      width={terminalSize.columns}
      height={terminalSize.rows}
      paddingX={1}
      paddingY={0}
    >
      <HeaderCard
        plan={headerPlan}
        iteration={ui.currentIteration}
        totalIterations={ui.totalIterations}
        iterationTitle={ui.iterationTitle}
        modules={ui.iterationModules}
        currentPhase={ui.currentPhase}
        paused={ui.paused}
        totalElapsed={totalElapsed}
        phaseElapsed={phaseElapsed}
        spinner={spinner}
        cfg={cfg}
        mcpStatus={mcpStatus}
        agentId={engine.runtime.id}
      />

      <Box flexDirection="row" height={middleHeight} marginTop={0}>
        <Box width={ui.verbose ? "35%" : "42%"} flexDirection="column" marginRight={1}>
          <PipelineCard
            phases={ui.phases}
            currentPhase={ui.currentPhase}
            phaseElapsed={phaseElapsed}
            spinner={spinner}
            height={middleHeight}
            profile={cfg.profile}
            iteration={ui.currentIteration}
            totalIterations={ui.totalIterations}
          />
        </Box>
        <Box width={ui.verbose ? "65%" : "58%"} flexDirection="column">
          <StreamCard
            lines={visibleStreamLines}
            totalLines={streamLines.length}
            scrollOffset={streamScroll}
            maxScroll={maxStreamScroll}
            chars={ui.streamTotalChars}
            spinner={spinner}
            verbose={ui.verbose}
            height={middleHeight}
            report={ui.lastReport?.raw ?? ""}
            runtimeId={engine.runtime.id}
            streamsOutput={engine.runtime.capabilities?.streaming === true}
            width={streamWidth}
          />
        </Box>
      </Box>

      {visibleLogs.length > 0 && <LogsCard logs={visibleLogs} />}

      {promotionHeight > 0 && ui.promotion ? (
        <Box paddingX={1}>
          <Text color={THEME.danger} wrap="truncate">
            {STATUS_GLYPHS.blocked} PROMOTION FAILED — branch{" "}
            <Text bold>{sanitizeTerminalText(ui.promotion.branch)}</Text> preserved
            {ui.promotion.backups && ui.promotion.backups.length > 0
              ? ` · backups: ${ui.promotion.backups.map(sanitizeTerminalText).join(", ")}`
              : ""}
          </Text>
        </Box>
      ) : null}

      {ui.decision ? <DecisionModal req={ui.decision} maxRows={decisionMaxRows} /> : null}

      {ui.lastReport && !ui.decision && <ReportPill report={ui.lastReport} />}

      <FooterBar
        paused={ui.paused}
        verbose={ui.verbose}
        hasDecision={Boolean(ui.decision)}
        usage={formatUsage(engine?.getState().usage)}
      />
    </Box>
  );
}

function HeaderCard({
  plan,
  iteration,
  totalIterations,
  iterationTitle,
  modules,
  currentPhase,
  paused,
  totalElapsed,
  phaseElapsed,
  spinner,
  cfg,
  mcpStatus,
  agentId,
}: {
  plan: RavenHeaderPlan;
  iteration: number;
  totalIterations: number;
  iterationTitle: string;
  modules: string[];
  currentPhase: string;
  paused: boolean;
  totalElapsed: number;
  phaseElapsed: number;
  spinner: string;
  cfg: RunConfig;
  mcpStatus?: McpStatusReport | null;
  /** Active agent target, so the MCP badge attributes its numbers (AC-32.4). */
  agentId?: string;
}) {
  const isFix = currentPhase.startsWith("FIX");
  const progressStr = renderProgressBar(iteration, Math.max(1, totalIterations));
  const mcpBadge = formatMcpBadge(mcpStatus, agentId);
  // The raven brand is followed by meaningful run context (AC-29.4). Every
  // dynamic value is sanitized and clamped to the columns actually left over,
  // and detail that no longer fits is dropped instead of wrapped, so each row
  // costs exactly the one line the layout budgeted for it (AC-29.3).
  const rowWidth = plan.contentWidth;
  const gap = 2;
  const statusLabel = paused ? "[PAUSED]" : `[${spinner} RUNNING]`;
  const modeLabel = "mode: ";
  const modeBudget = Math.max(4, Math.min(14, rowWidth - statusLabel.length - modeLabel.length - 20));
  const safeMode = headerValue(cfg.mode, modeBudget);
  const elapsedLabel = `Elapsed: ${formatDurationSec(totalElapsed)}`;
  const usedStatus = statusLabel.length + 1 + modeLabel.length + safeMode.length + 3;
  const mcpRoom = rowWidth - usedStatus - elapsedLabel.length - gap - 2;
  // The badge now carries its source agent (`· opencode`), so it gets a wider
  // budget — still clamped to the room actually left on the row (AC-29.3).
  const mcpText = mcpRoom >= 10 ? headerValue(mcpBadge.text, Math.min(40, mcpRoom)) : "";

  const iterLabel = `Iter ${iteration}/${totalIterations}: `;
  const titleRoom = rowWidth - iterLabel.length - progressStr.length - gap - 2;
  const titleValue = titleRoom >= 8 ? headerValue(iterationTitle, titleRoom) : "";
  const progressValue = titleRoom >= 8 ? progressStr : "";

  const modulesLine = headerValue(modules.join(", "), Math.max(8, rowWidth - "modules: ".length - 2));

  const phaseLabel = "Active Phase: ";
  const durationLabel = ` (${formatDurationSec(phaseElapsed)})`;
  const phaseBudget = Math.max(6, Math.min(22, Math.floor(rowWidth * 0.24)));
  const safePhase = headerValue(currentPhase, phaseBudget);
  const usedLeft = phaseLabel.length + safePhase.length + durationLabel.length;
  // Models live in the right cell of the phase row: labels + both ids must fit.
  const modelLabels = "thinker: ".length + " · executor: ".length;
  const modelRoom = rowWidth - usedLeft - gap - modelLabels - 2;
  const bothModels = modelRoom >= 16;
  const modelBudget = Math.max(4, bothModels ? Math.ceil(modelRoom / 2) : 0);
  const thinkerName = (cfg.thinker ?? "").split("/").pop() ?? "";
  const executorName = (cfg.executor ?? "").split("/").pop() ?? "";
  const safeThinker = bothModels ? headerValue(thinkerName, modelBudget) : "";
  const executorBudget = modelRoom - safeThinker.length;
  const safeExecutor =
    bothModels && executorBudget >= 4 ? headerValue(executorName, executorBudget) : "";

  const rows: React.ReactNode[][] = [
    [
      <>
        <Text bold color={paused ? THEME.warn : THEME.ok} wrap="truncate">
          {`${statusLabel} `}
        </Text>
        <Text color={THEME.muted}>mode: </Text>
        <Text bold color={THEME.text} wrap="truncate">
          {safeMode}
        </Text>
        {mcpText ? (
          <Text key="mcp" color={mcpStatusToken(mcpBadge.status)} wrap="truncate">
            {` · ${mcpText}`}
          </Text>
        ) : null}
      </>,
      <Text key="elapsed" bold color={THEME.text} wrap="truncate">
        {elapsedLabel}
      </Text>,
    ],
    [
      <>
        <Text bold color={THEME.text}>{iterLabel}</Text>
        <Text color={THEME.accentStrong} wrap="truncate">
          {titleValue || "(initializing...)"}
        </Text>
      </>,
      ...(progressValue
        ? [
            <Text key="progress" color={THEME.accent} wrap="truncate">
              {progressValue}
            </Text>,
          ]
        : []),
    ],
  ];

  if (modules.length > 0) {
    rows.push([
      <Text key="modules" color={THEME.muted} wrap="truncate">
        modules: <Text color={THEME.warn}>{modulesLine}</Text>
      </Text>,
    ]);
  }

  rows.push([
    <>
      <Text color={THEME.muted}>{phaseLabel}</Text>
      <Text bold color={isFix ? THEME.thinker : THEME.info} wrap="truncate">
        {safePhase}
      </Text>
      <Text color={THEME.muted}>{durationLabel}</Text>
    </>,
    ...(safeThinker
      ? [
          <>
            <Text color={THEME.muted}>thinker: </Text>
            <Text color={THEME.thinker} wrap="truncate">
              {safeThinker}
            </Text>
            {safeExecutor ? (
              <Text key="executor" color={THEME.info} wrap="truncate">
                {` · executor: ${safeExecutor}`}
              </Text>
            ) : null}
          </>,
        ]
      : []),
  ]);

  return <RavenHeader plan={plan} rows={rows} />;
}

function PipelineCard({
  phases,
  currentPhase,
  phaseElapsed,
  spinner,
  height,
  profile,
  iteration,
  totalIterations,
}: {
  phases: Record<string, PhaseStatus>;
  currentPhase: string;
  phaseElapsed: number;
  spinner: string;
  height?: number;
  /** The active methodology profile — it owns the order, not this panel. */
  profile?: ProfileName;
  /** The increment being run, printed in the title as `iter n/m`. */
  iteration: number;
  totalIterations: number;
}) {
  // The panel lists the phases the *active profile* runs, in the order it runs
  // them. The registry order would show `VERIFY` last while the Huginn Cycle
  // runs it right after `EXECUTE`, so an honest run read as an out-of-order one.
  const displayPhases: string[] = [];
  for (const base of [...new Set<string>(phasesForProfile(profile))]) {
    displayPhases.push(base);
    for (const key of Object.keys(phases)) {
      if (key.startsWith("FIX") && !displayPhases.includes(key)) {
        if (
          (base === "SPEC_AUDIT" && key === "FIX_SPEC") ||
          (base === "VALIDATE_STEP" && key === "FIX_VALIDATE") ||
          (base === "TEST_MODULE" && key === "FIX_TEST") ||
          (base === "VERIFY" && key === "FIX_VERIFY") ||
          (base === "SECURE_CHECK" && key === "FIX_SECURITY") ||
          (base === "REVIEW" && key === "FIX_REVIEW")
        ) {
          displayPhases.push(key);
        }
      }
    }
  }
  if (!displayPhases.includes(currentPhase)) {
    displayPhases.push(currentPhase);
  }

  // Constrain visible phase items to available card height
  const maxItems = height ? Math.max(2, height - cardChrome("secondary").rows) : displayPhases.length;
  let itemsToRender = displayPhases;
  if (displayPhases.length > maxItems) {
    const curIdx = displayPhases.indexOf(currentPhase);
    const start = Math.max(0, Math.min(curIdx - Math.floor(maxItems / 2), displayPhases.length - maxItems));
    itemsToRender = displayPhases.slice(start, start + maxItems);
  }

  return (
    <Card
      tone="secondary"
      title="PIPELINE PHASES"
      titleRight={
        <Text color={THEME.muted} wrap="truncate">
          {`iter ${iteration}/${Math.max(1, totalIterations)}`}
        </Text>
      }
      height={height}
      minHeight={6}
    >
      {itemsToRender.map((name, index) => {
        const st = phases[name];
        const isCurrent = name === currentPhase;
        const isFix = name.startsWith("FIX");

        let icon: string = STATUS_GLYPHS.pending;
        let color: string | undefined = THEME.muted;
        let badge = "";

        if (isCurrent) {
          icon = spinner;
          color = isFix ? THEME.thinker : THEME.accentStrong;
          badge = `(${formatDurationSec(phaseElapsed)})`;
        } else if (st?.verdict) {
          icon = verdictIcon(st.verdict);
          color = THEME[verdictToken(st.verdict)];
          badge =
            st.verdict === "pass"
              ? st.durationMs
                ? formatDurationTerse(st.durationMs)
                : "pass"
              : st.verdict === "warning"
                ? "warn"
                : st.verdict === "blocked"
                  ? "blocked"
                  : "skip";
        }

        // The pipeline reads as a journey, not a list: every phase hangs off the
        // same rail, the last one closes it with `└─`, and the current node keeps
        // the status glyph (the spinner) that says where the run actually is.
        const isLast = index === itemsToRender.length - 1;
        const rail = isFix ? "   └─ " : ` ${isLast ? "└─" : "├─"} `;
        return (
          <Box key={name} justifyContent="space-between">
            <Text color={color} wrap="truncate">
              {icon}
              {rail}
              <Text bold={isCurrent}>{name.padEnd(14)}</Text>
            </Text>
            <Text dimColor={THEME.colorEnabled && !isCurrent} color={color}>
              {st?.attempt && st.attempt > 1 ? `[att ${st.attempt}] ` : ""}
              {badge}
            </Text>
          </Box>
        );
      })}
    </Card>
  );
}

/**
 * The run dashboard's output panel (ADR-50 / REQ-51).
 *
 * Three honest body modes, in order of what the engine actually has:
 *   1. **stream** — incremental text, when the runtime has an event channel;
 *   2. **report** — the tail of the last finished phase's real report, which is
 *      all a subprocess runtime ever produces (AC-51.1);
 *   3. **idle** — two ravens and a rotating phrase, with one line naming the
 *      runtime and why there is nothing live to show (AC-51.2, AC-51.3).
 *
 * The waiting placeholder is kept only for a runtime that really can stream, so
 * the panel never claims to await output that will not arrive.
 */
export function StreamCard({
  lines = [],
  totalLines,
  scrollOffset = 0,
  maxScroll = 0,
  chars,
  spinner,
  verbose,
  height,
  report = "",
  runtimeId,
  streamsOutput = true,
  width,
}: {
  lines?: string[];
  totalLines?: number;
  scrollOffset?: number;
  maxScroll?: number;
  chars: number;
  spinner: string;
  verbose: boolean;
  height?: number;
  /** The last finished phase's raw report, shown when nothing streams (AC-51.1). */
  report?: string;
  /** Active runtime id, named by the honesty note (AC-51.3). */
  runtimeId?: string;
  /** Whether the runtime can push incremental output (AC-51.3). */
  streamsOutput?: boolean;
  /** Columns the card occupies; markdown rules and tables use its body width. */
  width?: number;
}) {
  const displayLines = lines;
  const bodyBudget = Math.max(1, (height ?? 10) - cardChrome("secondary").rows);
  const bodyColumns = Math.max(1, (width ?? 84) - cardChrome("secondary").columns);
  // A buffer that only holds the empty string (a phase that emitted nothing) is
  // not a stream: treating it as one hid the last phase's report behind a blank
  // row (REQ-51 / AC-51.1). This matches the live view's `hasStreamContent`.
  const hasStream = displayLines.some((line) => line.trim().length > 0);
  const reportLines =
    !hasStream && report.trim().length > 0 ? report.trimEnd().split("\n") : [];
  const hasReport = reportLines.length > 0;

  const idleRows: Array<{ text: string; art: boolean }> = !hasStream && !hasReport
    ? ([
        ...TWO_RAVENS.map((text) => ({ text, art: true })),
        { text: idleAgentPhrase(Math.floor(Date.now() / 4000)), art: false },
        streamsOutput
          ? { text: "(waiting for agent stream / tool executions...)", art: false }
          : {
              text: `${sanitizeTerminalText(runtimeId ?? "this runtime")} cannot stream live output — each phase's report appears here when it ends.`,
              art: false,
            },
      ] as Array<{ text: string; art: boolean }>).slice(0, bodyBudget)
    : [];

  return (
    <Card
      tone="secondary"
      title={
        <>
          {spinner} {streamsOutput ? "LIVE AGENT OUTPUT" : "AGENT OUTPUT"}{" "}
          {verbose ? <Text color={THEME.ok}>[VERBOSE]</Text> : null}
        </>
      }
      titleRight={
        <Box>
          {maxScroll > 0 && (
            <Text color={THEME.muted}>
              {scrollOffset > 0 ? `▲ +${scrollOffset} ` : "▼ bottom "}
              {totalLines ? `(${totalLines} lines) ` : ""}
            </Text>
          )}
          <Text color={THEME.muted}>{chars > 0 ? `${(chars / 1024).toFixed(1)} KB` : ""}</Text>
        </Box>
      }
      height={height}
      minHeight={6}
    >
      {hasStream ? (
        <MarkdownBlock
          lines={displayLines}
          width={bodyColumns}
          colorFor={(line) => {
            const trimmed = line.trim();
            const isTool =
              trimmed.startsWith("⚡") || trimmed.startsWith("✓") || trimmed.startsWith("✗");
            const isCmd = trimmed.startsWith(">") || trimmed.startsWith("$");
            const isThought = trimmed.startsWith("💭") || trimmed.startsWith("Thinking:");
            return isTool
              ? THEME.accentStrong
              : isCmd
                ? THEME.warn
                : isThought
                  ? THEME.thinker
                  : THEME.text;
          }}
          wrap="truncate"
        />
      ) : hasReport ? (
        // The runtime cannot stream: show the phase's real report rather than an
        // empty panel that looks broken (AC-51.1).
        <MarkdownBlock
          lines={reportLines}
          width={bodyColumns}
          maxRows={bodyBudget}
          wrap="truncate"
        />
      ) : (
        <Box flexDirection="column" overflow="hidden">
          {idleRows.map((row, i) => (
            <Text key={i} color={row.art ? THEME.accentStrong : THEME.muted} wrap="truncate">
              {row.art ? row.text : `  ${row.text}`}
            </Text>
          ))}
        </Box>
      )}
    </Card>
  );
}

export function LogsCard({
  logs,
}: {
  logs: Array<{ level: "info" | "warn" | "error"; message: string; timestamp: string }>;
}) {
  if (logs.length === 0) return null;
  return (
    <Card tone="tertiary" title="SYSTEM LOGS">
      {logs.map((l, i) => {
        const levelColor = l.level === "error" ? THEME.danger : l.level === "warn" ? THEME.warn : THEME.accent;
        return (
          <Box key={i}>
            <Text color={THEME.border}>│ </Text>
            <Text color={THEME.muted}>[{l.timestamp}] </Text>
            <Text bold color={levelColor}>
              {l.level.toUpperCase().padEnd(5)}{" "}
            </Text>
            <Text wrap="truncate" color={THEME.text}>
              {l.message}
            </Text>
          </Box>
        );
      })}
    </Card>
  );
}

function ReportPill({ report }: { report: PhaseResult }) {
  const v = report.verdict;
  const color = v ? THEME[verdictToken(v)] : THEME.danger;
  const mark = v ? verdictIcon(v) : STATUS_GLYPHS.blocked;
  return (
    <Box marginTop={0} paddingX={1}>
      <Text color={THEME.muted}>Last result: </Text>
      <Text color={color}>
        {mark} <Text bold>{report.phase}</Text> · verdict: <Text bold>{report.verdict ?? "n/a"}</Text> · model: {report.model}
      </Text>
    </Box>
  );
}

function FooterBar({
  paused,
  verbose,
  hasDecision,
  usage,
}: {
  paused: boolean;
  verbose: boolean;
  hasDecision: boolean;
  usage?: string;
}) {
  return (
    <Box marginTop={0} justifyContent="space-between">
      <Text color={THEME.muted}>
        {usage ? `${usage}   ` : ""}[Space] {paused ? "Resume" : "Pause"}   [q/Esc] Abort   [v] Verbose {verbose ? <Text color={THEME.ok}>(ON)</Text> : <Text color={THEME.muted}>(OFF)</Text>}   [PageUp/Down, ↑/↓] Scroll
      </Text>
      {hasDecision && <Text bold color={THEME.warn}>Interactive decision input active</Text>}
    </Box>
  );
}
