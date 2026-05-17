# Design Principles

## Error Handling

> Error classes are often overused in TypeScript, especially when they pretend to create a meaningful typed error system that JavaScript does not actually enforce.

> Do not throw through async business logic unless there is a clear boundary handler.

> Handle failures at the step where recovery, cleanup, retry, fallback, or early-return behavior is actually known.

Prefer local procedural handling:

```ts
const result = await step().catch(err => {
  handleError(err);
  return null;
});

if (result == null) return;
```

This style is preferred because it:

* keeps control flow adjacent to the failing operation
* avoids hidden non-local exits
* makes cleanup and rollback explicit
* reduces artificial exception hierarchies
* avoids pretending runtime failures are statically typed

### Guidelines

* Use thrown exceptions primarily at process boundaries, framework boundaries, CLI entrypoints, RPC boundaries, or truly unrecoverable failures.
* Do not propagate exceptions through multiple async layers merely to reclassify or relabel them.
* Avoid custom error class trees unless they encode behavior that materially affects handling.
* Prefer explicit logging, cleanup, and early-return at the point where failure semantics are understood.
* Prefer straightforward procedural control flow over simulated effect systems.

### Recoverable vs Fatal Failures

Local `.catch()` + sentinel-return patterns are intended only for:

* optional capabilities
* recoverable operations
* user-correctable input
* retryable workflow steps
* non-critical downstream failures

They are **not** intended for required startup state or mandatory capabilities.

Do not coerce fatal initialization or integrity failures into `null`, `false`, or partial degraded execution.

If the application cannot safely continue, terminate immediately with a precise fatal message.

---

# Fatal Preconditions

If a capability is required for correct operation, every precondition for that capability is treated as mandatory and enforced with immediate termination on failure.

## In Practice

* Define required dependencies and state as hard preconditions.
* Validate them at startup or first use.
* On violation, do not silently retry, degrade, or continue in partial state.
* Emit a precise fatal error explaining the violated assumption.
* Stop execution immediately.
* Reserve soft-failure handling only for truly optional capabilities.

Examples of fatal preconditions:

* missing required tools
* invalid repository structure
* corrupted templates
* missing permissions required for correctness
* incompatible runtime versions
* malformed mandatory configuration
* integrity violations

Examples of non-fatal failures:

* optional integrations
* cache misses
* telemetry failures
* best-effort indexing
* optional UI enhancements

## Rule of Thumb

> If the application cannot safely proceed without it, the check must be fail-fast and fatal.

---

# TypeScript API Design

Prefer simple, concrete TypeScript types at API boundaries.

Avoid unions, result wrappers, and unnecessary generics when they primarily add ceremony or simulate a typed effect system that JavaScript does not actually enforce at runtime.

Use abstractions only when they materially improve correctness, readability, or maintainability.

Good reasons to introduce abstraction:

* reducing meaningful duplication
* encoding real invariants
* making invalid states unrepresentable
* improving API clarity
* constraining unsafe operations
* improving composability without obscuring control flow

Bad reasons to introduce abstraction:

* mimicking purely functional effect systems without runtime enforcement
* hiding straightforward procedural flow behind type indirection
* encoding every possible error in types
* excessive generic parameterization
* replacing readable concrete code with abstract frameworks
* forcing callers through wrapper/result boilerplate for ordinary control flow

## API Boundary Preference

Prefer:

```ts
function loadConfig(path: string): Config
```

over:

```ts
function loadConfig<TError extends ErrorLike>(
  path: string
): Result<Config, TError>
```

unless the abstraction materially improves correctness or eliminates important invalid states.

## Rule of Thumb

> If the abstraction makes the call site harder to understand without providing proportional correctness or safety benefits, it is likely unnecessary.

