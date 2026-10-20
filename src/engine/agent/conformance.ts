import type { RuntimeCapabilities, RuntimeEvent, RuntimePort } from "./port.js";

/**
 * The driver-agnostic part of the runtime contract.
 *
 * Written as plain functions (not as `it(...)` blocks) so the same cases can run
 * under `bun test`, `vitest` or a future `huginn runtime verify` command: a case
 * either resolves or throws with an explanation.
 */
export interface ConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

export interface ConformanceOptions {
  /** A port that behaves correctly; called once per case. */
  makePort: () => RuntimePort;
  /** A port whose prompts fail; enables the error-propagation case. */
  makeFailingPort?: () => RuntimePort;
}

const CAPABILITY_FLAGS = [
  "inProcess",
  "structuredEvents",
  "streaming",
  "sessionHistory",
  "sessionResume",
  "structuredOutput",
  "usageCost",
  "mcpListing",
  "interrupt",
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Events a session reports, in order. */
function collect(): { events: RuntimeEvent[]; sink: (event: RuntimeEvent) => void } {
  const events: RuntimeEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

export function conformanceCases(options: ConformanceOptions): ConformanceCase[] {
  const cases: ConformanceCase[] = [
    {
      name: "declares an identity and a complete capability set",
      async run() {
        const port = options.makePort();
        assert(isNonEmptyString(port.id), "the port has no id");
        assert(isNonEmptyString(port.name), "the port has no name");
        const caps = port.capabilities as RuntimeCapabilities;
        for (const flag of CAPABILITY_FLAGS) {
          assert(typeof caps[flag] === "boolean", `capability "${flag}" is not a boolean`);
        }
        assert(
          ["none", "gate", "interactive"].includes(caps.permissions),
          `capability "permissions" is not a known mode: ${String(caps.permissions)}`,
        );
        assert(
          ["none", "static", "dynamic"].includes(caps.modelCatalog),
          `capability "modelCatalog" is not a known mode: ${String(caps.modelCatalog)}`,
        );
      },
    },

    {
      name: "only claims capabilities that imply each other",
      async run() {
        const caps = options.makePort().capabilities;
        // A resumed session is a session with history, or resuming is meaningless.
        assert(!caps.sessionResume || caps.sessionHistory, "sessionResume requires sessionHistory");
        // Per-tool questions need a way to stop a turn.
        assert(!(caps.permissions === "interactive") || caps.interrupt, "interactive permissions require interrupt");
        // Incremental text is the minimal structured event.
        assert(!caps.streaming || caps.structuredEvents, "streaming requires structuredEvents");
      },
    },

    {
      name: "answers availability as a decision instead of throwing",
      async run() {
        const availability = await options.makePort().isAvailable();
        assert(typeof availability.ok === "boolean", "availability.ok is not a boolean");
        if (!availability.ok) {
          assert(
            isNonEmptyString(availability.reason),
            "an unavailable driver must explain why (availability.reason)",
          );
        }
      },
    },

    {
      name: "lists models without throwing, with well-formed entries",
      async run() {
        const catalog = await options.makePort().listModels();
        assert(Array.isArray(catalog.models), "listModels().models is not an array");
        for (const model of catalog.models) {
          assert(isNonEmptyString(model.id), "a model has no id");
          assert(isNonEmptyString(model.name), `model "${model.id}" has no name`);
          assert(isNonEmptyString(model.provider), `model "${model.id}" has no provider`);
        }
        if (catalog.models.length === 0 && catalog.reason !== undefined) {
          assert(isNonEmptyString(catalog.reason), "an empty catalog must carry a real reason, not an empty string");
        }
      },
    },

    {
      name: "resolves a model reference or explains the refusal, never throws",
      async run() {
        const port = options.makePort();
        const accepted = port.resolveModel("provider/model");
        assert(accepted.ok === true, "a provider/model reference must be accepted by the bridge");
        const rejected = port.resolveModel("   ");
        assert(rejected.ok === false, "an empty reference must be rejected");
        assert(isNonEmptyString(rejected.reason), "a rejected reference must explain why");
      },
    },

    {
      name: "creates a session whose resumability matches its capabilities",
      async run() {
        const port = options.makePort();
        const session = await port.createSession({ title: "conformance" });
        try {
          assert(isNonEmptyString(session.id), "the session has no id");
          assert(
            session.resumable === port.capabilities.sessionResume,
            "session.resumable disagrees with capabilities.sessionResume",
          );
        } finally {
          await session.close();
        }
      },
    },

    {
      name: "reports one done event, last, carrying the returned result",
      async run() {
        const port = options.makePort();
        const { events, sink } = collect();
        const session = await port.createSession({ title: "conformance", sink });
        try {
          const result = await session.prompt({ text: "hello" });
          assert(isNonEmptyString(result.messageId), "the prompt result has no messageId");
          const done = events.filter((event) => event.type === "done");
          assert(done.length === 1, `expected exactly one done event, got ${done.length}`);
          assert(events.at(-1)?.type === "done", "the done event must be the last one");
          assert(
            done[0]?.type === "done" && done[0].result === result,
            "the done event must carry the same result the prompt resolved with",
          );
          const permissionEvents = events.filter((event) => event.type === "permission.request");
          if (port.capabilities.permissions === "none") {
            assert(permissionEvents.length === 0, "a driver without permission support must not emit permission events");
          }
        } finally {
          await session.close();
        }
      },
    },

    {
      name: "interrupts and closes safely, and close is idempotent",
      async run() {
        const port = options.makePort();
        const session = await port.createSession({ title: "conformance" });
        await session.interrupt("conformance");
        await session.close();
        await session.close();
      },
    },
  ];

  if (options.makeFailingPort) {
    cases.push({
      name: "reports a failed prompt as an error event and still rejects",
      async run() {
        const port = options.makeFailingPort!();
        const { events, sink } = collect();
        const session = await port.createSession({ title: "conformance", sink });
        try {
          let rejected: unknown;
          try {
            await session.prompt({ text: "fail" });
          } catch (err) {
            rejected = err;
          }
          assert(rejected !== undefined, "a failing prompt must reject");
          const errors = events.filter((event) => event.type === "error");
          assert(errors.length === 1, `expected exactly one error event, got ${errors.length}`);
          assert(events.every((event) => event.type !== "done"), "a failed prompt must not emit done");
        } finally {
          await session.close();
        }
      },
    });
  }

  return cases;
}
