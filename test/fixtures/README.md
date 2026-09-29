# Test fixtures — provenance

These files are **captured from real tool output on this machine** (not hand-written),
so the parsers under test are verified against the actual formats they must handle.

| File | Source command | Notes |
|---|---|---|
| `opencode-models.txt` | `opencode models` | 581 lines, one `provider/model` per line. This is the CLI fallback source for opencode model discovery. |
| `commandcode-list-models.txt` | `commandcode --list-models` | 116 lines: `Available models · N models` header, provider group headings (`Open Source`, `Anthropic`, `Sakana`, …), `id` + description rows with a 2+ space gap, and a trailing help/docs/`Decision models` footer that a parser must ignore. Parses to **82** models (AC-27.3). |
| `omp-models.txt` | `omp models` | 221 lines. Five provider sections (`deepseek (4)`, `fireworks (36)`, `ollama (1)`, `opencode-go (42)`, `opencode-zen (109)`), each a blank-line-separated heading followed by a box-drawing table (`┌ ├ └ ─ ┬ ┼ ┴ ┐ ┘`, header row `│ model │ context │ … │`, data rows starting with `│`). Parses to **192** models; the same model name may appear under several sections, so ids are `provider/model`. Parser: `parseOmpModels` (AC-27.4). |
| `agy-models.txt` | `agy models` | 14 lines of TSV (`id<TAB>name`), e.g. `gemini-3.8-flash-high\tGemini 3.8 Flash (High)`. Captured without the `Fetching available models...` preamble the CLI prints on a non-TSV line; the parser skips it (covered by a synthetic case in `test/engine/agent/agyModels.test.ts`). Parser: `parseAgyModels` (AC-27.4). |
| `opencode-provider-list.json` | `GET /provider` via `@opencode-ai/sdk` (`client.provider.list()`) | Response shape `{ all, default, connected }`. **Trimmed for size**: only the 10 `connected` providers plus 3 unconnected samples (`deepinfra`, `perplexity-agent`, `bailing`), each capped at 8 models. Filtering `all` by `connected` yields **53** models as captured; the untrimmed live response yields 581. |
| `opencode-mcp-list.txt` | `opencode mcp list` | Box list: `●  ✓ <name> <ESC>[90mconnected` then an indented command line, closing `└  N server(s)`. **Contains ANSI colour codes** a parser must strip. 3 servers. Parser: `parseOpencodeMcpList` (AC-32.1). |
| `claude-mcp-list.txt` | `claude mcp list` | `Checking MCP server health…` preamble, blank line, then `<name>: <command> - ✔ Connected`. The CLI health-checks every server (≈ 23 s measured), which is why the listing has its own generous deadline. 3 servers. Parser: `parseClaudeMcpList`. |
| `qwen-mcp-list.txt` | `qwen mcp list` | `Configured MCP servers:` then `<ESC>[32m✓<ESC>[0m <name>: <command> (<transport>) - Connected`. 1 server. Parser: `parseQwenMcpList`. |
| `agy-mcp-list.txt` | `agy mcp list` | TSV with header `NAME TYPE STATUS COMMAND/URL` then rows; status is `enabled`/`disabled` (configuration state, **not** a liveness probe). 5 servers. Parser: `parseAgyMcpList`. |
| `commandcode-mcp-list.txt` | `commandcode mcp list` | Blank line, `MCP Servers`, a `NAME TYPE SCOPE AUTH STATUS` table, then `Total: N server(s)`. 1 server; scope is surfaced as `detail`. Parser: `parseCommandcodeMcpList`. |
| `devin-models.txt` | `devin models list` | `Available models (N families)` preamble, then one `<Family Label> (<family-uid>)` section per family (some followed by an indented `aliases: …` note) and indented variant rows `<model_uid>` + 2+ spaces + `<label>` with an optional trailing `[cost / context]` annotation, plus a free-text footer. 763 lines; parses to **644** models across **54** families. Parser: `parseDevinModels` (AC-27.4). |
| `devin-mcp-list.txt` | `devin mcp list` | `Configured MCP servers:` heading, then per server a glyph-led row (`• <name>` enabled, `✗ <name>  (disabled)`) followed by an indented `Command: …` (stdio) or `URL: …` (http) detail. 6 servers; the status is the CLI's own enabled/disabled configuration word, never a liveness probe. Parser: `parseDevinMcpList` (AC-32.1). |
| `mimo-models.txt` | `mimo models` | MiMo Code 0.1.15. 9 lines, one `<provider>/<model> — <description>` per model (`deepseek/deepseek-flash — window 1M, compacts at 900K`); the separator is a U+2014 EM DASH. Parses to **9** models across 3 providers (`deepseek`, `mimo`, `xiaomi`). The wired command is the CLI's default (`mimo models`); its `--verbose` variant interleaves a multi-line JSON document per model (550 lines) and is covered by a synthetic case in `test/engine/agent/mimoModels.test.ts`, because every row line stays identical and no JSON line carries an EM DASH. Parser: `parseMimoModels` (AC-27.4). |
| `mimo-mcp-list.txt` | `mimo mcp list` | MiMo Code 0.1.15. **Byte-identical in shape to `opencode-mcp-list.txt`** (MiMo Code is opencode-derived): the `┌ MCP Servers` / `●  ✓ <name> <ESC>[90mconnected …` rows with an indented command line and a `└  N server(s)` footer. 3 servers. One difference worth noting: the status cell also names the config the server came from (`claude:~/.claude.json`, `opencode:<config dir>`), which must not be mistaken for the status. Consumed by the shared `parseOpencodeMcpList` (AC-32.1). |
| `kimi-provider-list.json` | `kimi provider list --json` | Kimi Code 2.1.1, captured 2026-09-29. Two-key JSON document `{ providers: { <id>: { type, baseUrl, apiKeyEnv, … } }, models: { <alias>: { provider, model, maxContextSize, …, displayName } } }`. Only the `models` map is read (`id` = alias, `name` = `displayName`); parses to **4** models. The sibling `providers` map survives in the fixture but is ignored by the parser; its `baseUrl`s were redacted to `.example` hostnames and its `apiKeyEnv` values are environment-variable **names** (`DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`), not secrets. Parser: `parseKimiModels` (AC-27.4). Captured 2026-09-29. |
| `pi-models.txt` | `pi --list-models` | Pi coding agent `@earendil-works/pi-coding-agent` 0.87.1, captured 2026-09-29. 3 lines: the aligned header `provider  model  context  max-out  thinking  images` plus two model rows. Parses to **2** models. Parser: `parsePiModels` (AC-27.4). |
| `codex-mcp-list.json` | `codex mcp list --json` | OpenAI `codex-cli` 0.158.0, captured 2026-09-29. One-element JSON array: a `stdio` server (`muninn`) with the absolute project path redacted to `/home/dev/projects/huginn`. `enabled` is Codex's own configuration word; nothing is a liveness probe. 1 server. Parser: `parseCodexMcpList` (AC-32.1). |

