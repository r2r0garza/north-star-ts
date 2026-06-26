---
name: git-commit
description: Write clear, conventional git commit messages. Use when the user asks to commit changes, write a commit message, or describe a set of code changes for version control.
metadata:
  category: version-control
---

# Writing a good commit message

Follow the Conventional Commits format so history stays scannable and tooling
(changelogs, semver) can parse it.

## Format

```
<type>(<optional scope>): <short summary>

<optional body — what and why, not how>

<optional footer — breaking changes, issue refs>
```

## Types

- **feat** — a new feature
- **fix** — a bug fix
- **docs** — documentation only
- **refactor** — code change that neither fixes a bug nor adds a feature
- **test** — adding or correcting tests
- **chore** — build process, tooling, dependencies

## Rules

1. Summary line ≤ 72 characters, imperative mood ("add", not "added").
2. Don't end the summary with a period.
3. Separate summary from body with a blank line.
4. Explain *why* in the body when the change isn't self-evident.

## Example

```
feat(auth): add refresh-token rotation

Access tokens were long-lived, widening the blast radius of a leak.
Rotate refresh tokens on every use and revoke the prior token.

Closes #214
```
