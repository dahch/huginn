---
description: Analyzes pending changes and creates semantic commits grouped by context
agent: build
subtask: true
---

Analyze all pending changes in this repository and create semantic commits.

Current git status:
!`git status --short`

Full staged and unstaged diff:
!`git diff HEAD`

Untracked files content (if any):
!`git ls-files --others --exclude-standard | head -20`

Recent commit history for context and style reference:
!`git log --oneline -10`

## Instructions

1. **Analyze** all changes holistically before doing anything. Understand what changed and why.

2. **Group** changes into logical, atomic commits. Each commit must represent one coherent unit of work. Do NOT create one commit per file — group by feature, fix, or concern.

3. **For each group**, stage only the relevant files and create a commit using the Conventional Commits specification:
   - `feat(scope):` — new feature or capability
   - `fix(scope):` — bug fix
   - `refactor(scope):` — code restructure without behavior change
   - `chore(scope):` — tooling, dependencies, config, scripts
   - `docs(scope):` — documentation only
   - `test(scope):` — adding or updating tests
   - `perf(scope):` — performance improvement
   - `ci(scope):` — CI/CD pipeline changes
   - `style(scope):` — formatting, missing semicolons (no logic change)
   - `build(scope):` — build system or external dependency changes

4. **Scope** must be specific and reflect the domain/module affected (e.g., `auth`, `user-profile`, `ocr-engine`, `api`, `shared`). Never use generic scopes like `misc` or `update`.

5. **Commit message body** (when needed): add a blank line after the subject, then explain *why* the change was made, not *what* — the diff already shows what.

6. **Breaking changes**: if a change breaks a public contract or API, append `!` after the type/scope and add a `BREAKING CHANGE:` footer.

7. **Order of commits**: from lowest to highest level — dependencies/config first, core domain second, infrastructure third, UI/presentation last.

8. **Do NOT**:
   - Commit unrelated changes together
   - Use vague messages like `fix stuff` or `updates`
   - Commit secrets, `.env` files, or generated artifacts
   - Force-push or amend existing commits
   - Create empty commits

9. After all commits are created, run `git log --oneline -10` and show the final commit list so the user can verify.
