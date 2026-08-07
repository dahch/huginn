---
description: Generates and runs tests for a specific module. Usage: /test-module src/features/auth
agent: qa
subtask: true
---

Run full QA cycle for the module at path: $ARGUMENTS

Analyze the module, write missing tests, run them, and report coverage. Focus on business logic branches and error paths first.
