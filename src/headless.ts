import { createInterface } from "node:readline";
import type { CycleEngine } from "./engine/cycle";
import { events } from "./engine/engineEvents";
import type { DecisionChoice, DecisionRequest } from "./engine/types";

export async function runHeadless(engine: CycleEngine): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });

  const tty = Boolean(process.stdin.isTTY);

  let streamEOL = true;

  const writeLine = (line: string) => {
    if (!streamEOL) process.stdout.write("\n");
    process.stdout.write(line);
    streamEOL = true;
  };

  const askDecision = (req: DecisionRequest): Promise<DecisionChoice> => {
    return new Promise((resolve) => {
      if (!tty) {
        // Unattended (CI / pipe): no human available. Abort so state is preserved
        // and the run can be resumed interactively later.
        process.stdout.write(`\n⚠️  ${req.message}\n`);
        if (req.kind === "permission") {
          resolve("deny");
        } else {
          process.stdout.write(`   (non-interactive stdin — aborting; use --resume to continue later)\n`);
          resolve("abort");
        }
        return;
      }
      const label =
        req.kind === "permission"
          ? "  [a] allow always  [o] allow once  [d] deny"
          : "  [r] retry  [c] force-continue  [a] abort";
      process.stdout.write(`\n⚠️  ${req.message}\n${label}\n> `);
      const onLine = (line: string) => {
        const c = line.trim().toLowerCase().slice(0, 1);
        if (req.kind === "permission") {
          if (c === "a") return resolve("continue");
          if (c === "o") return resolve("retry");
          if (c === "d") return resolve("deny");
        } else {
          if (c === "r") return resolve("retry");
          if (c === "c") return resolve("continue");
          if (c === "a") return resolve("abort");
        }
        process.stdout.write(`> `);
        rl.once("line", onLine);
      };
      rl.once("line", onLine);
    });
  };

  const offs: Array<() => void> = [];
  offs.push(
    events.on("phaseStart", (e) => {
      writeLine(`\n▶ iter ${e.iteration} | ${e.phase} | attempt ${e.attempt} | ${e.model}\n`);
    }),
  );
  offs.push(
    events.on("phaseStream", (e) => {
      process.stdout.write(e.text);
      streamEOL = e.text.endsWith("\n");
    }),
  );
  offs.push(
    events.on("verdict", (e) => {
      const icon = e.verdict === "pass" ? "✅" : e.verdict === "warning" ? "🟡" : "🔴";
      writeLine(`${icon} iter ${e.iteration} | ${e.phase} | ${e.verdict}`);
    }),
  );
  offs.push(
    events.on("decision", (req) => {
      void askDecision(req).then((choice) => engine.resolveDecision(choice));
    }),
  );
  offs.push(
    events.on("log", (e) => {
      writeLine(`[${e.level}] ${e.message}`);
    }),
  );

  try {
    await engine.run();
  } finally {
    for (const off of offs) off();
    rl.close();
  }
}
