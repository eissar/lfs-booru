## Project Documentation

For the checked-out codebase map, entry points, runtime configuration, persistence layout, and implementation constraints, see `CURRENT.md`.

For system design, source-of-truth model, component boundaries, invariants, failure boundaries, and tradeoffs, see `ARCHITECTURE.md`.

For code style and design preferences around error handling, fatal preconditions, and TypeScript API shape, see `DESIGN.md`.

## Design Preferences

- Prefer local procedural error handling where recovery, cleanup, retry, fallback, or early-return behavior is known.
- Use thrown exceptions mainly at process boundaries, framework boundaries, CLI entrypoints, RPC boundaries, or truly unrecoverable failures.
- Treat required startup state, repository structure, permissions, runtime compatibility, and integrity checks as fatal preconditions.
- Do not degrade into partial execution when the application cannot safely continue.
- Prefer simple, concrete TypeScript API boundaries.
- Avoid custom error class trees, result wrappers, excessive generics, and effect-system-style abstractions unless they materially improve correctness or encode real invariants.

## Testing
As the project is currently in a prototypal state,
testing is on hold for now.

## Documentation Requirements

All public symbols must have JSDoc with:
- Short description
- `@typeParam` for each type parameter
- `@param` for each parameter
- `@returns` for return value
- `@example` if warranted with a title and runnable code snippet

Example snippets must be reproducible and use @std/assert assertions. Use ignore directive to skip running a snippet, expect-error for expected failures.

## Error Message Style

- Sentence case, no trailing period
- Active voice: "Cannot parse input x" not "Input x cannot be parsed"
- No contractions: "Cannot" not "Can't"
- Quote string values: `Cannot parse input "hello, world"`
- Use colons for context: `Cannot parse input x: value is empty`
- State current and desired state when possible

Exception: `@std/assert` uses periods in error messages (downstream compat).
