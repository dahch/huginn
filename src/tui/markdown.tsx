import type React from "react";
import { Text } from "ink";

/**
 * Parses inline markdown tokens (`code`, **bold**, __bold__, *italic*, _italic_)
 * into styled Ink <Text> elements.
 */
export function renderInlineSpans(text: string, defaultColor: string = "white"): React.ReactNode[] {
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
        <Text key={`c-${match.index}`} color="yellowBright">
          {raw.slice(1, -1)}
        </Text>,
      );
    } else if (
      ((raw.startsWith("**") && raw.endsWith("**")) || (raw.startsWith("__") && raw.endsWith("__"))) &&
      raw.length >= 4
    ) {
      tokens.push(
        <Text key={`b-${match.index}`} bold color={defaultColor === "gray" ? "white" : defaultColor}>
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
 * and inline styles for Ink terminal rendering.
 */
export function MarkdownLine({
  text,
  defaultColor = "white",
  wrap = "wrap",
}: {
  text: string;
  defaultColor?: string;
  wrap?: "wrap" | "truncate" | "truncate-start" | "truncate-middle" | "truncate-end";
}) {
  // Code fence
  if (/^```/.test(text)) {
    const lang = text.slice(3).trim();
    return (
      <Text dimColor wrap={wrap}>
        ─── {lang ? `[${lang}]` : "code"} ──────────────────────────────
      </Text>
    );
  }

  // Heading 1
  const h1 = text.match(/^#\s+(.+)$/);
  if (h1 && h1[1]) {
    return (
      <Text bold color="cyanBright" wrap={wrap}>
        # {renderInlineSpans(h1[1], "cyanBright")}
      </Text>
    );
  }

  // Heading 2
  const h2 = text.match(/^##\s+(.+)$/);
  if (h2 && h2[1]) {
    return (
      <Text bold color="magentaBright" wrap={wrap}>
        ## {renderInlineSpans(h2[1], "magentaBright")}
      </Text>
    );
  }

  // Heading 3+
  const h3 = text.match(/^###+\s+(.+)$/);
  if (h3 && h3[1]) {
    return (
      <Text bold color="blueBright" wrap={wrap}>
        ### {renderInlineSpans(h3[1], "blueBright")}
      </Text>
    );
  }

  // Unordered list / bullet (- item, * item)
  const bullet = text.match(/^(\s*)([-*+])\s+(.+)$/);
  if (bullet && bullet[1] !== undefined && bullet[3] !== undefined) {
    return (
      <Text color={defaultColor} wrap={wrap}>
        {bullet[1]}
        <Text color="cyanBright">• </Text>
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
        <Text bold color="yellowBright">
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
      <Text color="gray" wrap={wrap}>
        <Text color="cyan">│ </Text>
        {renderInlineSpans(quote[1], "gray")}
      </Text>
    );
  }

  // Horizontal rule (---, ***, ___)
  if (/^(\*\*\*|---|___)$/.test(text.trim())) {
    return <Text dimColor wrap={wrap}>────────────────────────────────────────</Text>;
  }

  // Plain text with inline markdown
  return (
    <Text color={defaultColor} wrap={wrap}>
      {renderInlineSpans(text, defaultColor)}
    </Text>
  );
}
