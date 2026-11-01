import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardTone } from "../../src/tui/Card";

/**
 * REQ-70 — the border hierarchy is a promise, not a comment:
 *
 *  - a focused card always uses `borderFocus`;
 *  - an unfocused `primary` keeps its accent (or the stage's token), so the
 *    conversation stays the loudest surface;
 *  - an unfocused `secondary` steps back to the quiet `border`;
 *  - `tertiary` has no box at all.
 *
 * The assertions check the escape Ink actually emits, so they would catch a
 * `borderColor` that is computed correctly but never handed to `<Box>`, or a
 * palette token that was swapped for another.
 *
 * `FORCE_COLOR` must be seen by chalk *before* Ink is first imported, which is
 * why every module here is imported dynamically after `vi.resetModules()` — a
 * static `import "ink"` would freeze chalk's colour level for the whole file.
 */
describe("card border colour by tone and focus (REQ-70)", () => {
  afterEach(() => {
    delete process.env.FORCE_COLOR;
    delete process.env.HUGINN_THEME;
    delete process.env.NO_COLOR;
    vi.resetModules();
  });

  /** Render one card with colour forced on, so Ink emits the real border escape. */
  async function renderColored(props: {
    tone: CardTone;
    title: string;
    focused?: boolean;
    accentToken?: "accent" | "warn" | "ok";
  }): Promise<string> {
    vi.resetModules();
    process.env.FORCE_COLOR = "1";
    process.env.HUGINN_THEME = "dark";
    delete process.env.NO_COLOR;

    const React = (await import("react")).default;
    const { Text } = await import("ink");
    const { render } = await import("./inkRender");
    const { Card } = await import("../../src/tui/Card");

    const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
    stdout.columns = 24;
    stdout.rows = 10;
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const instance = render(
      React.createElement(
        Card,
        { ...props, height: 4, width: 16 },
        React.createElement(Text, null, "body"),
      ),
      { stdout, patchConsole: false },
    );
    instance.unmount();
    return output;
  }

  /** The opening border row of a frame. */
  const openingRow = (output: string): string => output.split("\n")[0] ?? "";

  it("paints an unfocused primary with its accent, or the stage's token", async () => {
    // dark palette: accent = cyan, warn = yellow.
    expect(openingRow(await renderColored({ tone: "primary", title: "P" }))).toContain(
      "\u001b[36m",
    );
    expect(
      openingRow(await renderColored({ tone: "primary", title: "P", accentToken: "warn" })),
    ).toContain("\u001b[33m");
  });

  it("paints a focused card with borderFocus, whatever its tone", async () => {
    // dark palette: borderFocus = cyanBright.
    for (const tone of ["primary", "secondary"] as const) {
      expect(openingRow(await renderColored({ tone, title: tone, focused: true })), tone).toContain(
        "\u001b[96m",
      );
    }
  });

  it("paints an unfocused secondary with the quiet border, never the accent", async () => {
    const row = openingRow(await renderColored({ tone: "secondary", title: "S" }));
    // dark palette: border = #5b6572.
    expect(row).toContain("\u001b[38;2;91;101;114m");
    expect(row).not.toContain("\u001b[36m");
  });

  it("never paints a border on the tertiary card, focused or not", async () => {
    for (const focused of [false, true]) {
      const output = await renderColored({ tone: "tertiary", title: "Logs", focused });
      expect(output, `focused=${focused}`).not.toMatch(/[╭╮╰╯┌┐└┘]/);
    }
  });

  it("lets a focused secondary keep the same single box, only louder", async () => {
    const focused = openingRow(await renderColored({ tone: "secondary", title: "S", focused: true }));
    const unfocused = openingRow(await renderColored({ tone: "secondary", title: "S" }));
    // The border style comes from the tone table, the colour from focus: a
    // focused secondary must not turn into a `round` primary box.
    expect(focused).toContain("┌");
    expect(focused).not.toContain("╭");
    expect(focused).not.toBe(unfocused);
  });
});
