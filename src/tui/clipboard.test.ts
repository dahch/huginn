import { describe, expect, it } from "bun:test";
import {
  CLIPBOARD_MAX_BYTES,
  copyToTerminal,
  formatCharCount,
  osc52Sequence,
} from "./clipboard";

/** A `write`-only stdout double that records every chunk it is handed. */
function recorder(): { written: string[]; out: { write: (chunk: string) => boolean } } {
  const written: string[] = [];
  return {
    written,
    out: {
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    },
  };
}

/** The decoded payload between the OSC 52 introducer and its ST terminator. */
function payloadOf(sequence: string): string {
  const prefix = "\u001b]52;c;";
  expect(sequence.startsWith(prefix)).toBe(true);
  expect(sequence.endsWith("\u001b\\")).toBe(true);
  const base64 = sequence.slice(prefix.length, -2);
  return Buffer.from(base64, "base64").toString("utf8");
}

describe("osc52Sequence", () => {
  it("wraps base64 text in the OSC 52 clipboard sequence", () => {
    const sequence = osc52Sequence("hello");
    expect(sequence).toBe("\u001b]52;c;aGVsbG8=\u001b\\");
    expect(payloadOf(sequence)).toBe("hello");
  });

  it("decodes back to the sanitized text", () => {
    expect(payloadOf(osc52Sequence("Huginn the raven"))).toBe("Huginn the raven");
  });

  it("never leaves a raw ESC or control sequence in the payload", () => {
    const dirty = "safe\u001b[31mred\u001b[0m\u001b]0;title\u0007\u0000tail";
    const sequence = osc52Sequence(dirty);
    const base64 = sequence.slice("\u001b]52;c;".length, -2);
    expect(base64).not.toContain("\u001b");
    expect(base64).not.toContain("\u0007");
    const decoded = payloadOf(sequence);
    expect(decoded).not.toContain("\u001b");
    expect(decoded).not.toContain("\u0000");
    expect(decoded).not.toContain("\u0007");
    expect(decoded).toContain("safered");
    expect(decoded).toContain("tail");
  });

  it("accepts exactly 100 000 bytes and refuses one more", () => {
    const atCap = "a".repeat(CLIPBOARD_MAX_BYTES);
    expect(CLIPBOARD_MAX_BYTES).toBe(100_000);
    expect(osc52Sequence(atCap)).toContain("\u001b]52;c;");
    expect(osc52Sequence(`${atCap}a`)).toBe("");
    // UTF-8 bytes, not UTF-16 code units: a 2-byte character crosses the cap sooner.
    expect(osc52Sequence("é".repeat(50_001))).toBe("");
  });

  it("returns an empty sequence for empty or whitespace-only text", () => {
    expect(osc52Sequence("")).toBe("");
    expect(osc52Sequence("\u001b[0m")).toBe("");
  });

  it("honours a caller-supplied byte cap", () => {
    expect(osc52Sequence("abcd", 4)).toContain("\u001b]52;c;");
    expect(osc52Sequence("abcde", 4)).toBe("");
  });

  it("rejects a raw payload above the cap without sanitizing it first", () => {
    // Escape-heavy text shrinks after sanitization, but the raw size is what the
    // cap protects against: it must be refused before the whole payload is scanned.
    const rawOversized = "\u001b[31m".repeat(20_001); // 100 005 raw bytes
    expect(osc52Sequence(rawOversized, 100_000)).toBe("");
  });
});

describe("copyToTerminal", () => {
  it("writes the sequence and reports success", () => {
    const written: string[] = [];
    const out = { write: (chunk: string) => written.push(chunk) };
    expect(copyToTerminal("copy me", out as never)).toBe(true);
    expect(written).toHaveLength(1);
    expect(payloadOf(written[0]!)).toBe("copy me");
  });

  it("writes nothing and reports failure for an oversized payload", () => {
    const written: string[] = [];
    const out = { write: (chunk: string) => written.push(chunk) };
    expect(copyToTerminal("a".repeat(CLIPBOARD_MAX_BYTES + 1), out as never)).toBe(false);
    expect(written).toHaveLength(0);
  });
});

describe("osc52Sequence — defensive input", () => {
  it("returns an empty sequence for a non-string payload", () => {
    expect(osc52Sequence(undefined as unknown as string)).toBe("");
    expect(osc52Sequence(null as unknown as string)).toBe("");
    expect(osc52Sequence(42 as unknown as string)).toBe("");
    expect(osc52Sequence({ text: "x" } as unknown as string)).toBe("");
  });

  it("returns an empty sequence for an unusable byte cap", () => {
    expect(osc52Sequence("hello", Number.NaN)).toBe("");
    expect(osc52Sequence("hello", Number.POSITIVE_INFINITY)).toBe("");
    expect(osc52Sequence("hello", "10" as unknown as number)).toBe("");
    expect(osc52Sequence("hello", 0)).toBe("");
    expect(osc52Sequence("hello", -1)).toBe("");
  });

  it("is pure: the same text always yields the same sequence", () => {
    expect(osc52Sequence("Huginn the raven")).toBe(osc52Sequence("Huginn the raven"));
  });

  it("counts the cap in UTF-8 bytes, not UTF-16 code units", () => {
    expect(payloadOf(osc52Sequence("éé", 4))).toBe("éé");
    expect(osc52Sequence("éé", 3)).toBe("");
    expect(osc52Sequence("👋", 3)).toBe("");
    expect(payloadOf(osc52Sequence("👋", 4))).toBe("👋");
  });
});

