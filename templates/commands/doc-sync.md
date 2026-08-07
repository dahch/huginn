---
description: Detects outdated documentation and syncs it with the current state of the code
agent: doc-writer
subtask: true
---

Synchronize all documentation with the current codebase state.

Recent changes that may have made docs stale:
!`git log --oneline -20`

Files modified in the last sprint:
!`git diff --name-only HEAD~10`

Check README.md, SPEC.md, DESIGN.md, ADR.md, and AGENTS.md for accuracy. Update only what's stale — don't rewrite docs that are still valid.
