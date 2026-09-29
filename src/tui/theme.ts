/**
 * TUI colour theme (Phase 7A / REQ-12).
 *
 * Before this module the console hard-coded chalk colour *names* at every call
 * site — most damagingly `color="white"` for the chat body and the log lines,
 * which is invisible on a white terminal, plus a heavy use of `dimColor`
 * (SGR 2 / faint) that all but disappears on both light and dark backgrounds.
 *
 * One semantic palette replaces that: components ask for a *role*
 * (`THEME.text`, `THEME.muted`, `THEME.danger`, …) instead of a colour, so the
 * whole view moves together and every foreground is chosen to stay legible on
 * the terminal it lands on.
 *
 * Design rules:
 *  - `text` is `undefined`: Ink then emits no foreground escape at all and the
 *    body inherits the terminal's own foreground, which is the only value that
 *    is always legible — black on a light terminal, white on a dark one.
 *  - Accents only ever use medium-tone names (`blue`, `magenta`, `red`, `gray`):
 *    the `*Bright` variants and the `yellow`/`green`/`cyan` family sit below 3:1
 *    on a white terminal, so the legible palette does not use them at all.
 *  - `muted` is a real colour (`gray`), not `dimColor`: faint text is the thing
 *    that was hard to read in the first place.
 *  - `NO_COLOR` (non-empty, per no-color.org) disables every token, and gates
 *    `dimColor` too — chalk alone would keep colouring in a TTY (verified: chalk
 *    v6 / `supports-color` never consults `NO_COLOR`).
 *
 * Ink 7 does accept more than names: `#rrggbb`, `ansi256(n)` and `rgb(r,g,b)`
 * are all handled by `ink/build/colorize.js`. The palette stays on names anyway
 * so the guardian test can forbid the washed-out families by name and so no
 * truecolor assumption leaks into the default theme; `isInkColor` still accepts
 * the extended forms, so a hex palette would not be silently dropped.
 */

import type { McpBadgeStatus } from "../engine/agent/mcpStatus.js";

/** How the palette is chosen. `auto` adapts to the terminal it finds itself on. */
export type ThemeMode = "light" | "dark" | "auto";

/** Semantic colour slots the TUI renders through. */
export type ThemeToken =
  | "text"
  | "muted"
  | "border"
  | "borderFocus"
  | "accent"
  | "accentStrong"
  | "ok"
  | "warn"
  | "danger"
  | "info"
  | "thinker"
  | "executor"
  | "system"
  | "brand";

/** An Ink colour name (or `#hex`/`ansi256(n)`/`rgb(…)`), or `undefined` to inherit the terminal's foreground. */
export type ThemeColor = string | undefined;

/** A complete token → colour mapping. */
export type ThemePalette = Record<ThemeToken, ThemeColor>;

/** Every token, in a stable order (used to build/scan palettes). */
export const THEME_TOKENS: readonly ThemeToken[] = [
  "text",
  "muted",
  "border",
  "borderFocus",
  "accent",
  "accentStrong",
  "ok",
  "warn",
  "danger",
  "info",
  "thinker",
  "executor",
  "system",
  "brand",
];

/**
 * Env var that pins the theme to `light`, `dark` or `auto` (default `auto`).
 * Read from the process environment so no config file lookup (or filesystem
 * access) is needed inside the render loop.
 *
 * This is *the* supported override: when `auto` cannot reliably sniff the
 * background it falls back to the legible palette below, and a user who knows
 * they are on a dark terminal gets the cyan/green/yellow palette back with
 * `HUGINN_THEME=dark`.
 */
export const THEME_ENV_VAR = "HUGINN_THEME";

/** The default mode: adapt to the terminal rather than assume a background. */
export const DEFAULT_THEME_MODE: ThemeMode = "auto";

/**
 * The chalk colour names Ink understands (Ink 7 passes the string straight to
 * `chalk[...]`). The palette is restricted to these so a token can never resolve
 * to something Ink silently drops.
 */
export const INK_COLOR_NAMES: ReadonlySet<string> = new Set([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "blackBright",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
  "gray",
  "grey",
]);

/** The extended colour forms `ink/build/colorize.js` also understands. */
const INK_COLOR_PATTERNS: readonly RegExp[] = [
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
  /^ansi256\(\s*\d{1,3}\s*\)$/,
  /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/,
];

