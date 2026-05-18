---
name: booru-update-docs-current
description: >
  Update CURRENT.md so it accurately describes the checked-out codebase at a
  specific commit, with a last-updated hash annotation. Aborts if uncommitted
  changes are present.
---

# booru-update-docs-current

When the user asks to update CURRENT.md, use this skill.

**Important: `CURRENT.md` is a snapshot of the checked-out codebase.** It must
not contain temporal references ("as of last week", "recently added", "the
current version is"), future plans, or historical descriptions. Every section
should describe what exists *right now* at the checked-out commit — nothing
more, nothing less.

## Precondition: Check for uncommitted changes

Before doing anything else, run:

```bash
git status --porcelain
```

If this produces any output (i.e., the working tree is not clean), **stop
immediately** and report back to the user:

> Cannot update CURRENT.md — there are uncommitted changes. Commit or stash
> them first, then retry.

Do not proceed with any further analysis.

## Workflow

Once the working tree is confirmed clean:

### 1. Capture the HEAD hash

```bash
git rev-parse HEAD
```

Save the full hash for the annotation.

### 2. Compare against the existing CURRENT.md hash (if present)

Read `CURRENT.md` (if it exists), extract the hash from the first line, and
compare it to the hash from `git rev-parse HEAD`.

- If hashes match, report that `CURRENT.md` is already up to date and stop
  unless the user explicitly asks for a forced refresh.
- If hashes differ, optionally run:
  ```bash
  git diff <old-hash>..<new-hash>
  ```
  Use the diff as a guide for focused repository inspection, but still ensure
  the final `CURRENT.md` reflects the full checked-out state.

### 3. Update CURRENT.md

Inspect the repository with targeted searches and file reads. Read the existing
`CURRENT.md` if it exists, then synthesize the updated version:

- **Start** with:
  ```markdown
  > Last updated at HASH:<full-commit-hash>
  ```
- Replace `<full-commit-hash>` with the hash captured from `git rev-parse HEAD`.
- Describe the codebase at the captured commit only.
- Do not include temporal references ("recently", "as of", "currently"),
  future plans, or historical descriptions.
- Preserve the existing document's useful structure and section headers, but
  refresh every section with verified findings from the repository.
- Remove sections about things that no longer exist or have changed
  significantly.
- Add sections for notable code, configuration, scripts, tests, or docs that
  are present but not yet documented.
- If `CURRENT.md` doesn't exist, create a fresh document from the repository
  findings.

### 4. Write

Write the result to `CURRENT.md`.

## Error handling

- If `git rev-parse HEAD` fails, report the error and stop.
- If parsing or comparing the existing `CURRENT.md` hash fails, report the
  issue and continue with a full refresh.
- If `git diff <old-hash>..<new-hash>` fails, report the failing command and
  continue with targeted inspection without diff guidance.
- If repository inspection commands fail, report the failing command and use
  alternate targeted searches or file reads.
- If some files cannot be read, report which paths were skipped and proceed
  with the rest of the repository findings.
