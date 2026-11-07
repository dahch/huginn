import React from "react";
import { render } from "ink";
import type { AgentTarget } from "../agents/integrator.js";
import { AgentPickerModal, type AgentScope } from "./AgentPickerModal.js";

/** The detected rows the picker renders: id, availability and the resolved path. */
export interface AgentDetectionRow {
  id: AgentTarget;
  available: boolean;
  path?: string;
}

/** What the picker resolved, or `undefined` when the user pressed Esc. */
export interface PickedAgent {
  id: AgentTarget;
  scope: AgentScope;
}

export interface PickAgentOptions {
  /** The runtime currently configured (marked, not selectable-as-new). */
  currentAgentId: string;
  /**
   * Availability probe. Callers that already scanned PATH pass the result so the
   * wizard does not probe the machine twice.
   */
  detect?: () => Promise<AgentDetectionRow[]>;
  /** Scopes the host can persist; defaults to the picker's own default (all). */
  scopes?: readonly AgentScope[];
  /** Rows the list window may use before it scrolls. */
  maxRows?: number;
  /** Stream overrides, so a caller (or a test) can own the terminal. */
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

/**
 * Mount the console's runtime picker as a one-shot prompt and unmount it when it
 * resolves.
 *
 * `huginn init` used to print a numbered list and read a number, so choosing a
 * runtime meant counting lines. The live console already had a real selector
 * (availability probed, active runtime marked, `↑`/`↓`/`k`/`j` and `Esc`), and
 * this is the seam that lets the wizard reuse it without a second implementation.
 *
 * Contract: resolves `undefined` on Esc/abort, and never rejects for a user
 * action — a caller wires its non-interactive fallback from the returned value,
 * not from an exception.
 */
export async function pickAgentInteractively(
  options: PickAgentOptions,
): Promise<PickedAgent | undefined> {
  return new Promise<PickedAgent | undefined>((resolve) => {
    let settled = false;
    let instance: ReturnType<typeof render> | undefined;
    const finish = (value: PickedAgent | undefined): void => {
      if (settled) return;
      settled = true;
      instance?.unmount();
      resolve(value);
    };
    instance = render(
      React.createElement(AgentPickerModal, {
        currentAgentId: options.currentAgentId,
        detect: options.detect,
        scopes: options.scopes,
        maxRows: options.maxRows,
        onSelect: (id, scope) => finish({ id, scope }),
        onCancel: () => finish(undefined),
      }),
      {
        stdout: options.stdout ?? process.stdout,
        stdin: options.stdin ?? process.stdin,
        // The wizard prints its own lines around this frame; letting Ink capture
        // console output would swallow them.
        patchConsole: false,
      },
    );
  });
}
