import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { usage } from "../../src/cli";
import { PROFILE_NAMES } from "../../src/engine/profiles";

/**
 * The adoption surface is a contract with a reader, and it rots silently.
 *
 * The README's first screen is where a newcomer decides whether to care: the
 * differentiating line, a real demo, and a five-minute path to a receipt. Those
 * three are easy to break without noticing — a moved image, a renamed file, a
 * command the CLI no longer accepts, a profile missing from the table — and
 * nothing else in the suite looks at a markdown file. This does.
 *
 * It is deliberately structural, not editorial: it can tell that an image is
 * missing or a command is dead, never that a sentence got worse.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const lines = readme.split("\n");

/** The README before the first `## ` heading: the only part every visitor reads. */
const firstSection = (() => {
  const heading = lines.findIndex((line, index) => index > 0 && line.startsWith("## "));
  return lines.slice(0, heading === -1 ? lines.length : heading).join("\n");
})();

/** The fenced block under a heading, as lines (`## ` until the next heading). */
function blockFor(heading: string): string | undefined {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");
}

describe("README adoption surface", () => {
  it("opens with the differentiator, before any version news", () => {
    // The third non-empty line is the hero claim (title, badges, claim): a
    // release banner pushed it down once already, and that is the point of the
    // assertion.
    const nonEmpty = lines.filter((line) => line.trim().length > 0);
    expect(nonEmpty[0]).toBe("# Huginn");
    expect(nonEmpty[1]?.startsWith("[![")).toBe(true);
    expect(nonEmpty[2]).toMatch(/^\*\*The gate is huginn's, not the model's/);
  });

  it("makes the claim specific: receipt, parsed verdicts, resumability", () => {
    for (const claim of [
      ".huginn/receipts/",
      "tree hash",
      "Verdicts are **parsed**",
      "interrupted run restarts the phase",
    ]) {
      expect(firstSection).toContain(claim);
    }
  });

  it("shows the cost of the cycle instead of implying it is free", () => {
    // The bench numbers are the difference between a claim and marketing, and
    // the honest half of the pitch. If they change, the benchmark document has
    // to change with them.
    expect(firstSection).toContain("42/42");
    expect(firstSection).toContain("36/42");
    expect(firstSection).toContain("5–6×");
    expect(firstSection).toContain("docs/DECISION-2026-11.md");
  });

  it("embeds both demo animations, and the files exist", () => {
    for (const name of ["huginn", "lite"]) {
      expect(readme).toContain(`docs/media/${name}.gif`);
      for (const extension of ["gif", "png"]) {
        const asset = join(ROOT, "docs", "media", `${name}.${extension}`);
        expect(existsSync(asset), `${asset} is referenced by the README but missing`).toBe(true);
        expect(statSync(asset).size).toBeGreaterThan(10_000);
      }
      expect(readme).toContain(`docs/media/${name}.mp4`);
      expect(existsSync(join(ROOT, "docs", "media", `${name}.mp4`))).toBe(true);
    }
    // The media directory documents how the demos are produced, so a future
    // change knows what to re-record.
    const mediaDoc = readFileSync(join(ROOT, "docs", "media", "README.md"), "utf8");
    expect(mediaDoc).toContain("capture.ts");
    expect(mediaDoc).toContain("render_media.py");
    expect(mediaDoc).toContain("What is real and what is scripted");
  });

  it("keeps a five-minute quick start whose commands the CLI still accepts", () => {
    const quickStart = blockFor("## Quick start (5 minutes)");
    expect(quickStart, "the quick-start section is gone").toBeDefined();
    const text = quickStart ?? "";

    // The concrete use case and the receipt at the end of it.
    expect(text).toContain('huginn plan "');
    expect(text).toContain("huginn run --profile lite");
    expect(text).toContain("huginn report");
    expect(text).toContain(".huginn/receipts/iter-1.json");

    // Drift guard: every `huginn <subcommand>` the quick start prints is a
    // command the reference help documents, so a rename cannot leave the first
    // screen teaching a command that no longer exists.
    const reference = usage();
    const listed = new Set(
      [...reference.matchAll(/^\s{2}([a-z][a-z-]*)\s{2,}/gm)].map((match) => match[1]),
    );
    expect(listed.size).toBeGreaterThan(5);
    // Only what a reader is meant to *type*: a fenced `sh` line, or an inline
    // code span. Prose ("huginn runs the Verification commands") is not a
    // command and must not fail the guard.
    const commands = new Set<string>();
    for (const block of text.matchAll(/```sh\n([\s\S]*?)```/g)) {
      for (const line of (block[1] ?? "").split("\n")) {
        const match = /^\s*huginn ([a-z][a-z-]+)/.exec(line);
        if (match?.[1]) commands.add(match[1]);
      }
    }
    for (const match of text.matchAll(/`huginn ([a-z][a-z-]+)/g)) {
      if (match[1]) commands.add(match[1]);
    }
    expect(commands.size).toBeGreaterThanOrEqual(3);
    for (const command of commands) {
      expect(listed, `the quick start teaches "huginn ${command}", which --help --all no longer lists`).toContain(
        command,
      );
    }
  });

  it("opens the door to the writeup before the manual", () => {
    // The repo is the appendix; the text is the door. A reader who wants the
    // reasoning first must not have to scroll past nine hundred lines for it.
    expect(firstSection).toContain("HOW-I-WORK.md");
    expect(firstSection).toContain("how I work");
    const writeup = join(ROOT, "HOW-I-WORK.md");
    expect(existsSync(writeup), "HOW-I-WORK.md is the door but is missing").toBe(true);
    expect(statSync(writeup).size).toBeGreaterThan(5_000);
  });

  it("says out loud who the tool is for, and who it is not", () => {
    // An honest negative half filters better than a feature list, and it is the
    // cheapest thing a newcomer can check against their own way of working.
    const filter = blockFor("## Is this you?");
    expect(filter, "the 'Is this you?' section is gone").toBeDefined();
    const text = filter ?? "";
    expect(text).toContain("It fits if you");
    expect(text).toContain("It does not fit if you");
    // The assumptions the tool actually makes.
    expect(text).toContain("MCP");
    expect(text).toContain("auditability over speed");
    expect(text).toContain("plan → execute → audit");
    // The filter must come before the onboarding path, not after it.
    expect(readme.indexOf("## Is this you?")).toBeLessThan(readme.indexOf("## Quick start (5 minutes)"));
  });

  it("keeps the writeup honest rather than promotional", () => {
    const writeup = readFileSync(join(ROOT, "HOW-I-WORK.md"), "utf8");
    // It has to publish the cost it is asking the reader to pay.
    expect(writeup).toContain("42 of 42");
    expect(writeup).toContain("36");
    expect(writeup).toContain("five to six times the wall clock");
    // It has to name its own limits and the arguments it lost.
    expect(writeup).toContain("What I refuse to claim");
    expect(writeup).toContain("does not, and the bench");
    // And it must point at the evidence, not at itself.
    expect(writeup).toContain("DECISION-2026-11.md");
    expect(writeup).toContain("ADR.md");
    // A door, not a stub: the reasoning lives here.
    expect(writeup.split("\n").length).toBeGreaterThan(100);
  });

  it("documents every methodology profile it can be run with", () => {
    // `lite` shipped without a row in this table and without a mention in the
    // flag reference; a reader could run it and never find it. One assertion on
    // the registry, so the next profile cannot repeat that.
    const profiles = blockFor("### Methodology profiles");
    expect(profiles, "the methodology-profiles section is gone").toBeDefined();
    for (const profile of PROFILE_NAMES) {
      expect(profiles, `profile "${profile}" is missing from the README table`).toContain(
        `| \`${profile}\` |`,
      );
    }
    expect(readme).toContain(`| \`--profile <id>\` |`);
    for (const profile of PROFILE_NAMES) {
      expect(readme, "the --profile row should list every profile").toContain(`\`${profile}\``);
    }
  });
});
