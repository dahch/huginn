---
description: Runs a full automated validation gate on a module or bounded context before human approval. Chains qa → spec-auditor → security and produces a consolidated traffic-light report. Usage: /validate-step src/contexts/notifications SPECS.md
agent: reviewing
subtask: true
---

Run a full validation gate for the implementation at path: $ARGUMENTS

## How to parse arguments

$ARGUMENTS will be provided in one of these forms:
- `<module-path>` — run against the module, locate the spec automatically
- `<module-path> <spec-file>` — run against the module using the given spec file
- `<module-path> <spec-file> <git-range>` — scope the diff to the given git range (e.g. `main..HEAD`)

If no spec file is provided, search for a SPEC.md, spec.md, SPECS.md, or *.spec.md file in the module path or project root. If none is found, note it in the report and skip the spec-auditor phase.

## Execution sequence

Run the following three subtasks in order. Do NOT skip any phase. Do NOT proceed to the next phase if the current one fails to produce output — report the failure instead.

### Phase 1 — QA (agent: qa) — AUDIT ONLY MODE

Delegate to the `qa` subagent with explicit audit-only instructions:

```
AUDIT-ONLY MODE — do NOT write, create, or modify any test files.

Run QA audit for the module at path: <module-path>

1. Execute existing tests only in non-interactive mode (e.g. vitest run, bun test, jest --ci --watchAll=false).
2. Parse coverage report.
3. Identify untested critical paths and business logic branches.
4. Report findings but do NOT generate new tests.

If coverage is below threshold, mark as 🔴 and list the specific uncovered paths. Do not attempt to fix them.
```

### Phase 2 — Spec Audit (agent: spec-auditor)

Delegate to the `spec-auditor` subagent:

```
Audit semantic alignment between:
- Spec: <spec-file or "not provided">
- Implementation: <module-path> (exclude *.test.ts, *.spec.ts, __tests__ directories from scan)
- Git range: <git-range or "full module">

Produce the full Spec Audit Report as defined in your instructions.
```

### Phase 3 — Security (agent: security)

Delegate to the `security` subagent with a scoped diff that excludes test files:

```
Run security audit for the module at path: <module-path>

IMPORTANT — scope restriction:
- If a git range was provided, audit only: git diff <git-range> -- <module-path> ':!*.test.ts' ':!*.spec.ts' ':!**/__tests__/**' ':!**/*.test.java' ':!**/*Test.java'
- If no git range, audit source files only — explicitly exclude all test files matching: *.test.ts, *.spec.ts, __tests__/, *.test.java, *Test.java, *Spec.java, src/test/

Reason: test files contain mock credentials and fixture strings that produce false positives.

Produce the full Security Audit Report as defined in your instructions.
```

## Consolidation

After all three phases complete, produce the following consolidated report:

```
## Validation Gate Report
**Module:** <path>
**Spec:** <file or "not provided">
**Date:** <current date>

---

### Phase results

| Phase        | Status   | Key finding |
|--------------|----------|-------------|
| QA           | 🟢/🟡/🔴 | [one-line summary] |
| Spec Audit   | 🟢/🟡/🔴 | [one-line summary] |
| Security     | 🟢/🟡/🔴 | [one-line summary] |

---

### Cross-phase contradictions ⚡
Analyze the three reports for semantic contradictions between phases. List each one explicitly.
A contradiction exists when two phases give conflicting signals about the same artifact.

Examples to detect:
- Spec-auditor flags a missing port, but QA shows a passing test that mocks that port → the test may be testing the wrong contract, or the spec is outdated
- Security flags a pattern as a hardcoded credential, but it appears in a test fixture path that was not excluded → false positive, note it
- QA reports full coverage on a use case, but spec-auditor marks that use case as an unauthorized Addition → coverage is validating unplanned behavior

Format:
**[CONTRA-001]** Spec-auditor says X. QA says Y. → Human decision required: [specific question to resolve]

If no contradictions found: "No cross-phase contradictions detected."

---

### Overall gate: 🟢 PASS / 🟡 PASS WITH WARNINGS / 🔴 BLOCKED

**Verdict:**
[2-3 sentences explaining the overall result and what action is required]

---

### Required actions before proceeding
[Only populate if gate is 🟡 or 🔴. Numbered list of specific fixes required.]

1. [Specific action — phase that flagged it — severity]
2. ...

### Optional improvements
[Items flagged as minor or suggestions across all phases — not blocking]

---

### Reconciliation prompt (only if 🛑 BLOCKED due to spec deviation)
If the gate is BLOCKED due to a MAJOR DEVIATION finding from spec-auditor, generate a ready-to-use prompt for the architect:

---
RECONCILIATION CONTEXT FOR ARCHITECT

The following deviations were found between spec and implementation.
For each one, a decision is required before the pipeline can continue.

[List each deviation with: what the spec says, what the implementation does, and the specific question to resolve]

Recommended action: paste this block into your Claude architecture session and decide for each item whether to (A) update the spec to accept the deviation, or (B) instruct the executor to revert to the spec.
---

---

### Phase details
[Paste the full output of each phase below, separated by headers]

#### QA Report
<full qa output>

#### Spec Audit Report
<full spec-auditor output>

#### Security Report
<full security output>
```

## Gate logic

Apply the following rules to determine the overall gate status:

- 🔴 BLOCKED: any phase has a 🔴 finding, OR spec-auditor returns MAJOR DEVIATION, OR security has a Critical or High severity finding
- 🟡 PASS WITH WARNINGS: no 🔴 findings, but any phase has 🟡 findings, OR spec-auditor returns MINOR DRIFT, OR security has Medium severity findings
- 🟢 PASS: all phases green, spec-auditor returns ALIGNED, no security findings above Low

## Human handoff

End the report with exactly one of these lines, nothing else after it:

- `✅ AUTO-APPROVED — no action required, continuing to next step.`
- `⚠️ REVIEW REQUESTED — address the items above before continuing.`
- `🛑 BLOCKED — do not proceed until issues are resolved and /validate-step is re-run.`
