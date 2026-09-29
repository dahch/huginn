import type React from "react";
import { Text } from "ink";
import { THEME } from "./theme.js";

/**
 * Parses inline markdown tokens (`code`, **bold**, __bold__, *italic*, _italic_)
 * into styled Ink <Text> elements. `defaultColor` is the body colour the caller
 * has chosen — usually `THEME.text` (`undefined`, i.e. the terminal's own
 * foreground) — so plain text is never forced to a colour that could vanish on
 * the wrong background (Phase 7A / REQ-12).
 */
export function renderInlineSpans(
  text: string,
  defaultColor: string | undefined = THEME.text,
): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(
        <Text key={`t-${lastIndex}`} color={defaultColor}>
          {text.slice(lastIndex, match.index)}
        </Text>,
      );
    }
    const raw = match[0];
    if (raw.startsWith("`") && raw.endsWith("`") && raw.length >= 2) {
      tokens.push(
        <Text key={`c-${match.index}`} color={THEME.accentStrong}>
          {raw.slice(1, -1)}
        </Text>,
      );
    } else if (
      ((raw.startsWith("**") && raw.endsWith("**")) || (raw.startsWith("__") && raw.endsWith("__"))) &&
      raw.length >= 4
    ) {
      tokens.push(
        <Text key={`b-${match.index}`} bold color={defaultColor}>
          {raw.slice(2, -2)}
        </Text>,
      );
    } else if (
      ((raw.startsWith("*") && raw.endsWith("*")) || (raw.startsWith("_") && raw.endsWith("_"))) &&
      raw.length >= 2
    ) {
      tokens.push(
        <Text key={`i-${match.index}`} italic color={defaultColor}>
          {raw.slice(1, -1)}
        </Text>,
      );
    }
    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) {
    tokens.push(
      <Text key={`t-${lastIndex}`} color={defaultColor}>
        {text.slice(lastIndex)}
      </Text>,
    );
  }

  return tokens.length > 0 ? tokens : [<Text key="0" color={defaultColor}>{text}</Text>];
}

/**
 * Formats a single line of markdown with heading, bullet, list, quote, code fence,
 * and inline styles for Ink terminal rendering. All colours come from the theme
 * (Phase 7A / REQ-12) so a heading or a code span keeps its contrast on both
 * light and dark terminals.
 */
export function MarkdownLine({
  text,
  defaultColor = THEME.text,
  wrap = "wrap",
}: {
  text: string;
  defaultColor?: string | undefined;
  wrap?: "wrap" | "truncate" | "truncate-start" | "truncate-middle" | "truncate-end";
}) {
  // Code fence
  if (/^```/.test(text)) {
    const lang = text.slice(3).trim();
    return (
      <Text dimColor={THEME.colorEnabled} wrap={wrap}>
        ─── {lang ? `[${lang}]` : "code"} ──────────────────────────────
      </Text>
    );
  }

  // Heading 1
  const h1 = text.match(/^#\s+(.+)$/);
  if (h1 && h1[1]) {
    return (
      <Text bold color={THEME.accentStrong} wrap={wrap}>
        # {renderInlineSpans(h1[1], THEME.accentStrong)}
      </Text>
    );
  }

  // Heading 2
  const h2 = text.match(/^##\s+(.+)$/);
  if (h2 && h2[1]) {
    return (
      <Text bold color={THEME.thinker} wrap={wrap}>
        ## {renderInlineSpans(h2[1], THEME.thinker)}
      </Text>
    );
  }

  // Heading 3+
  const h3 = text.match(/^###+\s+(.+)$/);
  if (h3 && h3[1]) {
    return (
      <Text bold color={THEME.info} wrap={wrap}>
        ### {renderInlineSpans(h3[1], THEME.info)}
      </Text>
    );
  }

  // Unordered list / bullet (- item, * item)
  const bullet = text.match(/^(\s*)([-*+])\s+(.+)$/);
  if (bullet && bullet[1] !== undefined && bullet[3] !== undefined) {
    return (
      <Text color={defaultColor} wrap={wrap}>
        {bullet[1]}
        <Text color={THEME.accentStrong}>• </Text>
        {renderInlineSpans(bullet[3], defaultColor)}
      </Text>
    );
  }

  // Ordered list (1. item, 2. item)
  const numList = text.match(/^(\s*)(\d+\.)\s+(.+)$/);
  if (numList && numList[1] !== undefined && numList[2] !== undefined && numList[3] !== undefined) {
    return (
      <Text color={defaultColor} wrap={wrap}>
        {numList[1]}
        <Text bold color={THEME.warn}>
          {numList[2]}{" "}
        </Text>
        {renderInlineSpans(numList[3], defaultColor)}
      </Text>
    );
  }

  // Blockquote (> text)
  const quote = text.match(/^>\s*(.+)$/);
  if (quote && quote[1]) {
    return (
      <Text color={THEME.muted} wrap={wrap}>
        <Text color={THEME.accent}>│ </Text>
        {renderInlineSpans(quote[1], THEME.muted)}
      </Text>
    );
  }

  // Horizontal rule (---, ***, ___)
  if (/^(\*\*\*|---|___)$/.test(text.trim())) {
    return (
      <Text dimColor={THEME.colorEnabled} wrap={wrap}>
        ────────────────────────────────────────
      </Text>
    );
  }

  // Plain text with inline markdown
  return (
    <Text color={defaultColor} wrap={wrap}>
      {renderInlineSpans(text, defaultColor)}
    </Text>
  );
}
