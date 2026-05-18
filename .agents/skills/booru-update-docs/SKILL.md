---
name: booru-update-docs
description: >
  CURRENT.md, ARCHITECTURE.md, dump_types: use when generating or refreshing
  the lfs-booru checked-out-state and architecture documentation. Runs the type
  dump script and aborts if uncommitted changes are present.
---

# booru-update-docs

When the user asks to generate or update `CURRENT.md`, `ARCHITECTURE.md`, or the
booru project documentation snapshot, use this skill.

**Important: `CURRENT.md` is a snapshot of the checked-out codebase.** It must
not contain temporal references ("as of last week", "recently added", "the
current version is"), future plans, or historical descriptions. Every section
should describe what exists at the checked-out commit: nothing more, nothing
less.

`ARCHITECTURE.md` explains the system design visible in the checked-out codebase.
It should describe boundaries, invariants, and design rationale without
presenting planned or speculative features as implemented behavior.

## Precondition: Check for uncommitted changes

Before doing anything else, run:

```bash
git status --porcelain
```

If this produces any output, the working tree is not clean. Stop immediately and
report back to the user:

> Cannot update documentation: there are uncommitted changes. Commit or stash
> them first, then retry.

Do not proceed with any further analysis.

## Workflow

Once the working tree is confirmed clean:

### 1. Capture the HEAD hash

```bash
git rev-parse HEAD
```

Save the full hash for the `CURRENT.md` snapshot annotation.

### 2. Run the type dump

Run:

```bash
deno run --allow-all scripts/dump_types.ts
```

Use the output as a required inspection artifact. It defines the visible type and
function surface under `src/`, and should guide repository inspection.

Do not paste the full type dump into `CURRENT.md` or `ARCHITECTURE.md`. Synthesize
meaning from it instead:

- exported modules and public symbols
- important internal types that define runtime state
- handler and storage boundaries
- source-level API shape that differs from prose docs

If the type dump fails, stop and report the failing command and error output.

### 3. Inspect the repository

Read existing `CURRENT.md` and `ARCHITECTURE.md` if present. Inspect the source,
entry points, scripts, configuration, and relevant docs with targeted searches
and file reads.

Use `readme.md`, `DESIGN.md`, `PLANNED.md`, `todo`, or similar files only as
context. Do not represent ideas from those files as implemented behavior unless
the checked-out source and configuration verify them.

If an existing document contains useful structure, preserve it where it still
matches the repository. Remove sections about files, flows, or decisions that do
not exist in the checked-out codebase.

### 4. Generate `CURRENT.md`

Start `CURRENT.md` with:

```markdown
> Snapshot commit: HASH:<full-commit-hash>
```

Replace `<full-commit-hash>` with the hash captured from `git rev-parse HEAD`.

`CURRENT.md` should be a concise checked-out-state map. Scope it to:

- repository purpose
- runtime entry points
- Deno tasks, imports, and relevant configuration
- top-level source structure
- key modules and their responsibilities
- request and data flows
- persistence layout and generated or derived artifacts
- scripts and benchmark utilities that affect development or repository state
- important implementation constraints visible in code

Do not make `CURRENT.md` exhaustive. It should not document every file, repeat
every exported symbol, or paste generated type output. Include a file only when
it helps a reader navigate or understand the checked-out implementation.

Prohibited in `CURRENT.md`:

- temporal references such as "recently", "currently", "as of", "now", or
  "last updated"
- future plans or TODO-style commitments
- historical descriptions of previous designs
- unverified claims from planning docs
- speculation about intended behavior

Acceptable wording examples:

```markdown
Image ingestion is handled by `handleIngest`.
Image metadata is replayed from NDJSON event shards into JSON index files.
The type surface can be inspected with `scripts/dump_types.ts`.
```

### 5. Generate `ARCHITECTURE.md`

`ARCHITECTURE.md` should explain the design of the implemented system rather
than inventory the repository. It should cover:

- system overview
- architectural goals implied by the code
- source-of-truth model
- Git and Git LFS responsibilities
- event log and derived-index model
- HTTP request boundaries
- ingest flow
- image-serving flow
- storage and persistence boundaries
- module boundaries
- invariants and assumptions
- trust, error, and failure boundaries visible in code
- implementation tradeoffs or constraints that affect safe changes

Keep `ARCHITECTURE.md` conceptual and decision-oriented. Prefer prose that helps
future changes stay safe over exhaustive file listings.

Do not turn `ARCHITECTURE.md` into an extension of the type dump. Use the type
dump to verify boundaries and APIs, then explain what those boundaries mean.

Avoid presenting planned ideas as existing architecture. If a planning doc
contains a design that is not implemented, omit it or clearly constrain the
statement to implemented code.

### 6. Write both documents

Write the generated contents to:

- `CURRENT.md`
- `ARCHITECTURE.md`

After writing, read both files back and check for prohibited `CURRENT.md` wording
before reporting success. Search `CURRENT.md` for at least:

```text
\b(recently|currently|now|future|planned|will)\b|as of|last updated|should eventually
```

Revise `CURRENT.md` if any match violates the snapshot rule.

## Separation of concerns

Use these rules to decide where content belongs:

- If removing a sentence makes the repository harder to navigate, it probably
  belongs in `CURRENT.md`.
- If removing a sentence makes the system harder to change safely, it probably
  belongs in `ARCHITECTURE.md`.
- If a sentence merely repeats a function signature, it belongs in the generated
  type dump, not in either handwritten document.
- If a sentence describes a plan or desired future behavior, it does not belong
  in either document unless the user explicitly asks for planning documentation.

## Recommended document shapes

`CURRENT.md` can use this structure when no better existing structure applies:

```markdown
# Codebase Snapshot

## Purpose

## Runtime Entry Points

## Configuration

## Source Structure

## Core Flows

## Persistence

## Scripts and Utilities

## Implementation Constraints
```

`ARCHITECTURE.md` can use this structure when no better existing structure
applies:

```markdown
# Architecture

## System Overview

## Source of Truth

## Component Boundaries

## Data Flow

## Persistence Model

## Invariants

## Failure Boundaries

## Design Tradeoffs
```

## Error handling

- If `git status --porcelain` produces output, stop before analysis.
- If `git rev-parse HEAD` fails, report the error and stop.
- If `deno run --allow-all scripts/dump_types.ts` fails, report the error and
  stop.
- If parsing existing docs fails, report the issue and continue with a full
  regeneration.
- If repository inspection commands fail, report the failing command and use
  alternate targeted searches or file reads.
- If some files cannot be read, report which paths were skipped and proceed with
  the rest of the verified repository findings.

## Final response

After successfully updating the files, summarize:

- the generated or updated files
- the captured snapshot hash used for `CURRENT.md`
- whether `deno run --allow-all scripts/dump_types.ts` succeeded
- any files skipped during inspection

Because this skill file is opencode configuration, tell the user to quit and
restart opencode for the renamed skill to be loaded.
