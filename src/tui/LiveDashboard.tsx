import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CycleEngine } from "../engine/cycle";
import { LiveAbortError, type LiveEngine } from "../engine/liveMode";
import type { RunConfig } from "../config";
import { events, type LiveStage } from "../engine/engineEvents";
import type { DecisionChoice, DecisionRequest } from "../engine/types";
import { Dashboard, DecisionModal, LogsCard } from "./Dashboard";
import { MarkdownLine } from "./markdown";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const VISIBLE_CHAT_LINES = 12;
const VISIBLE_STREAM_LINES = 8;
const MAX_LOGS = 4;

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

export function LiveApp({ live, cfg }: { live: LiveEngine; cfg: RunConfig }) {
  const { exit } = useApp();
  const [cycle, setCycle] = useState<CycleEngine | null>(null);

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
  return <RefineView live={live} cfg={cfg} onApprove={onApprove} />;
}

function RefineView({
  live,
  cfg,
  onApprove,
}: {
  live: LiveEngine;
  cfg: RunConfig;
  onApprove: () => Promise<void>;
}) {
  const { exit } = useApp();
  const [stage, setStage] = useState<LiveStage>("refine");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [decision, setDecision] = useState<DecisionRequest | undefined>();
  const [draftInput, setDraftInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [focusCard, setFocusCard] = useState<"chat" | "stream">("chat");
  const [chatScroll, setChatScroll] = useState(0);
  const [streamScroll, setStreamScroll] = useState(0);
  const [logs, setLogs] = useState<Array<{ level: "info" | "warn" | "error"; message: string; timestamp: string }>>([]);
  const [streamLines, setStreamLines] = useState<string[]>([]);
  const [streamChars, setStreamChars] = useState(0);
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const [now, setNow] = useState(Date.now());
  const streamBuf = useRef("");
  const logBuf = useRef<typeof logs>([]);

  useEffect(() => {
    const timer = setInterval(() => {
      setSpinnerIndex((i) => (i + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, 80);
    return () => clearInterval(timer);
  }, []);

  // Format messages into distinct lines for scrolling
  const formattedChatLines: FormattedLine[] = [];
  messages.forEach((m, mIdx) => {
    if (m.role === "system") {
      formattedChatLines.push({ id: `sys-${mIdx}`, type: "system", text: `─ ${m.text}` });
      return;
    }
    if (m.role === "user") {
      formattedChatLines.push({ id: `u-h-${mIdx}`, type: "user_header", text: "you »" });
      m.text.split("\n").forEach((l, lIdx) => {
        formattedChatLines.push({ id: `u-b-${mIdx}-${lIdx}`, type: "user_body", text: l });
      });
      formattedChatLines.push({ id: `u-sp-${mIdx}`, type: "blank", text: "" });
      return;
    }
    formattedChatLines.push({ id: `a-h-${mIdx}`, type: "assistant_header", text: "thinker »" });
    m.text.split("\n").forEach((l, lIdx) => {
      formattedChatLines.push({ id: `a-b-${mIdx}-${lIdx}`, type: "assistant_body", text: l });
    });
    formattedChatLines.push({ id: `a-sp-${mIdx}`, type: "blank", text: "" });
  });

  useEffect(() => {
    const offs: Array<() => void> = [
      events.on("liveStage", (e) => setStage(e.stage)),
      events.on("liveChat", (e) => {
        setMessages((m) => [...m, { role: e.role, text: e.text }]);
        setChatScroll(0); // auto-scroll to bottom on new message
      }),
      events.on("phaseStream", (e) => {
        streamBuf.current += e.text;
        const lines = streamBuf.current.split("\n");
        setStreamLines(lines);
        setStreamChars((c) => c + e.text.length);
      }),
      events.on("log", (e) => {
        const time = e.timestamp ? new Date(e.timestamp).toTimeString().split(" ")[0] : new Date().toTimeString().split(" ")[0];
        logBuf.current = [...logBuf.current.slice(-(MAX_LOGS - 1)), { level: e.level, message: e.message, timestamp: time }];
        setLogs(logBuf.current);
      }),
      events.on("decision", (req) => setDecision(req)),
      events.on("decisionResolved", () => setDecision(undefined)),
      events.on("done", () => {
        setTimeout(() => exit(), 500);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [exit]);

  const inputEnabled = !busy && stage !== "draft" && !decision;

  // Seed the CLI-provided initial idea into the conversation (matches headless).
  const seededIdea = useRef(false);
  useEffect(() => {
    const idea = live.ideaText.trim();
    if (!idea || seededIdea.current) return;
    seededIdea.current = true;
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
  }, [live]);

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
    setBusy(true);
    try {
      await live.chat(text);
    } catch (err) {
      failSession(err);
    } finally {
      setBusy(false);
    }
  };

  const maxChatScroll = Math.max(0, formattedChatLines.length - VISIBLE_CHAT_LINES);
  const maxStreamScroll = Math.max(0, streamLines.length - VISIBLE_STREAM_LINES);

  useInput((input, key) => {
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

    if (inputEnabled) {
      if (key.return) {
        void submit();
        return;
      }
      if (key.backspace) {
        setDraftInput((d) => d.slice(0, -1));
        return;
      }
      if (input) setDraftInput((d) => d + input);
    } else if (input === "q" && draftInput === "") {
      live.requestAbort();
      failSession(new LiveAbortError());
    }
  });

  const spinner = SPINNER_FRAMES[spinnerIndex] ?? "⠋";

  // Slice visible lines for Chat
  const chatStart = Math.max(0, formattedChatLines.length - VISIBLE_CHAT_LINES - chatScroll);
  const visibleChatLines = formattedChatLines.slice(chatStart, chatStart + VISIBLE_CHAT_LINES);

  // Slice visible lines for Stream
  const streamStart = Math.max(0, streamLines.length - VISIBLE_STREAM_LINES - streamScroll);
  const visibleStreamLines = streamLines.slice(streamStart, streamStart + VISIBLE_STREAM_LINES);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <LiveHeader stage={stage} cfg={cfg} now={now} spinner={spinner} />

      <ScrollableChatCard
        lines={visibleChatLines}
        totalLines={formattedChatLines.length}
        scrollOffset={chatScroll}
        maxScroll={maxChatScroll}
        isFocused={focusCard === "chat"}
        busy={busy}
        spinner={spinner}
      />

      <ScrollableStreamCard
        lines={visibleStreamLines}
        totalLines={streamLines.length}
        scrollOffset={streamScroll}
        chars={streamChars}
        isFocused={focusCard === "stream"}
        spinner={spinner}
        busy={busy}
      />

      {logs.length > 0 && <LogsCard logs={logs} />}

      {decision ? <DecisionModal req={decision} /> : null}

      <ChatInputRow value={draftInput} enabled={inputEnabled} placeholder="Message...  /draft when ready · /quit to abort" />
      <Box justifyContent="space-between">
        <Text dimColor>[Tab] Toggle focus · [PageUp/Down] or [↑/↓] Scroll · [Enter] Send · /draft to draft · /quit to abort</Text>
        <Text dimColor>stage: {STAGE_LABEL[stage].label}</Text>
      </Box>
    </Box>
  );
}

function LiveHeader({ stage, cfg, now, spinner }: { stage: LiveStage; cfg: RunConfig; now: number; spinner: string }) {
  const s = STAGE_LABEL[stage];
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text bold color="cyan">🦅 HUGINN LIVE </Text>
          <Text bold color={s.color}>
            [{spinner} {s.label}]
          </Text>
        </Box>
        <Text dimColor>project: {cfg.projectPath}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>thinker: </Text>
        <Text color="magenta">{cfg.thinker}</Text>
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
}: {
  lines: FormattedLine[];
  totalLines: number;
  scrollOffset: number;
  maxScroll: number;
  isFocused: boolean;
  busy: boolean;
  spinner: string;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={isFocused ? "cyanBright" : "gray"}
      flexDirection="column"
      paddingX={1}
      minHeight={VISIBLE_CHAT_LINES + 3}
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
        <Box marginY={1} justifyContent="center">
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
}: {
  lines: string[];
  totalLines: number;
  scrollOffset: number;
  chars: number;
  isFocused: boolean;
  spinner: string;
  busy: boolean;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={isFocused ? "cyanBright" : "gray"}
      flexDirection="column"
      paddingX={1}
      minHeight={VISIBLE_STREAM_LINES + 3}
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
        <Box justifyContent="center" marginY={1}>
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