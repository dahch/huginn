import React, { useRef } from "react";
import { Box, Text, useInput } from "ink";
import { sanitizeTerminalText } from "../util/text.js";
import {
  SLASH_COMMANDS as COMMAND_REGISTRY,
  commandUsage,
  describeCommand,
} from "./commandRegistry.js";

export interface CommandCheatSheet {
  command: string;
  description: string;
}

export interface ShortcutItem {
  key: string;
  description: string;
}

/**
 * Generated from the command registry (ADR-28 / AC-28.1) so the cheat sheet can
 * never advertise a command the dispatcher does not implement.
 */
export const SLASH_COMMANDS: CommandCheatSheet[] = COMMAND_REGISTRY.map((command) => ({
  command: commandUsage(command),
  description: describeCommand(command),
}));

/** Column width for the command cell, sized so usage + arg hint never wraps. */
const COMMAND_COLUMN_WIDTH =
  SLASH_COMMANDS.reduce((widest, entry) => Math.max(widest, entry.command.length), 0) + 3;

export const NAVIGATION_SHORTCUTS: ShortcutItem[] = [
  { key: "Tab", description: "Cycle focus between Chat and Stream viewports" },
  {
    key: "/ then ↑ / ↓",
    description: "Filter the inline command palette (Tab accepts, Enter runs, Esc dismisses)",
  },
  { key: "↑ / ↓ or j / k", description: "Scroll viewport (or move the command palette while typing a /command)" },
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
          <Box key={cmd.command} marginY={0} flexDirection="row">
            <Box width={COMMAND_COLUMN_WIDTH} flexShrink={0}>
              <Text bold color="cyan" wrap="truncate">
                {"  " + cmd.command}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text color="white">— {cmd.description}</Text>
            </Box>
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