/**
 * AC-72.5 is a *security* promise, not a formatting one: the clipboard payload
 * is repository and model text, so it may carry terminal escapes. These cases
 * are the ones a `base64` round-trip would faithfully reproduce after the
 * terminal decodes it.
 */
describe("osc52Sequence — the decoded payload is escape-free", () => {
  const dangerous: Array<[string, string]> = [
    ["a lone ESC", "\u001b"],
    ["a truncated CSI", "\u001b[3"],
    ["a DCS payload", "\u001bP1;2|payload\u001b\\"],
    ["an OSC 8 hyperlink", "\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007"],
    ["an 8-bit CSI", "\u009b31m"],
    ["raw C0 controls", "\u0000\u0001\u0002\u0008\u000b"],
    ["a bidi override", "\u202Egnp.exe\u202C"],
    ["zero-width characters", "\u200B\u200Fzero-width"],
    ["a nested clipboard sequence", "\u001b]52;c;AAAA\u001b\\"],
    ["an SGR reset", "\u001b[0m"],
  ];

  for (const [label, dirty] of dangerous) {
    it(`strips ${label} before encoding`, () => {
      const sequence = osc52Sequence(`ok${dirty}ok`);
      expect(sequence).toContain("\u001b]52;c;");

      // The base64 body must be plain base64: a raw ESC there would be acted on
      // by the terminal's own OSC 52 parser instead of being decoded.
      const body = sequence.slice("\u001b]52;c;".length, -2);
      expect(body).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      expect(body).not.toContain("\u001b");

      const decoded = payloadOf(sequence);
      expect(decoded).not.toContain("\u001b");
      expect(decoded).not.toContain("\u009b");
      expect(decoded).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
      expect(decoded).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/);
      // The legitimate text on either side of the payload survives.
      expect(decoded.startsWith("ok")).toBe(true);
      expect(decoded.endsWith("ok")).toBe(true);
    });
  }
});

describe("copyToTerminal — explicit sink and sanitization", () => {
  it("writes only to the sink the caller supplies", () => {
    const { written, out } = recorder();
    expect(copyToTerminal("explicit out", out as never)).toBe(true);
    expect(written).toHaveLength(1);
    expect(payloadOf(written[0]!)).toBe("explicit out");
  });

  it("sanitizes the payload before it reaches the terminal", () => {
    const { written, out } = recorder();
    expect(copyToTerminal("\u001b[31mvisible\u001b[0m tail", out as never)).toBe(true);
    const decoded = payloadOf(written[0]!);
    expect(decoded).toBe("visible tail");
    expect(decoded).not.toContain("\u001b");
  });

  it("writes nothing when the text is only escape sequences", () => {
    const { written, out } = recorder();
    expect(copyToTerminal("\u001b[38;5;196m", out as never)).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("writes nothing for empty or non-string text", () => {
    const { written, out } = recorder();
    expect(copyToTerminal("", out as never)).toBe(false);
    expect(copyToTerminal(undefined as unknown as string, out as never)).toBe(false);
    expect(written).toHaveLength(0);
  });
});

describe("formatCharCount — edge cases", () => {
  it("keeps small counts exact and abbreviates thousands", () => {
    expect(formatCharCount(0)).toBe("0");
    expect(formatCharCount(999)).toBe("999");
    expect(formatCharCount(1_234)).toBe("1.2k");
    expect(formatCharCount(12_345)).toBe("12.3k");
  });

  it("floors fractional counts and clamps negatives to zero", () => {
    expect(formatCharCount(999.9)).toBe("999");
    expect(formatCharCount(1_000.9)).toBe("1.0k");
    expect(formatCharCount(-5)).toBe("0");
    expect(formatCharCount(-0.5)).toBe("0");
  });

  it("falls back to zero for a non-finite count", () => {
    expect(formatCharCount(Number.NaN)).toBe("0");
    expect(formatCharCount(Number.POSITIVE_INFINITY)).toBe("0");
  });

  it("keeps one decimal across the thousand boundary", () => {
    expect(formatCharCount(1_000)).toBe("1.0k");
    expect(formatCharCount(1_500)).toBe("1.5k");
    expect(formatCharCount(100_000)).toBe("100.0k");
  });
});
