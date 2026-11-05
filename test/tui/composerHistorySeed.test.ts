import { describe, expect, it } from "vitest";
import { seedInputHistory } from "../../src/tui/LiveDashboard";
import type { TranscriptTurn } from "../../src/engine/liveMode.js";

const turn = (role: TranscriptTurn["role"], text: string): TranscriptTurn => ({ role, text });

describe("composer history seeding (REQ-34)", () => {
  it("starts empty when nothing has been asked", () => {
    expect(seedInputHistory([])).toEqual([]);
  });

  it("takes the user turns and ignores what the agent or the harness said", () => {
    const history = seedInputHistory([
      turn("system", "✓ Switched agent runtime to Pi (pi)."),
      turn("user", "first prompt"),
      turn("assistant", "thinking out loud"),
      turn("user", "second prompt"),
    ]);
    expect(history).toEqual(["first prompt", "second prompt"]);
  });

  it("keeps slash commands out, exactly like submit() does", () => {
    const history = seedInputHistory([
      turn("user", "/draft"),
      turn("user", "a real prompt"),
      turn("user", "/agent pi"),
    ]);
    expect(history).toEqual(["a real prompt"]);
  });

  it("adds the CLI idea, because it was never typed into the composer", () => {
    // `huginn live --prompt-file …` calls live.chat() directly: without this the
    // prompt is unreachable with ↑ and relaunching it means re-reading the file.
    expect(seedInputHistory([], "the idea from the file")).toEqual(["the idea from the file"]);
  });

  it("does not repeat an idea the resumed transcript already carries", () => {
    const history = seedInputHistory(
      [turn("user", "the idea"), turn("assistant", "ok")],
      "the idea",
    );
    expect(history).toEqual(["the idea"]);
  });

  it("collapses consecutive duplicates and keeps the newest entries within the limit", () => {
    expect(
      seedInputHistory([turn("user", "same"), turn("user", "same"), turn("user", "other")]),
    ).toEqual(["same", "other"]);

    const limited = seedInputHistory(
      [turn("user", "one"), turn("user", "two"), turn("user", "three")],
      undefined,
      2,
    );
    expect(limited).toEqual(["two", "three"]);
  });

  it("drops blank transcript turns and trims the idea", () => {
    expect(
      seedInputHistory([turn("user", "   ")], "  padded idea  "),
    ).toEqual(["padded idea"]);
  });
});
