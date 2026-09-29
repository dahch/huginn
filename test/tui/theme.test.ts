import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verdictToken } from "../../src/format";
import { formatMcpBadge } from "../../src/engine/agent/mcpStatus.js";
import {
  DEFAULT_THEME_MODE,
  INK_COLOR_NAMES,
  THEME,
  THEME_ENV_VAR,
  THEME_TOKENS,
  colorDisabled,
  getTheme,
  isInkColor,
  mcpStatusToken,
  resetThemeCache,
  resolveThemeMode,
  themeModeFromEnv,
  themePalette,
  type ThemeMode,
} from "../../src/tui/theme.js";

/**
 * Phase 7A / REQ-12 — the theme guardian.
 *
 * Three jobs:
 *  1. keep the source honest: no component may hard-code a colour in any form
 *     (`color="white"` on the chat body was the reported bug), and colour may
 *     not even be *described* outside the TUI layer (REV-7A-003),
 *  2. keep the palette honest: every token resolves to a colour Ink actually
 *     understands, the body inherits the terminal foreground, the light palette
 *     stays legible on white, and `NO_COLOR` turns the whole thing off,
 *  3. keep `dimColor` gated on `THEME.colorEnabled`, so `NO_COLOR` really means
 *     "no escape sequences" rather than "no colours but still faint".
 */

const SRC_TUI = new URL("../../src/tui", import.meta.url).pathname;

/**
 * `theme.ts` is *the* place a colour is allowed to be written — the palettes
 * live there. It is exempt from the literal scan, and instead covered by the
 * palette tests below (every token must be an Ink colour the mode is willing to
 * claim is legible).
 */
const THEME_MODULE = "theme.ts";

/** Strip comments so a doc-comment mentioning `color="white"` is not a hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Every chalk colour name, longest first so `greenBright` wins over `green`.
 * Injected into the literal patterns so a name the palette could not render is
 * still caught in a component.
 */
const COLOR_NAME_ALTERNATION = [...INK_COLOR_NAMES]
  .sort((a, b) => b.length - a.length)
  .join("|");

/**
 * A quoted colour literal in **any** form: `'cyan'`, `"white"`, `` `#0af` ``,
 * `"ansi256(240)"`, `"rgb(1, 2, 3)"`, `"cyanBright"`. Quoting style and the
 * surrounding expression (ternary, object, backtick) do not matter.
 */
const QUOTED_COLOR = new RegExp(
  `(["'\`])(?:#(?:[0-9a-fA-F]{3,8})|ansi256\\(\\s*\\d+\\s*\\)|rgb\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*\\)|(?:${COLOR_NAME_ALTERNATION}))\\1`,
  "g",
);

