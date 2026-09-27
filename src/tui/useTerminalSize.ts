import { useState, useEffect } from "react";

export interface TerminalSize {
  rows: number;
  columns: number;
}

export const DEFAULT_ROWS = 24;
export const DEFAULT_COLUMNS = 80;

export function getTerminalSize(): TerminalSize {
  const rows =
    typeof process.stdout?.rows === "number" && process.stdout.rows > 0
      ? process.stdout.rows
      : DEFAULT_ROWS;
  const columns =
    typeof process.stdout?.columns === "number" && process.stdout.columns > 0
      ? process.stdout.columns
      : DEFAULT_COLUMNS;
  return { rows, columns };
}

export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(getTerminalSize);

  useEffect(() => {
    const handleResize = () => {
      setSize(getTerminalSize());
    };

    if (process.stdout && typeof process.stdout.on === "function") {
      process.stdout.on("resize", handleResize);
    }

    return () => {
      if (process.stdout && typeof process.stdout.removeListener === "function") {
        process.stdout.removeListener("resize", handleResize);
      } else if (
        process.stdout &&
        typeof (process.stdout as unknown as { off?: Function }).off === "function"
      ) {
        (process.stdout as unknown as { off: Function }).off("resize", handleResize);
      }
    };
  }, []);

  return size;
}
