# Native complexity adoption

The user authorized ESLint and its TypeScript parser on 2026-09-06. These development dependencies provide maintained native control-flow analysis. The standard library and TypeScript compiler do not enforce cyclomatic complexity. A custom analyzer would add maintenance work and weaker semantics. ESLint and typescript-eslint are MIT-licensed upstream projects. They add no production package or runtime dependency. The repository maintainers own updates. Audit the resolved dependency tree before release.

Use ESLint's classic complexity rule with a maximum of 10 for production TypeScript. Apply correctness lint rules to source, tests, and verification scripts. TypeScript continues to enforce types and unused symbols. Source development requires Node 22.13 or later for ESLint 10; the published runtime remains Node 22 or later.

Run the native analyzer before edits. Use the existing 300-test suite and focused public-interface regressions to protect behavior. For each finding, simplify cohesive responsibilities, remove redundant branches, and reuse existing validation. Extract a helper only when its responsibility has a useful independent name. Preserve error handling, order, authorization, and mutation boundaries. Do not add exceptions, suppressions, or replace branching with obscure expressions. Keep each assignment inside its existing module boundary.

Run focused regressions and the fast gate after each assignment. Inspect the combined diff independently. Run the full gate and repeat packed dogfood after the code changes.
