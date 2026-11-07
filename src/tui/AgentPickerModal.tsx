import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { AGENT_REGISTRY, AGENT_TARGETS, type AgentTarget } from "../agents/integrator.js";
import { detectAvailableAgents } from "../engine/agent/registry.js";
import { sanitizeTerminalText } from "../util/text.js";
import { Modal } from "./Modal.js";
import { PickerList } from "./PickerList.js";
import { MODAL_TITLE_GLYPHS, STATUS_GLYPHS } from "./glyphs.js";
import { THEME } from "./theme.js";

/** Rows the list window may occupy before it scrolls (REQ-33 / AC-33.1). */
export const VISIBLE_AGENT_ROWS = 6;

/** Rows the modal needs beyond the list window (border 2 + header 2 + note 1). */
export const AGENT_PICKER_CHROME_ROWS = 5;

export interface AgentPickerRow {
  id: AgentTarget;
  label: string;
  available: boolean;
  path?: string;
}

/** Where a runtime change is kept (mirrors `ProfileScope`). */
export type AgentScope = "session" | "project" | "global";

/** Every persistence scope, in the order the hint advertises them. */
export const AGENT_SCOPES: readonly AgentScope[] = ["session", "project", "global"];

export interface AgentPickerModalProps {
  /** The runtime currently driving the session (marked, not selectable-as-new). */
  currentAgentId: string;
  /** `scope` says whether the change is kept for the session, the project or globally. */
  onSelect: (id: AgentTarget, scope: AgentScope) => void;
  onCancel: () => void;
  /**
   * Availability probe. Injected so the component is deterministic under test and
   * the view does not reach into the engine registry directly (REV-304).
   */
  detect?: () => Promise<Array<{ id: AgentTarget; available: boolean; path?: string }>>;
  /** Rows the list window may use; shrinks on short terminals. */
  maxRows?: number;
  /**
   * Scopes this host can actually persist. Defaults to all three (the live
   * console). `huginn init` passes `["project"]` because it always writes
   * `<project>/.huginn/config.json` — offering `s`/`g` there would promise a
   * write the wizard does not perform.
   */
  scopes?: readonly AgentScope[];
}

/**
 * The scopes a picker may offer, in a stable order and without duplicates.
 * An empty or unknown-only list falls back to every scope rather than rendering
 * a picker whose Enter has nowhere to save.
 */
export function resolveAgentScopes(scopes?: readonly AgentScope[]): AgentScope[] {
  if (scopes === undefined) return [...AGENT_SCOPES];
  const known = scopes.filter((scope): scope is AgentScope => AGENT_SCOPES.includes(scope));
  return known.length > 0 ? [...new Set(known)] : [...AGENT_SCOPES];
}

/** What Enter persists when the host does not offer `project`. */
function enterScopeFor(scopes: AgentScope[]): AgentScope {
  if (scopes.includes("project")) return "project";
  if (scopes.includes("session")) return "session";
  return "global";
}

/** One footer row naming exactly the keys this picker accepts. */
export function agentPickerHint(scopes: AgentScope[]): string {
  const keys = ["↑/↓ or k/j move"];
  const enter = enterScopeFor(scopes);
  keys.push(enter === "project" ? "Enter project" : enter === "session" ? "Enter session" : "Enter global");
  if (scopes.includes("project") && scopes.includes("session")) keys.push("s session");
  if (scopes.length > 1 && scopes.includes("global")) keys.push("g global");
  keys.push("Esc cancel");
  return keys.join(" · ");
}

/**
 * The note under the list. It only mentions a scope the host can honour, so
 * `huginn init` cannot advertise "g for every project" while writing the
 * project config.
 */
export function agentPickerNote(scopes: AgentScope[]): string[] {
  const lines: string[] = [];
  if (scopes.length === 1) {
    lines.push("Enter saves it for this project.");
  } else {
    const parts = ["Enter saves it for this project"];
    if (scopes.includes("session")) parts.push("s only until you quit");
    if (scopes.includes("global")) parts.push("g for every project");
    lines.push(`${parts.join(" · ")}.`);
  }
  if (scopes.includes("project")) {
    lines.push("Muninn memory is project-scoped and unaffected.");
  }
  return lines;
}

const byAgentId = (a: AgentPickerRow, b: AgentPickerRow): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function rowFor(
  id: AgentTarget,
  found?: { available: boolean; path?: string },
): AgentPickerRow {
  return {
    id,
    label: AGENT_REGISTRY[id]?.label ?? id,
    available: found?.available ?? false,
    path: found?.path,
  };
}

/**
 * The runtimes this machine actually has, alphabetically.
 *
 * The picker used to render all thirteen targets in registry order, which made
 * the user scroll past eight binaries that are not installed and taught them a
 * list that says nothing about their machine. Only detected runtimes are listed;
 * when detection finds none (or the probe throws) every target is shown
 * alphabetically as unavailable, because an empty modal explains nothing.
 */
export function buildAgentRows(
  detected: Array<{ id: AgentTarget; available: boolean; path?: string }>,
): AgentPickerRow[] {
  const found = new Map(detected.map((entry) => [entry.id, entry]));
  const available = AGENT_TARGETS.map((id) => rowFor(id, found.get(id)))
    .filter((row) => row.available)
    .sort(byAgentId);
  if (available.length > 0) return available;
  return AGENT_TARGETS.map((id) => rowFor(id)).sort(byAgentId);
}

