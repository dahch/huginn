# Runtimes

What can execute the cycle, what each one actually does on this machine, and what
is deliberately **not** supported. This file is the contract; `huginn runtime
list --check` prints the same declarations, and `bun run scripts/probe-runtimes.ts
--prompt` reproduces the evidence below.

A **runtime** executes a cycle. A **provisioning target** is where `huginn setup`
writes the Muninn MCP entry and the rules block; the two lists are not the same,
and conflating them is how a target without a driver came to look supported.

## The rule

Only agents with a **real SDK** are kept as runtimes. A CLI wrapped in a
subprocess is not a runtime: it cannot report events, cannot answer a
permission, cannot resume, and every capability is a guess. The `generic` bridge
still exists for the nine CLI-only targets and is **deprecated**: it runs, but it
promises nothing beyond "a prompt went in and text came out".

## Supported runtimes

| Runtime | SDK | Declared capabilities | Verified here (2026-11-14) |
|---|---|---|---|
| `pi` | `@earendil-works/pi-coding-agent` 1.5.2, in-process | history, interrupt, dynamic catalog, MCP listing | **one turn works with an explicit model** (`commandcode/deepseek/deepseek-v4.1-flash` → `pong`). The SDK does **not** enumerate the providers declared in `~/.pi/agent/models.json`, so the catalog is empty and availability carries a note instead of a refusal |
| `codex` | `@openai/codex-sdk` 0.169.0 | history | **one turn works out of the box** (`pong` in 4.1 s). No abort, no streaming, no approvals, no catalog |
| `qwen` | `@qwen-code/sdk` 0.1.33 (bundles its CLI) | history, interrupt | **driver verified by contract + conformance, provider not verified here.** The SDK loads, but a real turn returns `401 Invalid 'Authorization' header or token` on this machine: there are no Qwen credentials configured. That message now reaches the caller verbatim instead of collapsing into "qwen failed" |
| `claude` | `@anthropic-ai/claude-agent-sdk` 0.3.325 (optional, external) | history, interrupt, usage | **driver verified by contract tests, provider not verified here.** `test/engine/agent/claudeSdk.test.ts` proves the turn construction, text/done/usage mapping, error propagation, per-prompt model and timeout, and abort — all through the injected adapter, with no account and no CLI. The real round-trip is unverified on this machine because the CLI answers "Not logged in"; one `--prompt` with a signed-in account settles it |
| `opencode` | `@opencode-ai/sdk` 1.19.5 + `opencode serve` | history, resume, streaming, interactive permissions, dynamic catalog, usage, MCP, interrupt | **v2 verified end to end** against v2.3.0: bootstrap, Basic auth, session creation, the asynchronous prompt (`POST /api/session/{id}/prompt`) resolved through the event stream, text deltas reaching the sink and a `done` event, with tokens and cost captured. Permissions on v2 are **not exercised yet** — the response path is the SDK's, and no real permission prompt was triggered |

### The opencode v2 migration

What the probe established against `opencode v2.3.0`, and what the driver must do:

| Need | v1 (current driver) | v2 (target) |
|---|---|---|
| base path | `/global/*`, `/session` | `/api/*` |
| auth | none | HTTP Basic, user `opencode`, password printed on stdout |
| health | `GET /global/health` → JSON | `GET /api/session` (there is no health route; unknown paths answer the web app's HTML with 200) |
| sessions | `POST /session`, `POST /session/{id}/message` | `client.session.create` / `session.prompt` from the generated v2 SDK |
| providers/catalog | `/config/providers` | `GET /api/provider` |
| events | `GET /event` (SSE) | the v2 SDK's event stream |
| permissions | `onPermission` over SSE | `/api/permission` |

The bootstrap and the prompt path are done. The SDK's generated *paths* are
relative to the API root, so pointing the client at `/api` fixed sessions and
events; the prompt needed real work, because v2's POST returns the user message
immediately and the answer arrives as `session.text.delta` →
`session.text.ended` → `session.execution.succeeded`. `src/server/opencodeV2.ts`
subscribes first, prompts second and resolves on the execution event; the driver
also maps those frames into the console sink, so streaming is real on v2.

Still open on this runtime: permissions and questions were not exercised against
v2 (the response helper still uses the SDK's path), and a v1 server keeps the
blocking prompt through the same code with no password.

### What the columns mean

- **history**: the session survives across prompts.
- **resume**: a stored session can be reopened by id.
- **streaming** / **events**: incremental text/tool events reach the console.
- **permissions**: the driver can ask before a tool runs (`ask`/`deny`).
- **catalog**: the driver can list models. Empty catalogs always carry a reason.
- **usage**: token/cost totals reported by the runtime.
- **interrupt**: a running turn can be aborted.
- **MCP**: the driver can enumerate MCP servers.

A capability that is not declared is not assumed: no surface waits for events a
runtime cannot emit.

## SDKs that exist upstream but are **not** integrated

| Agent | SDK | Status |
|---|---|---|
| `kimi` | `@moonshot-ai/kimi-agent-sdk` (0.1.8) | **Planned.** Not integrated yet; still a provisioning target through the deprecated `generic` bridge |
| `antigravity` | Python only | **Excluded by decision.** Its SDK has no TypeScript distribution, and a Python bridge would add a second runtime language for one agent. Not a provisioning target either |
| `cursor`, `agy`, `commandcode`, `devin`, `mcode`, `mimo`, `omp` | none published | Provisioning targets only. `commandcode` is reachable **through** `pi`/`opencode` models, not as a runtime of its own |

Adding one of these means a new driver in `src/engine/agent/drivers/`, a
conformance run, and an entry in this table. It is not a configuration change.

## What is not supported, by design

- **`ask`/`deny` on subprocess runtimes.** Only `opencode` has a permission
  channel; the others fail closed when asked for `ask`/`deny` rather than
  pretending the flag was honoured.
- **Resume outside `opencode`.** No other SDK exposes enough to reopen a stored
  session; `sessionHistory` is not the same thing as `sessionResume`.
- **A filesystem sandbox.** Every driver declares `worktree`: the agent is
  *pointed* at the iteration worktree and nothing stops it writing under `$HOME`.
  `src/engine/homeGuard.ts` only reports what changed.
- **Model catalogs for codex and claude.** Their SDKs expose none; pass an
  explicit model id. An empty catalog with a reason is the contract.
