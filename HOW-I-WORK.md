# How I work

> The repository is the appendix to a way of working. This is the text.

## The one-sentence version

I don't ask a model to be right; I make it work under a contract I can audit afterwards — and then I
built the contract, because it did not exist the way I wanted it.

## What I actually do

**The plan is the unit of work, not the prompt.** Before anything gets built I write down what the
iteration is for, how many iterations there are, and what "done" means for each one. A prompt is a
wish; a plan is a schedule. Huginn exists because I wanted the schedule to be enforced instead of
remembered.

**I separate thinking from editing.** A model that is expensive and good at reading is wasted typing
out a mechanical fix loop. So the diagnosis of a blocked gate is one turn, read-only, on a "thinker"
model; applying the remediation is another turn, on an "executor" model, with tools. This is not
sophistication for its own sake: it is the difference between paying a premium model to think and
paying it to shuffle files.

**Every increment has to end in evidence.** Not "the agent said it passed": the base commit, the
resulting commit, the tree hash that was actually verified, the verdict of every phase, and the usage
if the driver can measure it. That is the receipt. I keep it because my own memory is not an audit
trail, and because six months from now I want to re-derive why a commit exists without reading a chat
transcript.

**Gates fail closed, and I mean closed.** A phase that does not produce its machine-readable marker
is `blocked`, not "probably fine". An auditor cannot edit the tree — huginn hashes it before and after
the phase and blocks if it moved. A read-only violation does not get a fix loop: replaying the executor
cannot un-write an auditor, so it fails once with the reason instead of burning sixteen minutes
pretending. I would rather stop and argue with a red gate than discover later that a green one was a
model being polite.