/** True when a colour string is one Ink will actually render (name, hex, ansi256 or rgb). */
export function isInkColor(value: string): boolean {
  return INK_COLOR_NAMES.has(value) || INK_COLOR_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * The legible palette — used for a light background, **and** for `auto` when the
 * background cannot be detected reliably.
 *
 * Real legibility on white beats nominal semantics: `green` (1.9:1) and `yellow`
 * (1.7:1) are unreadable on a white terminal, so `ok`/`executor` move to `blue`
 * (≈8:1) and `warn` to `magenta` (≈3.7:1), and the whole cyan family (1.6:1)
 * becomes `blue`. The trade-off is honest and documented: on a light background
 * you lose the "green = pass / yellow = warn" convention; `danger` stays `red`
 * (≈4.7:1) so a blocked verdict is still unmistakable, and `HUGINN_THEME=dark`
 * restores the cyan/green/yellow palette on a dark terminal.
 */
const LEGIBLE_PALETTE: ThemePalette = Object.freeze({
  text: undefined,
  muted: "gray",
  border: "gray",
  borderFocus: "blue",
  accent: "blue",
  accentStrong: "blue",
  ok: "blue",
  warn: "magenta",
  danger: "red",
  info: "blue",
  thinker: "magenta",
  executor: "blue",
  system: "gray",
  brand: "blue",
});

/**
 * `auto` — the default. It is deliberately *not* an alias for `dark`: with no
 * reliable background signal it uses the legible palette (adaptive `text`, no
 * `yellow`/`green`/`cyan`), so the default can never assume a black terminal and
 * wash out on a white one. A user who knows their background overrides it with
 * `HUGINN_THEME` (`dark` for the palette below, `light` for this one).
 */
const AUTO_PALETTE: ThemePalette = LEGIBLE_PALETTE;

/**
 * `light` — a light background. Same legible palette as `auto`; kept as its own
 * name so `themePalette("light")` reads intentionally rather than as a fallback.
 */
const LIGHT_PALETTE: ThemePalette = LEGIBLE_PALETTE;

/**
 * `dark` — a dark background. Here the bright variants keep their contrast and
 * the cyan/green/yellow family is legible again, so the semantic hierarchy is
 * fully preserved. Only an explicit `HUGINN_THEME=dark` (or a `COLORFGBG`
 * sniff that says dark) reaches it.
 */
const DARK_PALETTE: ThemePalette = Object.freeze({
  text: undefined,
  muted: "gray",
  border: "gray",
  borderFocus: "cyanBright",
  accent: "cyan",
  accentStrong: "cyanBright",
  ok: "green",
  warn: "yellow",
  danger: "red",
  info: "cyan",
  thinker: "magenta",
  executor: "green",
  system: "gray",
  brand: "cyan",
});

/** Every token cleared, so nothing is colourised (used under `NO_COLOR`). */
const NO_COLOR_PALETTE: ThemePalette = Object.freeze(
  Object.fromEntries(THEME_TOKENS.map((token) => [token, undefined])) as ThemePalette,
);

/** True when `value` names a theme mode. */
export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "auto";
}

/** Normalise a raw mode string; anything unrecognised falls back to `auto`. */
export function resolveThemeMode(value: string | null | undefined): ThemeMode {
  const normalized = (value ?? "").trim().toLowerCase();
  return isThemeMode(normalized) ? normalized : DEFAULT_THEME_MODE;
}

/**
 * The palette for a concrete mode. `auto` and `light` share the legible palette
 * (see `AUTO_PALETTE`); `dark` is reachable only by asking for it or by a
 * reliable `COLORFGBG` sniff.
 */
export function themePalette(mode: ThemeMode): ThemePalette {
  switch (mode) {
    case "dark":
      return DARK_PALETTE;
    case "light":
      return LIGHT_PALETTE;
    default:
      return AUTO_PALETTE;
  }
}

/**
 * True when colour should be suppressed. Follows no-color.org: `NO_COLOR`
 * disables colour when it is present and not an empty string. Ink applies its
 * styles through chalk, and chalk does *not* itself consult `NO_COLOR`, so this
 * module is what makes the convention hold inside the TUI — tokens resolve to
 * `undefined` and `THEME.colorEnabled` (the `dimColor` gate) is `false`.
 */
export function colorDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.NO_COLOR === "string" && env.NO_COLOR.length > 0;
}

/**
 * Best-effort background sniff from `COLORFGBG` (set by many terminals as
 * `<fg>;<bg>`). Returns `undefined` when the terminal does not advertise it, so
 * `auto` can fall back to its background-agnostic palette.
 */
