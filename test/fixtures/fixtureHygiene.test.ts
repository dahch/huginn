import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Credential shapes that must never be committed inside a captured fixture
 * (REQ-27 / SEC-001). `opencode-provider-list.json` was captured from a live
 * `GET /provider` and originally embedded real provider API keys, which were
 * stripped by hand; this guard makes a future re-capture that reintroduces them
 * fail loudly in CI instead of silently publishing them.
 *
 * NOTE: the OpenRouter prefix is assembled from two literals on purpose — this
 * test file itself lives inside the directory it scans, so an inlined literal
 * would make the guard flag its own source.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "OpenAI-style `sk-…` key", pattern: /sk-[A-Za-z0-9_-]{16,}/ },
  { id: "OpenRouter key prefix", pattern: new RegExp(["sk-or-", "v1-"].join("")) },
  { id: "`sk_…` API key", pattern: /sk_[A-Za-z0-9]{16,}/ },
  { id: "Fireworks `fw_…` key", pattern: /fw_[A-Za-z0-9]{16,}/ },
  { id: "Google `AQ.…` OAuth token", pattern: /AQ\.[A-Za-z0-9_-]{16,}/ },
  { id: "IFM versioned key", pattern: /IFM-v[0-9]/ },
];

/**
 * A JSON field whose *name* is a credential slot (`key` / `apiKey` / `api_key` /
 * `Authorization`) and whose value is a non-empty string.
 */
const CREDENTIAL_JSON_FIELD =
  /"(?:key|apiKey|api_key|Authorization|authorization)"\s*:\s*"[^"]+"/;

/** Recursively list every regular file under `test/fixtures/`, relative-sorted. */
function listFixtureFiles(dir: string = FIXTURES_DIR, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...listFixtureFiles(join(dir, entry.name), relative));
    } else if (entry.isFile()) {
      found.push(relative);
    }
  }
  return found.sort();
}

/** Every credential-shape id found in `text` (empty array ⇒ clean). */
function scanForCredentials(text: string): string[] {
  const hits: string[] = [];
  for (const { id, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) hits.push(id);
  }
  if (CREDENTIAL_JSON_FIELD.test(text)) hits.push("credential-bearing JSON field");
  return hits;
}

describe("fixture hygiene — captured fixtures never embed credentials (REQ-27 / SEC-001)", () => {
  it("finds no credential shape in any file under test/fixtures/", () => {
    const files = listFixtureFiles();
    // Guard against a vacuous pass (e.g. the directory being moved/emptied).
    expect(files.length).toBeGreaterThanOrEqual(5);

    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(FIXTURES_DIR, file), "utf8");
      for (const hit of scanForCredentials(text)) {
        violations.push(`${file}: ${hit}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("detects each shape it claims to detect (the guard is not vacuous)", () => {
    // Every sample is assembled from fragments so that this source file does not
    // itself read as a violation (it is scanned by the test above).
    const fakeOpenAiKey = "sk-" + "A".repeat(32);
    const fakeOpenRouterKey = "sk-or-" + "v1-" + "b".repeat(32);
    expect(scanForCredentials(JSON.stringify({ api_key: fakeOpenAiKey }))).toContain(
      "OpenAI-style `sk-…` key",
    );
    expect(scanForCredentials(JSON.stringify({ auth: fakeOpenRouterKey }))).toContain(
      "OpenRouter key prefix",
    );
    expect(scanForCredentials("sk_" + "B".repeat(24))).toContain("`sk_…` API key");
    expect(scanForCredentials("fw_" + "C".repeat(24))).toContain("Fireworks `fw_…` key");
    expect(scanForCredentials("AQ." + "D".repeat(24))).toContain("Google `AQ.…` OAuth token");
    expect(scanForCredentials("IFM-" + "v4")).toContain("IFM versioned key");
    expect(scanForCredentials(JSON.stringify({ ["Authori" + "zation"]: "Bearer xyz" }))).toContain(
      "credential-bearing JSON field",
    );
    expect(scanForCredentials(JSON.stringify({ apiKey: fakeOpenAiKey }))).toContain(
      "credential-bearing JSON field",
    );

    // …and stays silent on ordinary fixture content.
    expect(scanForCredentials('{"id":"deepseek","name":"DeepSeek","env":["DEEPSEEK_API_KEY"]}')).toEqual([]);
  });

  it("opencode-provider-list.json carries no top-level provider credential fields", () => {
    const raw = readFileSync(join(FIXTURES_DIR, "opencode-provider-list.json"), "utf8");
    const parsed = JSON.parse(raw) as { all?: Array<Record<string, unknown>> };
    const providers = parsed.all ?? [];
    expect(providers.length).toBeGreaterThan(0);

    const forbidden = ["key", "apiKey", "api_key", "Authorization", "options"];
    const offenders = providers
      .flatMap((p) => forbidden.filter((field) => field in p).map((field) => `${String(p.id)}.${field}`))
      .filter(Boolean);
    expect(offenders).toEqual([]);
  });
});
