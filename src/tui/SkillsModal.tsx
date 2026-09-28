import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Skill } from "../engine/skills/types.js";

export interface SkillsModalProps {
  skills: Skill[];
  onSelect: (skill: Skill) => void;
  onClose: () => void;
}

const VISIBLE_LIST_ITEMS = 8;
const VISIBLE_BODY_LINES = 8;

export const SkillsModal = React.memo(function SkillsModal({
  skills,
  onSelect,
  onClose,
}: SkillsModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewScroll, setPreviewScroll] = useState(0);
  const [focusPane, setFocusPane] = useState<"list" | "preview">("list");

  const currentSkill = skills[selectedIndex];
  const bodyLines = (currentSkill?.body ?? "").split("\n");
  const maxBodyScroll = Math.max(0, bodyLines.length - VISIBLE_BODY_LINES);

  // List scroll window calculation
  const listOffset = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(VISIBLE_LIST_ITEMS / 2),
      Math.max(0, skills.length - VISIBLE_LIST_ITEMS),
    ),
  );
  const visibleSkills = skills.slice(listOffset, listOffset + VISIBLE_LIST_ITEMS);

  // stateRef bridge ensures useInput has freshest values under React 19
  const stateRef = useRef({
    skills,
    selectedIndex,
    previewScroll,
    maxBodyScroll,
    focusPane,
    onSelect,
    onClose,
  });
  stateRef.current = {
    skills,
    selectedIndex,
    previewScroll,
    maxBodyScroll,
    focusPane,
    onSelect,
    onClose,
  };

  useInput((input, key) => {
    const cur = stateRef.current;

    if (key.escape || input === "q") {
      cur.onClose();
      return;
    }

    if (key.tab) {
      setFocusPane((p) => (p === "list" ? "preview" : "list"));
      return;
    }

    if (key.return) {
      if (cur.skills[cur.selectedIndex]) {
        cur.onSelect(cur.skills[cur.selectedIndex]!);
      }
      return;
    }

    if (key.pageUp) {
      setPreviewScroll((s) => Math.max(0, s - 4));
      return;
    }
    if (key.pageDown) {
      setPreviewScroll((s) => Math.min(cur.maxBodyScroll, s + 4));
      return;
    }

    if (cur.focusPane === "list") {
      if (key.upArrow || input === "k") {
        setSelectedIndex((i) => Math.max(0, i - 1));
        setPreviewScroll(0);
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedIndex((i) => Math.min(cur.skills.length - 1, i + 1));
        setPreviewScroll(0);
        return;
      }
    } else {
      if (key.upArrow || input === "k") {
        setPreviewScroll((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setPreviewScroll((s) => Math.min(cur.maxBodyScroll, s + 1));
        return;
      }
    }
  });

  const visiblePreviewLines = bodyLines.slice(
    previewScroll,
    previewScroll + VISIBLE_BODY_LINES,
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="green"
      paddingX={1}
      paddingY={0}
      width="100%"
    >
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={0}>
        <Text bold color="green">
          ⚡ PROJECT SKILLS BROWSER
        </Text>
        <Text color="gray">
          Focus: <Text bold color="white">{focusPane.toUpperCase()}</Text> (Tab to switch · Esc to cancel)
        </Text>
      </Box>

      {/* Main Two-Pane Body */}
      <Box flexDirection="row" width="100%" marginY={0}>
        {/* Left Pane: Skills List */}
        <Box
          flexDirection="column"
          width="42%"
          borderStyle="single"
          borderRight={true}
          borderLeft={false}
          borderTop={false}
          borderBottom={false}
          borderColor={focusPane === "list" ? "green" : "gray"}
          paddingRight={1}
        >
          <Box marginBottom={0}>
            <Text bold color={focusPane === "list" ? "green" : "gray"}>
              Available Skills ({skills.length})
            </Text>
          </Box>
          {skills.length === 0 ? (
            <Text color="yellow">No skills found in project or built-ins</Text>
          ) : (
            visibleSkills.map((s, relIdx) => {
              const actualIdx = listOffset + relIdx;
              const isSelected = actualIdx === selectedIndex;
              const isBuiltin = s.builtin ?? false;
              const badge = isBuiltin ? "[builtin]" : "[project]";
              const badgeColor = isBuiltin ? "cyan" : "green";

              return (
                <Box key={s.id} justifyContent="space-between">
                  <Box>
                    <Text bold color={isSelected ? "green" : "gray"}>
                      {isSelected ? " › " : "   "}
                    </Text>
                    <Text bold={isSelected} color={isSelected ? "white" : "gray"}>
                      {s.name.slice(0, 18).padEnd(19)}
                    </Text>
                  </Box>
                  <Text color={badgeColor}>{badge}</Text>
                </Box>
              );
            })
          )}
          {skills.length > VISIBLE_LIST_ITEMS && (
            <Box justifyContent="center" marginTop={0}>
              <Text color="gray" dimColor>
                showing {listOffset + 1}-{Math.min(skills.length, listOffset + VISIBLE_LIST_ITEMS)} of {skills.length}
              </Text>
            </Box>
          )}
        </Box>

        {/* Right Pane: Skill Details & Prompt Preview */}
        <Box
          flexDirection="column"
          width="58%"
          paddingLeft={1}
        >
          {currentSkill ? (
            <>
              <Box justifyContent="space-between">
                <Text bold color="cyan">
                  {currentSkill.name}
                </Text>
                <Text color="gray">id: {currentSkill.id}</Text>
              </Box>

              <Box marginTop={0}>
                <Text color="white" wrap="wrap">
                  {currentSkill.description}
                </Text>
              </Box>

              <Box marginTop={0}>
                <Text color="yellow">
                  Triggers:{" "}
                  <Text color="white">
                    {currentSkill.triggers.length > 0
                      ? currentSkill.triggers.join(", ")
                      : "(none)"}
                  </Text>
                </Text>
              </Box>

              <Box marginTop={0}>
                <Text color="gray" wrap="truncate-end">
                  Path: {currentSkill.filePath}
                </Text>
              </Box>

              <Box
                flexDirection="column"
                borderStyle="single"
                borderColor={focusPane === "preview" ? "green" : "gray"}
                paddingX={1}
                paddingY={0}
                marginTop={0}
              >
                <Box justifyContent="space-between">
                  <Text bold color={focusPane === "preview" ? "green" : "gray"}>
                    Prompt Body:
                  </Text>
                  {maxBodyScroll > 0 && (
                    <Text color="gray" dimColor>
                      line {previewScroll + 1}-{Math.min(bodyLines.length, previewScroll + VISIBLE_BODY_LINES)} / {bodyLines.length}
                    </Text>
                  )}
                </Box>
                {visiblePreviewLines.map((line, idx) => (
                  <Text key={idx} color="white" wrap="truncate-end">
                    {line || " "}
                  </Text>
                ))}
              </Box>
            </>
          ) : (
            <Text color="gray">No skill selected</Text>
          )}
        </Box>
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
        marginTop={0}
        justifyContent="space-between"
      >
        <Text color="gray">
          ↑/↓: navigate · Tab: switch pane · Enter: execute skill · Esc/q: cancel
        </Text>
        {currentSkill && (
          <Text color="gray">
            Selected: <Text color="green">{currentSkill.name}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
});
