/**
 * Keep the process-level exit code out of Bun's cross-file test state.
 *
 * `bun test` runs `src/**` and `test/**` together. Command tests deliberately
 * exercise failure paths that set `process.exitCode = 1`; once one file leaves
 * that value behind, a later test in another file that asserts a successful
 * exit reads the stale code, and the runner itself exits non-zero. Resetting it
 * after each test (and after the file) makes the suite independent of file
 * order without hiding a real assertion failure — Bun still reports and exits
 * non-zero for a failing test.
 */
import { afterAll, afterEach } from "bun:test";

afterEach(() => {
  process.exitCode = 0;
});

afterAll(() => {
  process.exitCode = 0;
});