**I keep memory outside the conversation.** The project's decisions, the symbol graph, and a handoff
note live in a database an agent can query through MCP ([Muninn](https://github.com/dahch/muninn)), so
a new session — mine, or a different agent's — starts where the last one stopped instead of re-reading
the repository to reconstruct a decision that was already made.

**I make everything resumable.** An interrupted iteration is parked with its worktree and restarted at
the step it was on. A failed promotion keeps its branch, and `huginn promote --retry` re-attempts the
integration with no model turn, because replaying a deterministic merge is not a job for a language
model. An afternoon that ends in "start over" is an afternoon of evidence thrown away.

**I treat the console as part of the evidence.** A status line that truncates silently, a scroll that
counts source lines instead of terminal rows, a modal that pushes the footer off a 24-row terminal —
these lie about state, and a tool that lies about state cannot be trusted about anything else. That is
why the TUI's visual contract is a test matrix (four terminal sizes, colour and `NO_COLOR`, every
modal) rather than a screenshot I looked at once.

**I audit my own process, not only the code.** The gates in this repository are not a religion: I
benchmarked them. When `VALIDATE_STEP` blocked eleven of sixteen increments and added half the lines
and a third of the time with no measured advantage, the honest response was not to delete the phase
silently or to keep claiming it made things better — it was to make the methodology selectable
(`--profile`) and default nothing away. That is what `lite` is: the smallest loop that still leaves
evidence.

## Why auditability beats speed, for me

I ran the same tasks twice: once with a plain agent prompt, once under the full cycle. The cycle solved
42 of 42 where the plain agent solved 36, and carried 4 of 4 of the spec's latent requirements into
the documents where the plain agent carried none. It also cost five to six times the wall clock and
forty to seventy times the added lines.

Those two halves belong in the same paragraph, always. A tool that tells you only the first half is
selling you something. The 2026-11 decision record states the trade, the evidence behind it, and its
limits — n=1 cells, mutation scores that came out equal or worse, tokens that went unmeasured until
receipts did. You are welcome to read the numbers and decide they are not worth it. What you should
not have to do is guess them.

What I refuse to claim: that this writes better code than a good prompt. It does not, and the bench
says so. What it does is make the process leave evidence, and make the evidence checkable. That is a
narrower claim, it is true, and it is the one I can defend.

## What a session looks like

1. An idea, typed at the console: `huginn "discount codes on a cart total"`.
2. The thinker refines it with me and drafts `spec.md`, `adr.md` and `plan.md`, then proposes the
   lightest methodology that keeps the run honest — which I accept or override, because it is my
   decision and it is recorded either way.
3. I read the diff of those three documents in `git` and approve. This is the cheapest review I will
   ever do on that work, so I actually do it.
4. The cycle runs against the plan. Phases either pass with a parsed verdict or block with a reason.
5. If something blocks: one read-only diagnosis, one executor turn, retried inside a budget, then it
   escalates to me instead of grinding.
6. The increment commits, the receipt is written, and `huginn report` tells me what the engine ran,
   what a model judged, and what neither of them proved.
7. If I walk away mid-iteration, or the promotion fails, nothing is lost: there is a parked worktree,
   a preserved branch, and a command to finish the integration.

The parts I care about most are 4 and 6. Everything else is in service of them.

## What I want from a tool

- It stops when it cannot prove something, and it says what it could not prove.
- It does not install a parallel universe of subagents and slash commands into my agents; it composes
  the instructions itself and hands them over as a prompt, so one install behaves like the source tree.
- It treats my methodology as data, so the cheap path and the thorough path are the same code.
- It keeps my history: state on disk, receipts per iteration, and a memory a different agent can pick
  up tomorrow.
- It tells me the cost, in time, in lines and in tokens, even when the number is embarrassing.

## Who this is for

You, if any of this sounds familiar:

- you already drive at least one agent and you already keep its context somewhere on purpose;
- you would rather spend five times the wall clock and be able to re-derive a decision than ship
  faster and hope the transcript is somewhere;
- you are willing to run plan → execute → audit as a cycle, not a prompt — including the day it is
  slower than doing it yourself;
- you keep a spec, an ADR or a decision log because you know your future self reads them;
- you like the receipt more than the demo.

If you recognized yourself in the sections above, the [README](README.md) is the manual and the
[ADR](ADR.md) is the argument. The five-minute path is real: three phases, your own verification
command, a receipt at the end.

## Who this is not for

- You want faster autocomplete. This is the opposite trade, and it will feel like overhead.
- You believe the model is the bottleneck. Here the bottleneck is the contract, on purpose.
- You want a one-shot prompt with no plan to write and no gate to satisfy. There is no mode for that,
  and I am not going to pretend there is.
- You need a hosted service, a GUI and an account. This is a CLI and a console in your terminal.
- You are looking for a standard the industry will adopt. It is one person's way of working, written
  down and enforced by a program. That is exactly what it is worth and no more.

## What would make me stop using it

Things I would consider a defect bad enough to change the design:

- a receipt that disagrees with the tree it names;
- a gate that passes an iteration nobody built;
- a promotion that silently drops an increment's commits;
- the cost of the cycle growing while the evidence stops improving.

The first three are tests in this repository. The fourth is what `DECISION-2026-11` is for.

## The appendix

- [README.md](README.md) — what it is, what it costs, five minutes to try it.
- [ADR.md](ADR.md) — 76 decisions with the alternatives that were rejected: profiles
  ([ADR-35](ADR.md)), resumption of an interrupted iteration ([ADR-56](ADR.md)), Muninn as the context
  engine ([ADR-58](ADR.md)), deterministic gates and an on-demand judge ([ADR-59](ADR.md)), promotion
  recovery ([ADR-62](ADR.md)) and the console's measured alphabet ([ADR-72](ADR.md), [ADR-76](ADR.md)).
- [DECISION-2026-11.md](docs/DECISION-2026-11.md) — the benchmark, the repositioning on operational
  reliability, and what I decided to freeze.
- [SPEC.md](SPEC.md) · [DESIGN.md](DESIGN.md) — the requirements ledger and the technical design.
- [docs/media/](docs/media/README.md) — the demos, recorded from the real engine.

If you disagree with any of this, open an issue with the ADR number and I will take it seriously: the
argument is the interesting part. If you are building the same thing from a different angle, I want to
read yours.
