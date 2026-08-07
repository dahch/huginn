---
description: Runs a full code review on the current changes before opening a PR
agent: reviewing
subtask: true
---

Review all current changes before submitting a pull request.

Changes to review:
!`git diff main...HEAD --stat`

Full diff:
!`git diff main...HEAD`

Focus on architecture violations, SOLID issues, and anything that should be caught before merge. Be concise — this is a pre-PR sanity check, not a full audit.
