# Test fixtures — provenance

These files are **captured from real tool output on this machine** (not hand-written),
so the parsers under test are verified against the actual formats they must handle.

| File | Source command | Notes |
|---|---|---|
| `opencode-models.txt` | `opencode models` | 581 lines, one `provider/model` per line. This is the CLI fallback source for opencode model discovery. |
| `opencode-provider-list.json` | `GET /provider` via `@opencode-ai/sdk` (`client.provider.list()`) | Response shape `{ all, default, connected }`. **Trimmed for size**: only the 10 `connected` providers plus 3 unconnected samples (`deepinfra`, `perplexity-agent`, `bailing`), each capped at 8 models. Filtering `all` by `connected` yields **53** models as captured; the untrimmed live response yields 581. |
| `opencode-mcp-list.txt` | `opencode mcp list` | Box list: `●  ✓ <name> <ESC>[90mconnected` then an indented command line, closing `└  N server(s)`. **Contains ANSI colour codes** a parser must strip. 3 servers. Parser: `parseOpencodeMcpList` (AC-32.1). |
| `claude-mcp-list.txt` | `claude mcp list` | `Checking MCP server health…` preamble, blank line, then `<name>: <command> - ✔ Connected`. The CLI health-checks every server (≈ 23 s measured), which is why the listing has its own generous deadline. 3 servers. Parser: `parseClaudeMcpList`. |
| `pi-models.txt` | `pi --list-models` | Pi coding agent `@earendil-works/pi-coding-agent` 0.87.1, captured 2026-09-29. 3 lines: the aligned header `provider  model  context  max-out  thinking  images` plus two model rows. Parses to **2** models. Parser: `parsePiModels` (AC-27.4). |
| `codex-mcp-list.json` | `codex mcp list --json` | OpenAI `codex-cli` 0.158.0, captured 2026-09-29. One-element JSON array: a `stdio` server (`muninn`) with the absolute project path redacted to `/home/dev/projects/huginn`. `enabled` is Codex's own configuration word; nothing is a liveness probe. 1 server. Parser: `parseCodexMcpList` (AC-32.1). |
| `pi-mcp-list.json` | `pi mcp list --json` | Pi 1.4.0, captured 2026-11-25. `{ servers: [...] }` with user (`rea`) and project (`muninn`) entries, each carrying `scope`, `source`, `transport`, `state` and `tools`. Home/project paths redacted to `/home/dev/…`; the row shape is untouched. Parser: `parsePiMcpListJson` (REQ-32). |

## Provenance and redaction of the `pi` / `codex` fixtures

Both were captured on **2026-09-29** from the installed CLIs (pi 0.87.1,
codex-cli 0.158.0). Redactions applied at capture time:

- `pi-models.txt` — `pi --list-models`, verbatim (the table holds no
  machine-specific data).
- `codex-mcp-list.json` — `codex mcp list --json`; the absolute project path in
  the `stdio` server's args was rewritten to `/home/dev/projects/huginn` (see
  "Path redaction of the MCP fixtures" below). The row shape is untouched.

`test/fixtures/fixtureHygiene.test.ts` scans every file in this directory on
each `vitest` run, so a re-capture cannot silently reintroduce a live key.

## Redaction of `opencode-provider-list.json`

The live `GET /provider` response embeds each provider's resolved configuration,
which includes the **real provider API keys** the daemon loaded from
`~/.config/opencode` (a top-level `key` string per provider, plus a provider-level
`options` map). Those fields were removed when the fixture was captured:

- no provider object carries a `key`, `apiKey`, `api_key`, `Authorization` or
  `options` field (verified by `test/fixtures/fixtureHygiene.test.ts`);
- the only surviving `options` values are the *empty* per-model maps the catalog
  itself ships (`"options":{}` for most models, and one model whose options hold a
  non-secret `serviceTier` routing hint) — no credential material;
- `env` arrays still list the *names* of the environment variables a provider
  reads (`DEEPSEEK_API_KEY`, …), which are not secrets.

## Path redaction of the MCP fixtures

The captured MCP listings quote the absolute paths the reference machine uses for
agent binaries and projects (e.g. `codegraph`, `muninn`). Any personal home path
(`/Users/<user>/…`) was rewritten to a neutral `/home/dev/…` when the fixture was
captured — only the path prefix changed, never the row shape — so the fixtures
carry no machine-specific identity. The parsers split on column runs and never
depend on a path's length, so this does not affect them.

## Removed in M4b

The per-CLI fixtures for `agy`, `commandcode`, `devin`, `kimi`, `mimo` and `omp`
(`*-models.txt`, `*-mcp-list.txt`, `kimi-provider-list.json`) were deleted with
their adapter parsers when those targets moved to the configured `generic`
runtime. They remain provisioning targets, but their discovery is now honestly
empty; there is no parser left to verify a fixture against.