/** True when the rows describe a real installation rather than a failed probe. */
export function hasDetectedRows(rows: AgentPickerRow[]): boolean {
  return rows.some((row) => row.available);
}

/**
 * Interactive runtime picker (REQ-33 / ADR-32).
 *
 * `/agent` used to *list* runtimes and tell the user to type an id, so selecting
 * one (e.g. `agy`) meant memorising it. This modal makes runtimes selectable like
 * models: availability is probed, the active runtime is marked, available entries
 * carry the measured availability mark (and the highlighted one its resolved path),
 * and Enter switches — the caller keeps the modal open when the switch fails so the
 * user can pick another immediately.
 */
export function AgentPickerModal({
  currentAgentId,
  onSelect,
  onCancel,
  detect = detectAvailableAgents,
  maxRows = VISIBLE_AGENT_ROWS,
  scopes,
}: AgentPickerModalProps): React.ReactElement {
  const allowedScopes = useMemo(() => resolveAgentScopes(scopes), [scopes]);
  const enterScope = enterScopeFor(allowedScopes);
  const [rows, setRows] = useState<AgentPickerRow[]>(() =>
    buildAgentRows(AGENT_TARGETS.map((id) => ({ id, available: false }))),
  );
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const detected = await detect();
        if (active) setRows(buildAgentRows(detected));
      } catch {
        // Detection failure is not fatal: every row simply reads unavailable.
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [detect]);

  // Open on the active runtime so Enter is a no-op rather than an accidental
  // switch. When it is not installed it is not in the list at all, so the
  // highlight goes to the first row instead of keeping whatever index the
  // fallback list clamped it to.
  useEffect(() => {
    const index = rows.findIndex((r) => r.id === currentAgentId);
    setSelectedIndex(index >= 0 ? index : 0);
  }, [rows, currentAgentId]);

  // Keep the highlight in bounds if the row set ever shrinks (REV-305).
  useEffect(() => {
    setSelectedIndex((i) => Math.min(Math.max(i, 0), Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  const stateRef = useRef({ rows, selectedIndex, onSelect, onCancel, allowedScopes, enterScope });
  stateRef.current = { rows, selectedIndex, onSelect, onCancel, allowedScopes, enterScope };

  useInput((input, key) => {
    const cur = stateRef.current;
    if (key.escape) {
      cur.onCancel();
      return;
    }
    if (key.upArrow || input === "k") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setSelectedIndex((i) => Math.min(Math.max(cur.rows.length - 1, 0), i + 1));
      return;
    }
    const chosen = cur.rows[cur.selectedIndex];
    if (key.return) {
      if (chosen) cur.onSelect(chosen.id, cur.enterScope);
      return;
    }
    if (!chosen) return;
    // Enter persists for the project because that is what a runtime switch
    // means: this repository runs on this agent. `s` is the escape hatch for a
    // one-off try. Every key is printed in the hint and in the note below, so
    // nothing here has to be guessed — and a host that cannot persist a scope
    // never binds its key.
    const pressed = input.toLowerCase();
    if (pressed === "s" && cur.allowedScopes.includes("session")) {
      cur.onSelect(chosen.id, "session");
    } else if (pressed === "g" && cur.allowedScopes.includes("global")) {
      cur.onSelect(chosen.id, "global");
    }
  });

  return (
    <Modal
      title={`${MODAL_TITLE_GLYPHS.agent} SELECT AGENT RUNTIME`}
      hint={agentPickerHint(allowedScopes)}
    >
      {loading ? (
        <Text color={THEME.warn}>Detecting installed agent CLIs…</Text>
      ) : (
        <Box flexDirection="column">
          {!hasDetectedRows(rows) && (
            <Text color={THEME.warn} wrap="truncate">
              No agent CLI detected on PATH — showing every known target.
            </Text>
          )}
          <PickerList
            items={rows}
            selectedIndex={selectedIndex}
            maxRows={maxRows}
            renderItem={(row, selected) => {
              const isActive = row.id === currentAgentId;
              return (
                <Box key={row.id} flexDirection="column">
                  <Text wrap="truncate">
                    <Text color={selected ? THEME.accentStrong : THEME.accent} bold={selected}>
                      {selected ? "▸ " : "  "}
                      {sanitizeTerminalText(row.label)}
                    </Text>
                    <Text color={THEME.muted}> ({sanitizeTerminalText(row.id)})</Text>
                    {isActive && <Text color={THEME.executor}> ● active</Text>}
                    {row.available ? (
                      <Text color={THEME.ok}> {STATUS_GLYPHS.pass}</Text>
                    ) : (
                      <Text color={THEME.warn}> — not installed</Text>
                    )}
                  </Text>
                  {selected && row.path && (
                    <Text color={THEME.muted} wrap="truncate">
                      {"      "}
                      {sanitizeTerminalText(row.path)}
                    </Text>
                  )}
                </Box>
              );
            }}
          />
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {agentPickerNote(allowedScopes).map((line) => (
          <Text key={line} color={THEME.muted} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
    </Modal>
  );
}