## Provenance and redaction of the Phase 3C fixtures (`kimi` / `pi` / `codex`)

All three were captured on **2026-09-29** from the installed CLIs (Kimi Code
2.1.1, pi 0.87.1, codex-cli 0.158.0). Redactions applied at capture time:

- `kimi-provider-list.json` — `kimi provider list --json`. Only the `models` map
  is consumed (the parser ignores the sibling `providers` map), so the document
  is left as captured apart from two neutralisations: every `baseUrl` host was
  rewritten to a `.example` domain, and no provider carries an inline key. The
  surviving `apiKeyEnv` values are environment-variable **names**
  (`DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`) — hints about where to *look* for a
  credential, never the credential itself.
- `pi-models.txt` — `pi --list-models`, verbatim (the table holds no
  machine-specific data).
- `codex-mcp-list.json` — `codex mcp list --json`; the absolute project path in
  the `stdio` server's args was rewritten to `/home/dev/projects/huginn` (see
  "Path redaction of the MCP fixtures" below). The row shape is untouched.

`test/fixtures/fixtureHygiene.test.ts` scans all three on every `vitest` run, so a
re-capture cannot silently reintroduce a live key.

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

`test/fixtures/fixtureHygiene.test.ts` scans **every** file in this directory on
each `vitest` run and fails on an `sk-…` / OpenRouter / `sk_…` / `fw_…` / `AQ.…` /
`IFM-v…` key shape or on a credential-named JSON field with a non-empty value, so a
future re-capture cannot silently reintroduce a live key. If you re-capture this
fixture, re-run that test before committing.

Regenerating: run the equivalent commands against installed `opencode`/
`commandcode`/`omp`/`agy`/`devin`/`mimo` CLIs. See `plan.md` Iteration 25 for the
exact API (`client.provider.list()` against a `opencode serve` daemon).

The two Phase 3B listings were captured from MiMo Code 0.1.15 with the installed
binary addressed by absolute path (`~/.mimocode/bin/mimo models`,
`~/.mimocode/bin/mimo mcp list`), so no shell banner contaminates the capture.
The `mcode` CLI (MiniMax Code 0.5.8) contributes **no** fixture: it exposes no
model-listing command and has no `mcp` command at all, so both discovery paths
are honestly empty and there is nothing to verify a parser against.

## Path redaction of the MCP fixtures

The captured MCP listings quote the absolute paths the reference machine uses for
agent binaries and projects (e.g. `codegraph`, `muninn`). Any personal home path
(`/Users/<user>/…`) was rewritten to a neutral `/home/dev/…` when the fixture was
captured — only the path prefix changed, never the row shape — so the fixtures
carry no machine-specific identity. The parsers split on column runs and never
depend on a path's length, so this does not affect them.
