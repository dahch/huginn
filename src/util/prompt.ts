import { createInterface } from "node:readline";

/**
 * The stdio + environment seam every prompt reads. Callers (the init wizard)
 * may inject their own values; each field defaults to the real `process.*`
 * primitive, so production code can omit the seam.
 */
export interface PromptIo {
  /** Environment consulted for `CI`; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Input stream; defaults to `process.stdin`. */
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Output stream; defaults to `process.stdout`. */
  stdout?: NodeJS.WritableStream & { isTTY?: boolean };
}

/**
 * Ask for one line of text on the terminal. Returns `fallback` (never reads
 * input) when the injected environment is CI or either stream is not a TTY —
 * in that context nothing should block or wait on a human. A blank answer also
 * resolves to `fallback`. Single implementation shared by {@link promptYesNo}
 * and the init wizard's text/choice prompts.
 */
export function promptLine(question: string, fallback: string, io: PromptIo = {}): Promise<string> {
  const env = io.env ?? process.env;
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  if (env.CI || !stdin.isTTY || !stdout.isTTY) {
    return Promise.resolve(fallback);
  }
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolveAnswer(trimmed.length > 0 ? trimmed : fallback);
    });
  });
}

/**
 * Ask a yes/no question on the terminal. Delegates the TTY/CI guard and the
 * readline plumbing to {@link promptLine}, so it returns `fallback` immediately
 * when the process is non-interactive.
 */
export async function promptYesNo(
  question: string,
  fallback = false,
  io: PromptIo = {},
): Promise<boolean> {
  const answer = await promptLine(`${question} [y/N] `, fallback ? "yes" : "no", io);
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}
