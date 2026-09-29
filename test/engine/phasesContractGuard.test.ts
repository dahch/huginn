import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyContractsOrFail } from "../../src/engine/phases.js";

/**
 * REV-114: a compiler-contract verification that *throws* must fail closed and
 * say so — never silently degrade the gate to an agent-judged pass.
 *
 * The verifier is injected rather than module-mocked: `bun test` and `vitest`
 * do not share a module-mock API (`vi.mock` factories are unsupported by Bun),
 * so a throwing verifier is passed in directly.
 */
describe("contract verification failure (REV-114)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-contract-guard-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("fails closed to BLOCKED when the verifier throws", () => {
    fs.writeFileSync(path.join(tempDir, "valid.ts"), "export const ok: number = 1;\n");

    const result = verifyContractsOrFail(tempDir, ["valid.ts"], () => {
      throw new Error("compiler exploded");
    });

    expect(result).not.toBeNull();
    expect(result!.authoritativeVerdict).toBe("blocked");
    expect(result!.text).toContain("### Overall gate: 🔴");
    expect(result!.text).toContain("🛑 BLOCKED");
    expect(result!.text).toContain("compiler exploded");
  });

  it("returns null when there is nothing to verify", () => {
    expect(verifyContractsOrFail(tempDir, [])).toBeNull();
  });
});
