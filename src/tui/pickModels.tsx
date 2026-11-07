import React from "react";
import { render } from "ink";
import type { ModelCatalogSource } from "../engine/agent/port.js";
import {
  ModelPickerModal,
  type ModelPickerResult,
} from "./ModelPickerModal.js";

export interface PickModelsOptions {
  /** The runtime whose catalog is being listed (already discovered by the caller). */
  runtime: ModelCatalogSource;
  initialThinker?: string;
  initialExecutor?: string;
  /** Ask for the persistence scope (live console) or skip it (init). */
  saveScopeStep?: "ask" | "skip";
  /** Scope reported when the step is skipped. */
  defaultSaveScope?: ModelPickerResult["saveScope"];
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

/**
 * Mount the console's thinker → executor picker as a one-shot prompt.
 *
 * `huginn init` used to print the whole catalog as a numbered list and read two
 * numbers. The modal already knows how to filter thousands of models and how to
 * walk thinker → executor; this seam gives the wizard that behaviour without a
 * second implementation, and resolves `undefined` on Esc.
 */
export async function pickModelsInteractively(
  options: PickModelsOptions,
): Promise<ModelPickerResult | undefined> {
  return new Promise<ModelPickerResult | undefined>((resolve) => {
    let settled = false;
    let instance: ReturnType<typeof render> | undefined;
    const finish = (value: ModelPickerResult | undefined): void => {
      if (settled) return;
      settled = true;
      instance?.unmount();
      resolve(value);
    };
    instance = render(
      React.createElement(ModelPickerModal, {
        runtime: options.runtime,
        initialThinker: options.initialThinker,
        initialExecutor: options.initialExecutor,
        saveScopeStep: options.saveScopeStep,
        defaultSaveScope: options.defaultSaveScope,
        onSelect: (result) => finish(result),
        onCancel: () => finish(undefined),
      }),
      {
        stdout: options.stdout ?? process.stdout,
        stdin: options.stdin ?? process.stdin,
        patchConsole: false,
      },
    );
  });
}
