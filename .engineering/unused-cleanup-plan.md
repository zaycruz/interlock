# Unused binding cleanup

The TypeScript compiler reports ten unused bindings with `--noUnusedLocals`
and `--noUnusedParameters`.

1. Remove unused type imports.
2. Remove unused local bindings.
3. Keep the initializer call when it can have a side effect.
4. Remove the unused private test-helper argument after checking its callers.
5. Run the affected existing tests.
6. Add the native TypeScript unused checks to the engineering profile.
7. Run the fast gate.

Existing CLI and coordination tests protect behavior.
This change does not need a new test file.
Do not suppress compiler diagnostics.
