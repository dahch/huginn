import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CycleEngine } from "../engine/cycle";
import type { RunConfig } from "../config";
import { events } from "../engine/engineEvents";
import type { PhaseResult, DecisionRequest, Verdict } from "../engine/types";
import { formatDurationSec, formatDurationTerse, verdictColor, verdictIcon } from "../format";
import { MarkdownLine } from "./markdown";
import { useTerminalSize } from "./useTerminalSize";
import type { McpStatusReport } from "../engine/agent/types.js";
import { fetchMcpStatusWithTimeout, formatMcpBadge } from "../engine/agent/mcpStatus.js";

const BASE_PHASES = [
  "SPEC_AUDIT",
  "EXECUTE",
  "VALIDATE_STEP",
  "TEST_MODULE",
  "SECURE_CHECK",
  "REVIEW",
  "DOC_SYNC",
  "COMMIT_ALL",
] as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

  // Animation spinner tick
  useEffect(() => {
    const timer = setInterval(() => {
      setSpinnerIndex((i) => (i + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, 80);
    return () => clearInterval(timer);
  }, []);

  // Poll MCP status periodically (on mount, and every 15s) strictly bounded by timeout
  useEffect(() => {
    if (!engine?.runtime) return;
    let active = true;
    const poll = async () => {
      try {
        const report = await fetchMcpStatusWithTimeout(engine.runtime, 1500);
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

  // Calculate dynamic heights
  const headerHeight = ui.iterationModules.length > 0 ? 6 : 5;
  const footerHeight = 1;
  const reportHeight = ui.lastReport && !ui.decision ? 1 : 0;
  const decisionHeight = ui.decision ? 6 : 0;

  // Dynamically allocate log count to ensure middle cards remain comfortably visible
  let maxLogsAllowed = 0;
  if (terminalSize.rows >= 36) maxLogsAllowed = 5;
  else if (terminalSize.rows >= 30) maxLogsAllowed = 3;
  else if (terminalSize.rows >= 24) maxLogsAllowed = 2;
  else if (terminalSize.rows >= 20) maxLogsAllowed = 1;

  const visibleLogs = ui.logs.slice(-maxLogsAllowed);
  const logsHeight = visibleLogs.length > 0 ? visibleLogs.length + 3 : 0;

  const middleHeight = Math.max(
    6,
    terminalSize.rows - headerHeight - footerHeight - logsHeight - decisionHeight - reportHeight - 1,
  );
  const streamLinesCount = Math.max(1, middleHeight - 3);
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
        if (c === "r") engine.resolveDecision("retry");
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
      />

      <Box flexDirection="row" height={middleHeight} marginTop={0}>
        <Box width={ui.verbose ? "35%" : "42%"} flexDirection="column" marginRight={1}>
          <PipelineCard
            phases={ui.phases}
            currentPhase={ui.currentPhase}
            phaseElapsed={phaseElapsed}
            spinner={spinner}
            height={middleHeight}
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
          />
        </Box>
      </Box>

      {visibleLogs.length > 0 && <LogsCard logs={visibleLogs} />}

      {ui.decision ? <DecisionModal req={ui.decision} /> : null}

      {ui.lastReport && !ui.decision && <ReportPill report={ui.lastReport} />}

      <FooterBar paused={ui.paused} verbose={ui.verbose} hasDecision={Boolean(ui.decision)} />
    </Box>
  );
}

function HeaderCard({
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
}: {
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
}) {
  const isFix = currentPhase.startsWith("FIX");
  const progressStr = renderProgressBar(iteration, Math.max(1, totalIterations));
  const mcpBadge = formatMcpBadge(mcpStatus);

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text bold color="cyan">🦅 HUGINN </Text>
          <Text bold color={paused ? "yellow" : "green"}>
            {paused ? " [⏸ PAUSED] " : ` [${spinner} RUNNING] `}
          </Text>
          <Text dimColor>mode: </Text>
          <Text bold color="white">{cfg.mode} </Text>
          <Text dimColor>· </Text>
          <Text color={mcpBadge.color}>{mcpBadge.text}</Text>
        </Box>
        <Box>
          <Text dimColor>Elapsed: </Text>
          <Text bold color="white">{formatDurationSec(totalElapsed)}</Text>
        </Box>
      </Box>

      <Box marginTop={0} justifyContent="space-between">
        <Box flexDirection="column">
          <Text>
            <Text bold color="white">{`Iter ${iteration}/${totalIterations}: `}</Text>
            <Text color="cyanBright">{iterationTitle || "(initializing...)"}</Text>
          </Text>
          {modules.length > 0 && (
            <Text dimColor>
              modules: <Text color="yellow">{modules.join(", ")}</Text>
            </Text>
          )}
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
          <Text color="cyan">{progressStr}</Text>
        </Box>
      </Box>

      <Box marginTop={0} justifyContent="space-between">
        <Box>
          <Text dimColor>Active Phase: </Text>
          <Text bold color={isFix ? "magenta" : "blueBright"}>
            {currentPhase}
          </Text>
          <Text dimColor> ({formatDurationSec(phaseElapsed)})</Text>
        </Box>
        <Box>
          <Text dimColor>thinker: </Text>
          <Text color="magenta">{cfg.thinker.split("/").pop()}</Text>
          <Text dimColor> · executor: </Text>
          <Text color="blueBright">{cfg.executor.split("/").pop()}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function PipelineCard({
  phases,
  currentPhase,
  phaseElapsed,
  spinner,
  height,
}: {
  phases: Record<string, PhaseStatus>;
  currentPhase: string;
  phaseElapsed: number;
  spinner: string;
  height?: number;
}) {
  const displayPhases: string[] = [];
  for (const base of BASE_PHASES) {
    displayPhases.push(base);
    for (const key of Object.keys(phases)) {
      if (key.startsWith("FIX") && !displayPhases.includes(key)) {
        if (
          (base === "SPEC_AUDIT" && key === "FIX_SPEC") ||
          (base === "VALIDATE_STEP" && key === "FIX_VALIDATE") ||
          (base === "TEST_MODULE" && key === "FIX_TEST") ||
          (base === "SECURE_CHECK" && key === "FIX_SECURITY") ||
          (base === "REVIEW" && key === "FIX_REVIEW")
        ) {
          displayPhases.push(key);
        }
      }
    }
  }
  if (currentPhase.startsWith("FIX") && !displayPhases.includes(currentPhase)) {
    displayPhases.push(currentPhase);
  }

  // Constrain visible phase items to available card height
  const maxItems = height ? Math.max(2, height - 3) : displayPhases.length;
  let itemsToRender = displayPhases;
  if (displayPhases.length > maxItems) {
    const curIdx = displayPhases.indexOf(currentPhase);
    const start = Math.max(0, Math.min(curIdx - Math.floor(maxItems / 2), displayPhases.length - maxItems));
    itemsToRender = displayPhases.slice(start, start + maxItems);
  }

  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      flexDirection="column"
      paddingX={1}
      height={height}
      minHeight={6}
    >
      <Text bold color="cyan">PIPELINE PHASES</Text>
      {itemsToRender.map((name) => {
        const st = phases[name];
        const isCurrent = name === currentPhase;
        const isFix = name.startsWith("FIX");

        let icon = "⏳";
        let color: string = "gray";
        let badge = "";

        if (isCurrent) {
          icon = spinner;
          color = isFix ? "magenta" : "cyanBright";
          badge = `(${formatDurationSec(phaseElapsed)})`;
        } else if (st?.verdict) {
          icon = verdictIcon(st.verdict);
          color = verdictColor(st.verdict);
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

        const indent = isFix ? " └─ " : " ";
        return (
          <Box key={name} justifyContent="space-between">
            <Text color={color}>
              {icon}
              {indent}
              <Text bold={isCurrent}>{name.padEnd(14)}</Text>
            </Text>
            <Text dimColor={!isCurrent} color={color}>
              {st?.attempt && st.attempt > 1 ? `[att ${st.attempt}] ` : ""}
              {badge}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function StreamCard({
  lines = [],
  totalLines,
  scrollOffset = 0,
  maxScroll = 0,
  chars,
  spinner,
  verbose,
  height,
}: {
  lines?: string[];
  totalLines?: number;
  scrollOffset?: number;
  maxScroll?: number;
  chars: number;
  spinner: string;
  verbose: boolean;
  height?: number;
}) {
  const displayLines = lines;
  return (
    <Box
      borderStyle="round"
      borderColor={verbose ? "cyan" : "gray"}
      flexDirection="column"
      paddingX={1}
      height={height}
      minHeight={6}
    >
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {spinner} LIVE AGENT OUTPUT {verbose ? <Text color="green">[VERBOSE]</Text> : null}
        </Text>
        <Box>
          {maxScroll > 0 && (
            <Text dimColor>
              {scrollOffset > 0 ? `▲ +${scrollOffset} ` : "▼ bottom "}
              {totalLines ? `(${totalLines} lines) ` : ""}
            </Text>
          )}
          <Text dimColor>{chars > 0 ? `${(chars / 1024).toFixed(1)} KB` : ""}</Text>
        </Box>
      </Box>
      {displayLines.length === 0 ? (
        <Box marginTop={1} justifyContent="center">
          <Text dimColor>(waiting for agent stream / tool executions...)</Text>
        </Box>
      ) : (
        displayLines.map((line, i) => {
          const trimmed = line.trim();
          const isTool = trimmed.startsWith("⚡") || trimmed.startsWith("✓") || trimmed.startsWith("✗");
          const isCmd = trimmed.startsWith(">") || trimmed.startsWith("$");
          const isThought = trimmed.startsWith("💭") || trimmed.startsWith("Thinking:");
          const color = isTool
            ? "cyanBright"
            : isCmd
              ? "yellow"
              : isThought
                ? "magentaBright"
                : "white";

          return (
            <MarkdownLine key={i} text={line || " "} defaultColor={color} wrap="truncate" />
          );
        })
      )}
    </Box>
  );
}

export function LogsCard({
  logs,
}: {
  logs: Array<{ level: "info" | "warn" | "error"; message: string; timestamp: string }>;
}) {
  if (logs.length === 0) return null;
  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} marginTop={0}>
      <Text bold color="cyan">SYSTEM LOGS</Text>
      {logs.map((l, i) => {
        const levelColor = l.level === "error" ? "red" : l.level === "warn" ? "yellow" : "cyan";
        return (
          <Box key={i}>
            <Text dimColor>[{l.timestamp}] </Text>
            <Text bold color={levelColor}>
              {l.level.toUpperCase().padEnd(5)} │{" "}
            </Text>
            <Text wrap="truncate" color="white">
              {l.message}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function ReportPill({ report }: { report: PhaseResult }) {
  const v = report.verdict;
  const color = v ? verdictColor(v) : "red";
  const mark = v ? verdictIcon(v) : "🔴";
  return (
    <Box marginTop={0} paddingX={1}>
      <Text dimColor>Last result: </Text>
      <Text color={color}>
        {mark} <Text bold>{report.phase}</Text> · verdict: <Text bold>{report.verdict ?? "n/a"}</Text> · model: {report.model}
      </Text>
    </Box>
  );
}

export function DecisionModal({ req }: { req: DecisionRequest }) {
  const isPerm = req.kind === "permission";
  const isQuestion = req.kind === "question";
  const title =
    req.kind === "approve-draft"
      ? "📋 DECISION REQUIRED · Approve drafted docs"
      : req.kind === "scope-extraction"
        ? "⚠️ DECISION REQUIRED · Scope extraction failed"
        : req.kind === "draft-format"
          ? "⚠️ DECISION REQUIRED · Draft format violated"
          : req.kind === "post-cycle-live"
            ? "🎉 CYCLE COMPLETE · Next Action"
            : isQuestion
              ? "❓ QUESTION FROM AGENT · Input required"
              : `⚠️ DECISION REQUIRED · Gate ${req.phase} (Iteration ${req.iteration})`;
  const keys =
    req.kind === "approve-draft" ? (
      <>
        <Text bold color="cyan">[r] </Text>
        <Text>Re-draft with latest chat   </Text>
        <Text bold color="green">[c] </Text>
        <Text>OK — commit & execute   </Text>
        <Text bold color="red">[a] </Text>
        <Text>Abort</Text>
      </>
    ) : req.kind === "scope-extraction" ? (
      <>
        <Text bold color="cyan">[r] </Text>
        <Text>Retry extraction   </Text>
        <Text bold color="yellow">[c] </Text>
        <Text>Use my last message   </Text>
        <Text bold color="red">[a] </Text>
        <Text>Abort</Text>
      </>
    ) : req.kind === "draft-format" ? (
      <>
        <Text bold color="cyan">[r] </Text>
        <Text>Retry with contract   </Text>
        <Text bold color="yellow">[c] </Text>
        <Text>Accept as-is   </Text>
        <Text bold color="red">[a] </Text>
        <Text>Abort</Text>
      </>
    ) : req.kind === "post-cycle-live" ? (
      <>
        <Text bold color="green">[c] </Text>
        <Text>Exit / Finish   </Text>
        <Text bold color="cyan">[r] </Text>
        <Text>Return to Live mode   </Text>
        <Text bold color="red">[a] </Text>
        <Text>Exit</Text>
      </>
    ) : isPerm ? (
      <>
        <Text bold color="cyan">[a] </Text>
        <Text>Allow Always   </Text>
        <Text bold color="cyan">[o] </Text>
        <Text>Allow Once   </Text>
        <Text bold color="red">[d] </Text>
        <Text>Deny</Text>
      </>
    ) : isQuestion ? (
      <>
        <Text bold color="green">[c/1] </Text>
        <Text>Accept / Proceed with recommended   </Text>
        <Text bold color="red">[d] </Text>
        <Text>Reject / Skip question</Text>
      </>
    ) : (
      <>
        <Text bold color="cyan">[r] </Text>
        <Text>Retry with Thinker   </Text>
        <Text bold color="yellow">[c] </Text>
        <Text>Force Continue   </Text>
        <Text bold color="red">[a] </Text>
        <Text>Abort Run</Text>
      </>
    );
  return (
    <Box marginTop={0} borderStyle="double" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text bold color="yellow">
        {title}
      </Text>
      <Text color="white" bold>
        {req.message}
      </Text>
      <Box marginTop={1}>
        <Text>{keys}</Text>
      </Box>
    </Box>
  );
}

function FooterBar({
  paused,
  verbose,
  hasDecision,
}: {
  paused: boolean;
  verbose: boolean;
  hasDecision: boolean;
}) {
  return (
    <Box marginTop={0} justifyContent="space-between">
      <Text dimColor>
        [Space] {paused ? "Resume" : "Pause"}   [q/Esc] Abort   [v] Verbose {verbose ? <Text color="green">(ON)</Text> : <Text dimColor>(OFF)</Text>}   [PageUp/Down, ↑/↓] Scroll
      </Text>
      {hasDecision && <Text bold color="yellow">Interactive decision input active</Text>}
    </Box>
  );
}
