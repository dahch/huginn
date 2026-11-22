# Demo media

The animated demos the root `README.md` embeds, and the two scripts that produce
them. Nothing here is drawn by hand: the frames are the terminal output of the
real `Dashboard` component while the real `CycleEngine` runs a real plan in a
real git repository.

| File | What it shows |
|---|---|
| `huginn.gif` / `huginn.mp4` / `huginn.png` | The nine-phase **Huginn Cycle** on one iteration: each phase's verdict, the deterministic commit, the receipt, and `huginn report` reading it back in two lanes. `huginn.png` is the dashboard frame, for a social preview. |
| `lite.gif` / `lite.mp4` / `lite.png` | The **`lite` profile** on the same iteration: `EXECUTE → VERIFY → COMMIT_ALL`, one receipt. |
| `capture.ts` | Records a demo: builds a throwaway repository, mounts `Dashboard`, drives `CycleEngine` with a scripted `RuntimePort`, and writes `build/<demo>.jsonl` (one timed ANSI chunk per write). |
| `render_media.py` | Replays that stream through a small terminal emulator, renders each frame with a monospace font, and writes the GIF (Pillow), the MP4 (ffmpeg, when installed) and the poster PNG. |

## What is real and what is scripted

| Part | Real | Scripted |
|---|---|---|
| Phase pipeline, gates, verdict parsing | yes | |
| `VERIFY` — the plan's `Verification:` commands | yes (`bun test` runs) | |
| `COMMIT_ALL`, worktree promotion, git history | yes | |
| `.huginn/receipts/iter-1.json`, `huginn report` | yes | |
| The agent's answer to each phase prompt | | yes — a canned report per phase, plus the files the iteration adds |

The fake agent is the same seam the runtime-conformance tests use (`RuntimePort`),
so the recording exercises the production code path from the prompt down. It
streams text and reports token usage, which is why the dashboard shows a live
stream and a usage total.

The demo repository is a small `tiny-cart` library (`src/cart.ts`) whose iteration
adds `applyDiscount(total, code)`. It is created under `.work/media/<demo>/` and
reused on every run.

## Regenerating

```sh
bun docs/media/capture.ts            # both demos -> docs/media/build/*.jsonl
python3 docs/media/render_media.py   # -> docs/media/*.gif, *.mp4, *.png

bun docs/media/capture.ts lite       # just one
python3 docs/media/render_media.py lite
```

Requirements: Bun (the project's runtime), Python 3 with Pillow, a monospace font
(the renderer looks for JetBrains Mono first, then DejaVu Sans Mono, Hack and
Liberation Mono). `ffmpeg` is optional: without it the GIF and the PNG are still
written and the MP4 is skipped with a note.

Regenerate after any change to what the dashboard or the headless output looks
like, or after a change to a profile's phases — a demo that no longer matches the
product is worse than no demo. `test/docs/media.test.ts` fails if the README
references a file that is not here, so the two cannot drift apart silently.

## Why these two demos

The audit behind `docs/DECISION-2026-11.md` measured the heavy gates as cost
without measured benefit on small deltas, and `lite` is the answer to that: the
smallest loop that still leaves a receipt. Showing both makes the trade visible
in ten seconds — three phases versus nine, same commit shape, same receipt — which
is the honest version of "pick the methodology the work needs".