function detectBackgroundMode(env: NodeJS.ProcessEnv): "light" | "dark" | undefined {
  const raw = env.COLORFGBG;
  if (!raw) return undefined;
  const parts = raw.split(/[;:]+/).filter((part) => part.length > 0);
  const bg = Number.parseInt(parts[parts.length - 1] ?? "", 10);
  if (!Number.isFinite(bg)) return undefined;
  // 7 (traditional light), 15 (bright white) and 231 (xterm-256 white) are light.
  return bg === 7 || bg === 15 || bg === 231 ? "light" : "dark";
}

/**
 * The mode for the environment: an explicit `HUGINN_THEME` wins; otherwise an
 * `auto` request tries `COLORFGBG` before settling on the adaptive palette.
 */
export function themeModeFromEnv(env: NodeJS.ProcessEnv = process.env): ThemeMode {
  const explicit = resolveThemeMode(env[THEME_ENV_VAR]);
  if (explicit !== "auto") return explicit;
  return detectBackgroundMode(env) ?? "auto";
}

/** A resolved theme: the mode it was built for and the colours it exposes. */
export interface Theme {
  readonly mode: ThemeMode;
  /** False under `NO_COLOR` — `color()` is `undefined` and `dimColor` must be off. */
  readonly colorEnabled: boolean;
  readonly colors: ThemePalette;
  /** The colour for a token (`undefined` = inherit the terminal foreground). */
  color(token: ThemeToken): ThemeColor;
}

/**
 * Cache key over the *raw* env values that can change the theme. Comparing three
 * strings is far cheaper than re-parsing `COLORFGBG` on every token read, which
 * is what the render loop does dozens of times per frame.
 */
function themeEnvKey(env: NodeJS.ProcessEnv): string {
  return `${env[THEME_ENV_VAR] ?? ""}\u0000${env.NO_COLOR ?? ""}\u0000${env.COLORFGBG ?? ""}`;
}

let cache: { key: string; theme: Theme } | null = null;

/**
 * The resolved theme for `env` (defaults to `process.env`), memoised on the raw
 * environment it was resolved from, so a token read only pays for a couple of
 * string comparisons.
 */
export function getTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  const key = themeEnvKey(env);
  const cached = cache;
  if (cached && cached.key === key) return cached.theme;

  const mode = themeModeFromEnv(env);
  const colorEnabled = !colorDisabled(env);
  const colors = colorEnabled ? themePalette(mode) : NO_COLOR_PALETTE;
  const theme: Theme = { mode, colorEnabled, colors, color: (token) => colors[token] };
  cache = { key, theme };
  return theme;
}

/** Drop the memoised theme (tests change the environment between cases). */
export function resetThemeCache(): void {
  cache = null;
}

/** `getTheme(env).color(token)` — the one-liner components use. */
export function themeColor(token: ThemeToken, env: NodeJS.ProcessEnv = process.env): ThemeColor {
  return getTheme(env).color(token);
}

/**
 * A live view of the current theme: `THEME.text`, `THEME.accent`, … resolve to
 * the palette colour on each read, so a component just writes
 * `color={THEME.muted}`. `THEME.colorEnabled` gates `dimColor` (off under
 * `NO_COLOR`).
 */
export interface ThemeView extends Record<ThemeToken, ThemeColor> {
  readonly mode: ThemeMode;
  readonly colorEnabled: boolean;
}

function createThemeView(): ThemeView {
  const view: Record<string, unknown> = {};
  for (const token of THEME_TOKENS) {
    Object.defineProperty(view, token, {
      enumerable: true,
      get: () => getTheme().color(token),
    });
  }
  Object.defineProperty(view, "mode", { enumerable: true, get: () => getTheme().mode });
  Object.defineProperty(view, "colorEnabled", {
    enumerable: true,
    get: () => getTheme().colorEnabled,
  });
  return view as unknown as ThemeView;
}

/** The shared palette accessor the components import. */
export const THEME: ThemeView = createThemeView();

/**
 * Semantic MCP badge severity (from `formatMcpBadge`) → theme token. It lives in
 * the TUI layer on purpose: the engine/format modules describe *state* and this
 * is the only place that turns state into a colour (REV-7A-003).
 */
export function mcpStatusToken(status: McpBadgeStatus): ThemeToken {
  switch (status) {
    case "healthy":
      return "ok";
    case "degraded":
      return "warn";
    default:
      return "muted";
  }
}
