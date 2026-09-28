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
`commandcode`/`omp`/`agy` CLIs. See `plan.md` Iteration 25 for the exact API
(`client.provider.list()` against a `opencode serve` daemon).
