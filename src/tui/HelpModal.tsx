import React, { useRef } from "react";
import { Box, Text, useInput } from "ink";
import { sanitizeTerminalText } from "../util/text.js";

export interface CommandCheatSheet {
  command: string;
  description: string;
}

export interface ShortcutItem {
  key: string;
  description: string;
}

export const SLASH_COMMANDS: CommandCheatSheet[] = [
  { command: "/help", description: "Show this command cheat sheet" },
  { command: "/agent [id]", description: "Switch or view active agent runtime (claude, opencode, codex, omp, etc.)" },
  { command: "/models [t] [e]", description: "Switch or view active models (or open picker)" },
  { command: "/mcp [id]", description: "Inspect connected MCP servers and tools" },
  { command: "/skills", description: "Browse and preview project skills" },
  { command: "/skill <name>", description: "Execute or inject a custom skill" },
  { command: "/status", description: "Show system diagnostics (branch, sandbox, runtime, memory stats)" },
  { command: "/clear", description: "Clear conversation and stream viewport" },
  { command: "/draft or /go", description: "Trigger document drafting" },
  { command: "/quit or /abort", description: "Exit live session" },
];

export const NAVIGATION_SHORTCUTS: ShortcutItem[] = [
  { key: "Tab", description: "Cycle focus between Chat and Stream viewports" },
  { key: "↑ / ↓ or j / k", description: "Scroll chat or stream viewport" },
  { key: "PageUp / PageDown", description: "Fast-scroll focused viewport (4 lines)" },
  { key: "Esc or q", description: "Close modal / cancel current view" },
  { key: "Enter", description: "Submit command or prompt" },
];

export interface HelpModalProps {
  runtimeName: string;
  thinker: string;
  executor: string;
  projectPath: string;
  onClose: () => void;
}

export const HelpModal = React.memo(function HelpModal({
  runtimeName,
  thinker,
  executor,
  projectPath,
  onClose,
}: HelpModalProps) {
  // Sanitize all external string props at component boundary (SEC-M02)
  const safeRuntimeName = sanitizeTerminalText(runtimeName).slice(0, 40);
  const safeThinker = sanitizeTerminalText(thinker).slice(0, 60);
  const safeExecutor = sanitizeTerminalText(executor).slice(0, 60);
  const safeProject = sanitizeTerminalText(projectPath).slice(0, 120);

  // stateRef bridge ensures freshest callbacks in useInput
  const stateRef = useRef({ onClose });
  stateRef.current = { onClose };

  useInput((input, key) => {
    const cur = stateRef.current;
    if (key.escape || input === "q" || key.return) {
      cur.onClose();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      width="100%"
    >
      {/* Banner */}
      <Box justifyContent="space-between" marginBottom={0}>
        <Text bold color="cyan">
          📖 HUGINN LIVE CHEAT SHEET
        </Text>
        <Text color="gray">Esc or q to close</Text>
      </Box>

      {/* Active Config Banner */}
      <Box
        borderStyle="single"
        borderTop={true}
        borderBottom={true}
        borderLeft={false}
        borderRight={false}
        borderColor="gray"
        paddingY={0}
        marginY={0}
        flexDirection="column"
      >
        <Box justifyContent="space-between">
          <Text>
            <Text bold color="gray">Agent: </Text>
            <Text bold color="green">{safeRuntimeName} </Text>
            <Text bold color="gray">· Thinker: </Text>
            <Text bold color="magenta">{safeThinker} </Text>
            <Text bold color="gray">· Executor: </Text>
            <Text bold color="yellow">{safeExecutor}</Text>
          </Text>
        </Box>
        <Box>
          <Text color="gray" wrap="truncate-end">
            Project: <Text color="white">{safeProject}</Text>
          </Text>
        </Box>
      </Box>

      {/* Slash Commands */}
      <Box flexDirection="column" marginTop={0}>
        <Text bold color="cyan">
          ⚡ Slash Commands:
        </Text>
        {SLASH_COMMANDS.map((cmd) => (
          <Box key={cmd.command} marginY={0}>
            <Text bold color="cyan">
              {"  " + cmd.command.padEnd(20)}
            </Text>
            <Text color="white">— {cmd.description}</Text>
          </Box>
        ))}
      </Box>

      {/* Navigation Shortcuts */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="yellow">
          ⌨ Navigation & Shortcuts:
        </Text>
        {NAVIGATION_SHORTCUTS.map((s) => (
          <Box key={s.key} marginY={0}>
            <Text bold color="yellow">
              {"  " + s.key.padEnd(20)}
            </Text>
            <Text color="gray">— {s.description}</Text>
          </Box>
        ))}
      </Box>

      {/* Footer */}
      <Box
        borderStyle="single"
        borderTop={true}
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor="gray"
        paddingTop={0}
        marginTop={1}
        justifyContent="space-between"
      >
        <Text color="gray">
          Press Esc, q, or Enter to close cheat sheet
        </Text>
      </Box>
    </Box>
  );
});
