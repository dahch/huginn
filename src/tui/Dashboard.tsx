import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CycleEngine } from "../engine/cycle";
import type { RunConfig } from "../config";
import { events } from "../engine/engineEvents";
import type { PhaseResult, DecisionRequest, Verdict } from "../engine/types";
import { formatDurationSec, formatDurationTerse, verdictColor, verdictIcon } from "../format";

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
const DEFAULT_STREAM_LINES = 10;
const VERBOSE_STREAM_LINES = 22;
const MAX_LOGS = 6;

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
  streamTail: string[];
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

export function Dashboard({ engine, cfg }: { engine: CycleEngine; cfg: RunConfig }) {
  const { exit } = useApp();
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const [now, setNow] = useState(Date.now());

  const [ui, setUi] = useState<UiState>(() => {
    const st = engine.getState();
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
      streamTail: [],
      streamTotalChars: 0,
      logs: [],
      verbose: false,
    };
  });

  const streamBuf = useRef<string>("");
  const logBuf = useRef<Array<{ level: "info" | "warn" | "error"; message: string; timestamp: string }>>([]);
  // Ref (not state) so the subscription effect below doesn't re-register on
  // verbose toggles — a cleanup/re-register window would drop live events.
  const streamLinesLimitRef = useRef(DEFAULT_STREAM_LINES);

  // Animation spinner tick
  useEffect(() => {
    const timer = setInterval(() => {
      setSpinnerIndex((i) => (i + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, 80);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const offs: Array<() => void> = [
      events.on("iterationStart", (e) => {
        setUi((s) => ({
          ...s,
          currentIteration: e.iteration,
          totalIterations: e.totalIterations,
          iterationTitle: e.title,
          iterationModules: e.modules ?? [],
          phases: {}, // reset phase table for new iteration
        }));
      }),
      events.on("phaseStart", (e) => {
        streamBuf.current = "";
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
        const lines = streamBuf.current.split("\n");
        setUi((s) => ({
          ...s,
          streamTail: lines.slice(-streamLinesLimitRef.current),
          streamTotalChars: s.streamTotalChars + e.text.length,
        }));
      }),
      events.on("phaseEnd", (r) => {
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
        const time = e.timestamp ? new Date(e.timestamp).toTimeString().split(" ")[0] ?? "" : new Date().toTimeString().split(" ")[0] ?? "";
        logBuf.current = [...logBuf.current.slice(-(MAX_LOGS - 1)), { level: e.level, message: e.message, timestamp: time }];
        setUi((s) => ({ ...s, logs: logBuf.current }));
      }),
      events.on("done", () => {
        setTimeout(() => exit(), 500);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [exit]);

  useInput((input, key) => {
    if (ui.decision) {
      const c = input.toLowerCase();
      if (ui.decision.kind === "permission") {
        if (c === "a") engine.resolveDecision("continue");
        else if (c === "o") engine.resolveDecision("retry");
        else if (c === "d") engine.resolveDecision("deny");
      } else {
        if (c === "r") engine.resolveDecision("retry");
        else if (c === "c") engine.resolveDecision("continue");
        else if (c === "a") engine.resolveDecision("abort");
      }
      return;
    }
    if (input === "p" || input === " ") {
      if (ui.paused) engine.resume();
      else engine.pause();
      setUi((s) => ({ ...s, paused: !s.paused }));
    } else if (input === "v") {
      setUi((s) => {
        const nextVerbose = !s.verbose;
        const nextLimit = nextVerbose ? VERBOSE_STREAM_LINES : DEFAULT_STREAM_LINES;
        streamLinesLimitRef.current = nextLimit;
        const lines = streamBuf.current.split("\n");
        return {
          ...s,
          verbose: nextVerbose,
          streamTail: lines.slice(-nextLimit),
        };
      });
    } else if (key.escape || input === "q") {
      engine.requestAbort();
    }
  });

  const totalElapsed = now - ui.runStartedAt;
  const phaseElapsed = now - ui.phaseStartedAt;
  const spinner = SPINNER_FRAMES[spinnerIndex] ?? "⠋";

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
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
      />

      <Box flexDirection="row" marginTop={1}>
        <Box width={ui.verbose ? "35%" : "42%"} flexDirection="column" marginRight={1}>
          <PipelineCard
            phases={ui.phases}
            currentPhase={ui.currentPhase}
            phaseElapsed={phaseElapsed}
            spinner={spinner}
          />
        </Box>
        <Box width={ui.verbose ? "65%" : "58%"} flexDirection="column">
          <StreamCard
            tail={ui.streamTail}
            chars={ui.streamTotalChars}
            spinner={spinner}
            verbose={ui.verbose}
          />
        </Box>
      </Box>

      <LogsCard logs={ui.logs} />

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
}) {
  const isFix = currentPhase.startsWith("FIX");
  const progressStr = renderProgressBar(iteration, Math.max(1, totalIterations));

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
}: {
  phases: Record<string, PhaseStatus>;
  currentPhase: string;
  phaseElapsed: number;
  spinner: string;
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

  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} minHeight={12}>
      <Text bold color="cyan">PIPELINE PHASES</Text>
      {displayPhases.map((name) => {
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

function StreamCard({
  tail,
  chars,
  spinner,
  verbose,
}: {
  tail: string[];
  chars: number;
  spinner: string;
  verbose: boolean;
}) {
  return (
    <Box borderStyle="round" borderColor={verbose ? "cyan" : "gray"} flexDirection="column" paddingX={1} minHeight={12}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {spinner} LIVE AGENT OUTPUT {verbose ? <Text color="green">[VERBOSE]</Text> : null}
        </Text>
        <Text dimColor>{chars > 0 ? `${(chars / 1024).toFixed(1)} KB` : ""}</Text>
      </Box>
      {tail.length === 0 ? (
        <Box marginTop={2} justifyContent="center">
          <Text dimColor>(waiting for agent stream / tool executions...)</Text>
        </Box>
      ) : (
        tail.map((line, i) => {
          const trimmed = line.trim();
          const isTool = trimmed.startsWith("⚡") || trimmed.startsWith("✓") || trimmed.startsWith("✗");
          const isCmd = trimmed.startsWith(">") || trimmed.startsWith("$");
          const isHeading = trimmed.startsWith("#");
          const isThought = trimmed.startsWith("💭") || trimmed.startsWith("Thinking:");
          const color = isTool
            ? "cyanBright"
            : isCmd
              ? "yellow"
              : isHeading
                ? "greenBright"
                : isThought
                  ? "magentaBright"
                  : "white";

          return (
            <Text key={i} wrap="truncate" color={color}>
              {line || " "}
            </Text>
          );
        })
      )}
    </Box>
  );
}

function LogsCard({ logs }: { logs: Array<{ level: "info" | "warn" | "error"; message: string; timestamp: string }> }) {
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

function DecisionModal({ req }: { req: DecisionRequest }) {
  const isPerm = req.kind === "permission";
  return (
    <Box marginTop={1} borderStyle="double" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text bold color="yellow">
        ⚠️ DECISION REQUIRED · Gate {req.phase} (Iteration {req.iteration})
      </Text>
      <Text color="white" bold>
        {req.message}
      </Text>
      <Box marginTop={1}>
        <Text>
          {isPerm ? (
            <>
              <Text bold color="cyan">[a] </Text>
              <Text>Allow Always   </Text>
              <Text bold color="cyan">[o] </Text>
              <Text>Allow Once   </Text>
              <Text bold color="red">[d] </Text>
              <Text>Deny</Text>
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
          )}
        </Text>
      </Box>
    </Box>
  );
}

function FooterBar({ paused, verbose, hasDecision }: { paused: boolean; verbose: boolean; hasDecision: boolean }) {
  return (
    <Box marginTop={0} justifyContent="space-between">
      <Text dimColor>
        [Space] {paused ? "Resume" : "Pause"}   [q/Esc] Abort   [v] Verbose {verbose ? <Text color="green">(ON)</Text> : <Text dimColor>(OFF)</Text>}
      </Text>
      {hasDecision && <Text bold color="yellow">Interactive decision input active</Text>}
    </Box>
  );
}
