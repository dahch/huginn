---
description: Scans the current diff for secrets, tokens, or sensitive data before pushing
agent: security
subtask: true
---

Perform a fast security scan focused on what's about to be pushed.

Files changed:
!`git diff --name-only HEAD`

Full diff of pending changes:
!`git diff HEAD`

Staged changes:
!`git diff --cached`

Focus exclusively on: hardcoded secrets, API keys, tokens, private URLs, credentials, or any value that should be in `.env`. This is a pre-push gate — be fast and decisive. Flag only real findings, no theoretical risks.
