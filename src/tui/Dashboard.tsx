import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CycleEngine } from "../engine/cycle";
import type { RunConfig } from "../config";
import { events } from "../engine/engineEvents";
import type { PhaseResult, DecisionRequest, Verdict } from "../engine/types";

const PHASE_ORDER = [
  "SPEC_AUDIT",
  "EXECUTE",
  "VALIDATE_STEP",
  "TEST_MODULE",
  "SECURE_CHECK",
  "REVIEW",
  "DOC_SYNC",
  "COMMIT_ALL",
] as const;

const STREAM_TAIL_LINES = 12;

interface PhaseStatus {
  verdict?: Verdict;
  attempt: number;
}

interface UiState {
  currentIteration: number;
  currentPhase: string;
  paused: boolean;
  phases: Record<string, PhaseStatus>;
  streamTail: string[];
  logs: string[];
  decision?: DecisionRequest;
  lastReport?: PhaseResult;
}

export function Dashboard({ engine, cfg }: { engine: CycleEngine; cfg: RunConfig }) {
  const { exit } = useApp();
  const [ui, setUi] = useState<UiState>(() => ({
    currentIteration: engine.getState().currentIteration,
    currentPhase: engine.getState().currentPhase,
    paused: false,
    phases: {},
    streamTail: [],
    logs: [],
  }));

  const streamBuf = useRef<string>("");
  const logBuf = useRef<string[]>([]);

  useEffect(() => {
    const offs: Array<() => void> = [
      events.on("phaseStart", (e) => {
        streamBuf.current = "";
        setUi((s) => ({
          ...s,
          currentIteration: e.iteration,
          currentPhase: e.phase,
        }));
      }),
      events.on("phaseStream", (e) => {
        streamBuf.current += e.text;
        const lines = streamBuf.current.split("\n");
        setUi((s) => ({ ...s, streamTail: lines.slice(-STREAM_TAIL_LINES) }));
      }),
      events.on("phaseEnd", (r) => {
        setUi((s) => ({ ...s, lastReport: r.result }));
      }),
      events.on("verdict", (e) => {
        setUi((s) => ({
          ...s,
          phases: { ...s.phases, [e.phase]: { verdict: e.verdict, attempt: e.attempt } },
        }));
      }),
      events.on("decision", (req) => setUi((s) => ({ ...s, decision: req }))),
      events.on("decisionResolved", () => setUi((s) => ({ ...s, decision: undefined }))),
      events.on("log", (e) => {
        logBuf.current = [...logBuf.current.slice(-6), `[${e.level}] ${e.message}`];
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
    } else if (key.escape || input === "q") {
      engine.requestAbort();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Header iteration={ui.currentIteration} phase={ui.currentPhase} paused={ui.paused} cfg={cfg} />
      <PhasesTable phases={ui.phases} currentPhase={ui.currentPhase} />
      <Stream tail={ui.streamTail} />
      <Logs lines={ui.logs} />
      {ui.lastReport && <ReportBar report={ui.lastReport} />}
      {ui.decision ? <DecisionBox req={ui.decision} /> : null}
      <Text dimColor>  [space] pause/resume   [q/esc] abort   {ui.decision ? "decision keys above" : ""}</Text>
    </Box>
  );
}

function Header({
  iteration,
  phase,
  paused,
  cfg,
}: {
  iteration: number;
  phase: string;
  paused: boolean;
  cfg: RunConfig;
}) {
  const fix = phase.startsWith("FIX");
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Huginn {paused ? "⏸ paused" : "▶ running"} — iteration {iteration}
      </Text>
      <Text dimColor>
        thinker={cfg.thinker} · executor={cfg.executor} · mode={cfg.mode}
      </Text>
      <Text>
        <Text bold>phase: </Text>
        <Text bold color={fix ? "magenta" : "green"}>{phase}</Text>
      </Text>
    </Box>
  );
}

function PhasesTable({
  phases,
  currentPhase,
}: {
  phases: Record<string, PhaseStatus>;
  currentPhase: string;
}) {
  return (
    <Box marginTop={1} flexDirection="column">
      {PHASE_ORDER.map((name) => {
        const st = phases[name];
        const isCurrent = name === currentPhase;
        let mark = "  ";
        let color: string | undefined = undefined;
        if (st) {
          mark = st.verdict === "pass" ? "✅" : st.verdict === "warning" ? "🟡" : "🔴";
          color = st.verdict === "pass" ? "green" : st.verdict === "warning" ? "yellow" : "red";
        } else if (isCurrent) {
          mark = "⏳";
        }
        return (
          <Text key={name} color={color}>
            {mark} {name.padEnd(15)} {st ? `(attempt ${st.attempt})` : ""}
          </Text>
        );
      })}
    </Box>
  );
}

function Stream({ tail }: { tail: string[] }) {
  if (tail.length === 0) return null;
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold color="cyan">live output</Text>
      {tail.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function Logs({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <Box marginTop={1} flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} color="yellow" wrap="truncate">
          {l}
        </Text>
      ))}
    </Box>
  );
}

function ReportBar({ report }: { report: PhaseResult }) {
  const v = report.verdict;
  const mark = v === "pass" ? "✅" : v === "warning" ? "🟡" : "🔴";
  return (
    <Box marginTop={1} borderStyle="round" borderColor={v === "pass" ? "green" : v === "warning" ? "yellow" : "red"} paddingX={1}>
      <Text>
        {mark} <Text bold>{report.phase}</Text> · verdict <Text bold>{report.verdict ?? "n/a"}</Text> · model {report.model}
      </Text>
    </Box>
  );
}

function DecisionBox({ req }: { req: DecisionRequest }) {
  const isPerm = req.kind === "permission";
  return (
    <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text bold color="yellow">⚠️ {req.message}</Text>
      <Text dimColor>
        {isPerm ? "  [a] allow always   [o] allow once   [d] deny" : "  [r] retry with thinker   [c] force-continue   [a] abort"}
      </Text>
    </Box>
  );
}
