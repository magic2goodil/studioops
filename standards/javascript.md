# JavaScript Standards

## Source

- Write source JavaScript in source files such as `src/js`, `src/app`, or framework-native locations.
- Build and minify production JavaScript through the project build command.
- Do not hand-edit minified JavaScript.

## Modules

- Prefer small modules by responsibility.
- Avoid one giant app file.
- Keep DOM selectors scoped to the component or feature that owns them.
- Avoid duplicated behavior across pages.

## State

- State ownership must be clear.
- Avoid hidden global mutable state.
- Reset or dispose subscriptions, timers, observers, and event listeners when components unmount or views change.

## Network

- Async calls must have loading, success, empty, and error handling.
- Use abortable requests where stale requests are possible.
- Avoid fetching all data upfront unless the interface genuinely needs it.
- Do not silently swallow API errors.

## Performance

- Defer non-critical scripts.
- Avoid expensive DOM work during initial render.
- Avoid repeated layout-triggering reads and writes in tight loops.
- Cache expensive computed results when appropriate.