/** A `color`/`borderColor`/… prop (or any assignment) carrying a quoted literal. */
const LITERAL_COLOR_PROP =
  /(?:^|[^A-Za-z0-9_])(?:border(?:Top|Bottom|Left|Right|Background)?Color|backgroundColor|color)\s*[:=]\s*\{?\s*(["'`]|#|ansi256\(|rgb\()/g;

/** The reported regression: white body/log text vanishes on a white terminal. */
const WHITE_COLOR_PROP = /(?:borderColor|color)\s*[:=]\s*\{?\s*["'`]white["'`]/g;

/** Colour functions used directly, bypassing the theme (`chalk.red(…)`, `ansi256(…)`). */
const COLOR_FUNCTION = /\bchalk\s*\.|\b(?:ansi256|bgAnsi256|rgb|bgRgb)\s*\(/g;

/** `dimColor` that is *not* gated on `THEME.colorEnabled`. */
const UNGATED_DIM_COLOR = /dimColor\s*=\s*\{(?!\s*THEME\.colorEnabled\b)/g;

function tuiSources(): Array<{ path: string; source: string }> {
  const files: Array<{ path: string; source: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
      if (entry.name === THEME_MODULE) continue;
      files.push({ path: full, source: stripComments(readFileSync(full, "utf8")) });
    }
  };
  walk(SRC_TUI);
  return files;
}

function offendingLines(source: string, pattern: RegExp): string[] {
  const hits: string[] = [];
  source.split("\n").forEach((line, index) => {
    pattern.lastIndex = 0;
    if (pattern.test(line)) hits.push(`${index + 1}: ${line.trim()}`);
  });
  return hits;
}

/** Run every pattern over every TUI file and return a readable offender list. */
function scanTui(...patterns: RegExp[]): string[] {
  const offenders: string[] = [];
  for (const { path, source } of tuiSources()) {
    const label = path.replace(SRC_TUI, "src/tui");
    for (const pattern of patterns) {
      for (const line of offendingLines(source, pattern)) {
        offenders.push(`${label} → ${line}`);
      }
    }
  }
  return offenders;
}

afterEach(() => {
  delete process.env[THEME_ENV_VAR];
  delete process.env.NO_COLOR;
  delete process.env.COLORFGBG;
  resetThemeCache();
});

describe("theme source guard (REQ-12)", () => {
  it("never writes a colour literal into a component, in any form", () => {
    // Literal names (`"white"`, `'cyan'`, ternary/backtick variants), hex,
    // ansi256/rgb, `borderColor`/`color` assignments, and direct chalk use.
    expect(scanTui(QUOTED_COLOR, LITERAL_COLOR_PROP, COLOR_FUNCTION)).toEqual([]);
  });

  it("never paints text white (the colour that disappears on a white terminal)", () => {
    expect(scanTui(WHITE_COLOR_PROP)).toEqual([]);
  });

  it("gates every dimColor on THEME.colorEnabled (so NO_COLOR disables it too)", () => {
    expect(scanTui(UNGATED_DIM_COLOR)).toEqual([]);
  });

  it("gives the chat body and the log lines no foreground at all", () => {
    // `text` is `undefined` in every mode → Ink emits no foreground escape and
    // the terminal's own (always legible) colour shows through.
    for (const mode of ["light", "dark", "auto"] as const) {
      expect(themePalette(mode).text, mode).toBeUndefined();
    }
  });
});

describe("presentation stays in the TUI layer (REV-7A-003)", () => {
  const NON_TUI_MODULES = [
    ["src/format.ts", new URL("../../src/format.ts", import.meta.url)],
    ["src/engine/agent/mcpStatus.ts", new URL("../../src/engine/agent/mcpStatus.ts", import.meta.url)],
  ] as const;

  it("keeps colour out of src/format.ts and mcpStatus.ts", () => {
    for (const [label, url] of NON_TUI_MODULES) {
      const source = stripComments(readFileSync(url, "utf8"));
      // The old escape hatches must be gone: no `verdictColor`, no `color:` field.
      expect(source, label).not.toMatch(/\bverdictColor\b/);
      expect(source, label).not.toMatch(/\bcolor\s*:/);
      // And no colour literal may be returned from them (chalk badges are a
      // separate, headless concern and are covered by their own tests).
      expect(offendingLines(source, QUOTED_COLOR), label).toEqual([]);
    }
  });

  it("maps a verdict to a theme token the TUI resolves", () => {
    expect(verdictToken("pass")).toBe("ok");
    expect(verdictToken("warning")).toBe("warn");
    expect(verdictToken("blocked")).toBe("danger");
    expect(verdictToken("skipped")).toBe("muted");
    expect(getTheme({ [THEME_ENV_VAR]: "dark" }).color(verdictToken("blocked"))).toBe("red");
  });

  it("maps an MCP badge severity to a theme token instead of a colour", () => {
    expect(mcpStatusToken("healthy")).toBe("ok");
    expect(mcpStatusToken("degraded")).toBe("warn");
    expect(mcpStatusToken("unknown")).toBe("muted");

    // End-to-end: the badge carries severity, the TUI layer turns it into a token.
    const badge = formatMcpBadge(null);
    expect(Object.keys(badge).sort()).toEqual(["status", "text"]);
    expect(mcpStatusToken(badge.status)).toBe("muted");
  });
});

describe("theme palette integrity (REQ-12)", () => {
  it("covers every token in every mode with a colour Ink accepts (or none)", () => {
    for (const mode of ["light", "dark", "auto"] as const) {
      const palette = themePalette(mode);
      expect(Object.keys(palette).sort()).toEqual([...THEME_TOKENS].sort());
      for (const token of THEME_TOKENS) {
        const color = palette[token];
        if (color === undefined) continue;
        expect(isInkColor(color), `${mode}.${token} = ${color}`).toBe(true);
        // Bright variants wash out on white: a never-blank palette must avoid
        // claiming legibility it cannot deliver, so `auto` never uses them.
        if (mode === "auto") {
          expect(color.endsWith("Bright"), `auto.${token} = ${color}`).toBe(false);
        }
      }
    }
  });

  it("keeps the semantic hierarchy on a dark background", () => {
    const dark = themePalette("dark");
    expect(dark.accent).toBe("cyan");
    expect(dark.accentStrong).toBe("cyanBright");
    expect(dark.thinker).toBe("magenta");
    expect(dark.executor).toBe("green");
    expect(dark.ok).toBe("green");
    expect(dark.warn).toBe("yellow");
    expect(dark.danger).toBe("red");
    expect(dark.muted).toBe("gray");
    expect(dark.text).toBeUndefined();
  });

  it("keeps the light palette legible on white (no yellow/green/cyan family)", () => {
    const light = themePalette("light");
    // `yellow` (≈1.7:1), `green` (≈1.9:1) and the whole cyan family (≈1.6:1)
    // are unreadable on a white terminal, so the legible palette bans them by
    // name — the documented trade-off is green/yellow semantics for contrast.
    const washedOut = /^(?:yellow|green|cyan)/i;
    for (const token of THEME_TOKENS) {
      const color = light[token];
      if (color === undefined) continue;
      expect(color, `light.${token} = ${color}`).not.toMatch(washedOut);
      expect(color.toLowerCase(), `light.${token} = ${color}`).not.toMatch(/^(?:white|black)$/);
    }
    // The substitutions that make it legible: blue ≈8:1, magenta ≈3.7:1, red ≈4.7:1.
    expect(light.accent).toBe("blue");
    expect(light.accentStrong).toBe("blue");
    expect(light.ok).toBe("blue");
    expect(light.executor).toBe("blue");
    expect(light.warn).toBe("magenta");
    expect(light.danger).toBe("red");
    expect(light.text).toBeUndefined();
  });

  it("makes auto background-agnostic and legible rather than an alias for dark", () => {
    const auto = themePalette("auto");
    // No reliable detection ⇒ prioritise legibility: adaptive text and none of
    // the families that only read on black.
    const onlyOnDark = /^(?:yellow|green|cyan)/i;
    for (const token of THEME_TOKENS) {
      const color = auto[token];
      if (color === undefined) continue;
      expect(color, `auto.${token} = ${color}`).not.toMatch(onlyOnDark);
    }
    expect(auto.text).toBeUndefined();
    expect(auto).toEqual(themePalette("light"));
    expect(auto).not.toEqual(themePalette("dark"));
  });

  it("exposes the tokens through a live THEME view", () => {
    process.env[THEME_ENV_VAR] = "dark";
    resetThemeCache();
    expect(THEME.mode).toBe("dark");
    expect(THEME.accentStrong).toBe(themePalette("dark").accentStrong);
    expect(THEME.text).toBeUndefined();
    expect(THEME.colorEnabled).toBe(true);
  });
});

describe("theme mode resolution (REQ-12)", () => {
  it("defaults to auto and normalises anything unknown to auto", () => {
    expect(DEFAULT_THEME_MODE).toBe("auto");
    expect(resolveThemeMode(undefined)).toBe("auto");
    expect(resolveThemeMode("")).toBe("auto");
    expect(resolveThemeMode("NONSENSE")).toBe("auto");
    expect(resolveThemeMode("dark")).toBe("dark");
    expect(resolveThemeMode("  Light ")).toBe("light");
  });

  it("lets an explicit HUGINN_THEME override detection", () => {
    expect(themeModeFromEnv({ [THEME_ENV_VAR]: "dark" })).toBe("dark");
    expect(themeModeFromEnv({ [THEME_ENV_VAR]: "light" })).toBe("light");
    expect(themeModeFromEnv({ [THEME_ENV_VAR]: "auto", COLORFGBG: "15;0" })).toBe("dark");
  });

  it("sniffs COLORFGBG for the auto mode when a terminal advertises it", () => {
    expect(themeModeFromEnv({ COLORFGBG: "0;15" })).toBe("light");
    expect(themeModeFromEnv({ COLORFGBG: "8;7" })).toBe("light");
    expect(themeModeFromEnv({ COLORFGBG: "15;0" })).toBe("dark");
    expect(themeModeFromEnv({ COLORFGBG: "not-a-number" })).toBe("auto");
    expect(themeModeFromEnv({})).toBe("auto");
  });

  it("memoises the resolved environment instead of re-parsing it per token read", () => {
    process.env[THEME_ENV_VAR] = "dark";
    resetThemeCache();
    const first = getTheme();
    expect(getTheme()).toBe(first); // same env ⇒ same resolved theme object
    process.env[THEME_ENV_VAR] = "light";
    const second = getTheme();
    expect(second).not.toBe(first);
    expect(second.mode).toBe("light");
  });
});

describe("NO_COLOR (REQ-12)", () => {
  it("is honored only when the variable is present and non-empty", () => {
    expect(colorDisabled({})).toBe(false);
    expect(colorDisabled({ NO_COLOR: "" })).toBe(false);
    expect(colorDisabled({ NO_COLOR: "1" })).toBe(true);
    expect(colorDisabled({ NO_COLOR: "true" })).toBe(true);
  });

  it("clears every token and disables dimming, even when a mode is pinned", () => {
    const theme = getTheme({ ...process.env, NO_COLOR: "1" });
    expect(theme.colorEnabled).toBe(false);
    for (const token of THEME_TOKENS) {
      expect(theme.color(token), token).toBeUndefined();
    }

    process.env.NO_COLOR = "1";
    process.env[THEME_ENV_VAR] = "dark";
    resetThemeCache();
    expect(THEME.colorEnabled).toBe(false);
    // `undefined` is what makes Ink emit no escape at all: no <Text> in the TUI
    // can colour anything while NO_COLOR is set.
    for (const token of THEME_TOKENS) {
      expect(THEME[token], token).toBeUndefined();
    }
  });

  it("resolves a concrete token per mode once colour is on", () => {
    expect(getTheme({ [THEME_ENV_VAR]: "dark" }).color("accentStrong")).toBe("cyanBright");
    expect(getTheme({ [THEME_ENV_VAR]: "light" }).color("accent")).toBe("blue");
    expect(getTheme({ [THEME_ENV_VAR]: "auto" }).color("accent")).toBe("blue");
    expect(getTheme({ [THEME_ENV_VAR]: "auto" }).color("text")).toBeUndefined();
  });
});

describe("theme module exports", () => {
  it("namespaces every mode token and keeps the token list stable", () => {
    const modes: ThemeMode[] = ["light", "dark", "auto"];
    for (const mode of modes) {
      expect(themePalette(mode)).toBe(themePalette(mode)); // frozen + memoised by identity
    }
    expect(new Set(THEME_TOKENS).size).toBe(THEME_TOKENS.length);
    expect(THEME_TOKENS).toContain("text");
    expect(THEME_TOKENS).toContain("borderFocus");
    // `subtle` was dead weight; the palette is the tokens that have a consumer.
    expect(THEME_TOKENS).not.toContain("subtle");
  });

  it("accepts every colour form Ink can render, and rejects the rest", () => {
    for (const name of INK_COLOR_NAMES) {
      expect(isInkColor(name), name).toBe(true);
    }
    expect(isInkColor("#0af")).toBe(true);
    expect(isInkColor("#00aaff")).toBe(true);
    expect(isInkColor("ansi256(240)")).toBe(true);
    expect(isInkColor("rgb(1, 2, 3)")).toBe(true);
    expect(isInkColor("not-a-colour")).toBe(false);
  });
});
