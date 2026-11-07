import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  diffWorld,
  snapshotWorld,
  watchedPaths,
} from "../../src/engine/homeGuard.js";

let root: string;
let project: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "huginn-homeguard-"));
  project = join(root, "project");
  home = join(root, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("homeGuard (writes outside the project)", () => {
  it("watches agent configs, and never the ones inside the project", () => {
    const watched = watchedPaths({ projectPath: project, homeDir: home });
    const paths = watched.map((entry) => entry.path);

    // A user-scoped config is watched…
    expect(paths).toContain(join(home, ".claude.json"));
    // …and its project-scoped sibling is not: it is supposed to change, and it
    // lands in the iteration's own diff.
    expect(paths).not.toContain(join(project, ".mcp.json"));
    expect(paths).not.toContain(join(project, ".cursor", "mcp.json"));
    // The memory stores both tools write are watched too.
    expect(paths).toContain(join(home, ".muninn", "mcp.json"));
    expect(paths).toContain(join(home, ".huginn", "config.json"));
  });

  it("reports a created, a rewritten and a deleted file with the reason", () => {
    const watched = watchedPaths({ projectPath: project, homeDir: home });
    const claude = join(home, ".claude.json");
    const cursor = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(cursor, '{"mcpServers":{}}\n');

    const before = snapshotWorld(watched);

    writeFileSync(claude, '{"mcpServers":{"muninn":{"command":"muninn"}}}\n');
    writeFileSync(cursor, '{"mcpServers":{"muninn":{"command":"huginn"}}}\n');
    const afterRewrite = snapshotWorld(watched);

    const changes = diffWorld(before, afterRewrite, watched);
    const byPath = new Map(changes.map((change) => [change.path, change]));

    expect(byPath.get(claude)?.detail).toContain("created");
    expect(byPath.get(cursor)?.detail).toContain("rewritten");
    expect(byPath.get(claude)?.label).toContain("Claude");

    unlinkSync(cursor);
    const afterDelete = snapshotWorld(watched);
    const deletions = diffWorld(afterRewrite, afterDelete, watched);
    expect(deletions.find((change) => change.path === cursor)?.detail).toContain("deleted");
  });

  it("says nothing when the world did not move", () => {
    const watched = watchedPaths({ projectPath: project, homeDir: home });
    writeFileSync(join(home, ".claude.json"), "{}\n");
    const before = snapshotWorld(watched);
    const after = snapshotWorld(watched);
    expect(diffWorld(before, after, watched)).toEqual([]);
  });

  it("ignores a change to a project-scoped config", () => {
    const watched = watchedPaths({ projectPath: project, homeDir: home });
    const before = snapshotWorld(watched);
    writeFileSync(join(project, ".mcp.json"), '{"mcpServers":{"muninn":{}}}\n');
    const after = snapshotWorld(watched);
    // Not watched, so not in the snapshot and not in the report.
    expect(diffWorld(before, after, watched)).toEqual([]);
  });
});
