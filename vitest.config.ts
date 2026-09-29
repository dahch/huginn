import { defineConfig } from "vitest/config";

// `include` is deliberately `test/**/*.test.ts` **only** — not `src/**/*.test.ts`
// as well.
//
// The unit suites living next to the code are written for `bun:test` (bun:test
// imports, `Bun.*` APIs), and `bun test` already discovers and runs them: its
// default pattern (`**/*.test.ts`, node_modules excluded) covers the whole
// repository. Adding `src/**/*.test.ts` to vitest's `include` would run that half
// of the suite a second time under a different runner — the same tests, double
// the CI time, two ways for one failure — so vitest keeps owning `test/**` only.
// `npm run test` runs both runners, and `publish.yml` calls `npm run test`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // `test/contracts/compiler.test.ts` builds real TypeScript programs and the
    // git-heavy suites spawn processes; under CI load (a shared runner, right
    // after `bun test`) the default 5 s budget was not enough for otherwise
    // healthy tests, which made `publish.yml` flaky. 20 s still fails a genuine
    // hang long before the 20-minute job timeout.
    testTimeout: 20_000,
  },
});
