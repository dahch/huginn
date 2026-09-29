/**
 * H-1 — document paths (`spec.md`/`adr.md`/`plan.md`) are symlink-screened and,
 * when they are project-relative, contained in the project.
 *
 * The threat is a **cloned repository**: it can ship `spec.md -> ~/.aws/credentials`
 * (or a `docs/` directory that points anywhere), which huginn used to follow both
 * when reading docs into an agent prompt and when writing freshly drafted ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDocPath, checkDocPath } from "../../src/util/docPath.js";
import { canonicalizeDocPath } from "../../src/cli.js";

let base: string;
let project: string;
let outside: string;
let secret: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-docpath-"));
  project = path.join(base, "project");
  outside = path.join(base, "outside");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  secret = path.join(outside, "credentials");
  fs.writeFileSync(secret, "AWS_SECRET\n");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** `symlinkSync` needs privileges on Windows, and these cases are POSIX-only. */
const windows = process.platform === "win32";

describe("checkDocPath (H-1)", () => {
  it("refuses a symlinked document even without a project root", () => {
    if (windows) return;
    const spec = path.join(project, "spec.md");
    fs.symlinkSync(secret, spec);

    const check = checkDocPath(spec);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("symlink");
  });

  it("refuses a symlink that points back inside the project (no link is followed, ever)", () => {
    if (windows) return;
    fs.writeFileSync(path.join(project, "real.md"), "# real\n");
    const spec = path.join(project, "spec.md");
    fs.symlinkSync(path.join(project, "real.md"), spec);

    expect(checkDocPath(spec, { projectPath: project }).ok).toBe(false);
  });

  it("accepts a document that does not exist yet (plan mode drafts it)", () => {
    const planPath = path.join(project, "plan.md");
    const check = checkDocPath(planPath, { projectPath: project });

    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.path).toBe(path.join(fs.realpathSync(project), "plan.md"));
  });

  it("refuses a project-relative doc reached through a symlinked directory that escapes", () => {
    if (windows) return;
    fs.mkdirSync(path.join(outside, "docs"));
    fs.writeFileSync(path.join(outside, "docs", "spec.md"), "# escaped\n");
    fs.symlinkSync(path.join(outside, "docs"), path.join(project, "docs"));

    const check = checkDocPath(path.join(project, "docs", "spec.md"), { projectPath: project });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).toContain("outside the project root");
  });

  it("resolves (and accepts) a symlinked parent directory that stays inside the project", () => {
    if (windows) return;
    fs.mkdirSync(path.join(project, "real-docs"));
    fs.writeFileSync(path.join(project, "real-docs", "spec.md"), "# real\n");
    fs.symlinkSync(path.join(project, "real-docs"), path.join(project, "docs"));

    const check = checkDocPath(path.join(project, "docs", "spec.md"), { projectPath: project });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.path).toBe(path.join(fs.realpathSync(project), "real-docs", "spec.md"));
  });

  it("keeps an explicitly configured out-of-project document working", () => {
    // `--spec /srv/shared/spec.md` is the user's choice: containment does not
    // apply, but the symlink screen does.
    fs.writeFileSync(path.join(outside, "shared.md"), "# shared\n");
    const check = checkDocPath(path.join(outside, "shared.md"), { projectPath: project });

    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.path).toBe(fs.realpathSync(path.join(outside, "shared.md")));
  });

  it("fails closed (throws) on a refused path for writers", () => {
    if (windows) return;
    const spec = path.join(project, "spec.md");
    fs.symlinkSync(secret, spec);

    expect(() => assertDocPath(spec, { projectPath: project, action: "write" })).toThrow(/symlink/);
  });
});

describe("canonicalizeDocPath (H-1, CLI)", () => {
  it("canonicalizes an existing regular doc", () => {
    const spec = path.join(project, "spec.md");
    fs.writeFileSync(spec, "# Spec\n");

    expect(canonicalizeDocPath(spec, project)).toBe(fs.realpathSync(project) + path.sep + "spec.md");
  });

  it("resolves a doc that does not exist yet", () => {
    expect(canonicalizeDocPath(path.join(project, "plan.md"), project)).toBe(
      path.join(fs.realpathSync(project), "plan.md"),
    );
  });

  it("exits with a clear error on a symlinked --spec instead of following it", () => {
    if (windows) return;
    const spec = path.join(project, "spec.md");
    fs.symlinkSync(secret, spec);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as unknown as typeof process.exit);
    try {
      expect(() => canonicalizeDocPath(spec, project)).toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
      const lines = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(lines).toContain("symlink");
      expect(lines).toContain("refusing");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
