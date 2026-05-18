## Repository Structure

## Testing
As the project is currently in a prototypal state,
testing is on hold for now.

## Documentation Requirements

All public symbols must have JSDoc with:
- Short description
- `@typeParam` for each type parameter
- `@param` for each parameter
- `@returns` for return value
- At least one `@example` with a title and runnable code snippet

Example snippets must be reproducible and use @std/assert assertions. Use ignore directive to skip running a snippet, expect-error for expected failures.

## Error Message Style

- Sentence case, no trailing period
- Active voice: "Cannot parse input x" not "Input x cannot be parsed"
- No contractions: "Cannot" not "Can't"
- Quote string values: `Cannot parse input "hello, world"`
- Use colons for context: `Cannot parse input x: value is empty`
- State current and desired state when possible

Exception: `@std/assert` uses periods in error messages (downstream compat).
