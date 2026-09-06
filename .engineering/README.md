# Engineering checks

Run `npm run quality:fast` after edits.

Run `./scripts/quality-gate --base BASE_SHA --head HEAD_SHA` for a committed change.

Use `--head ''` to include working-tree edits before a commit.

Set `TMPDIR` to an existing approved external directory for local tests.
The adapter check uses `TMPDIR` through the Node temporary-directory API.
CI sets `TMPDIR` to the runner temporary directory.

The full gate runs root tests, adapter tests, the TypeScript compiler, the
governance regression tests, Git whitespace checks, and npm dependency audit.
It also checks file growth and change-contract justifications.
The JSON report records blocking failures.

ESLint enforces classic cyclomatic complexity at 10 for production TypeScript.
Correctness lint also covers tests and verification scripts.
Use Node 22.13 or later for these development checks.
An unconfigured check reports `WARN`.
A warning does not prove that the associated property was checked.
The dead-code check finds unused TypeScript locals and parameters.
It does not prove that every exported API is reachable.
Coverage, mutation, duplication, architecture, and security analysis
still require explicit tool selection.

The scope module contains unchanged scope and contract analysis from the
shared runner.
The command runner owns execution, reporting, exceptions, and dispatch.
Regression tests protect oversized-file and missing-contract failures.

CI retains real Beads setup on both macOS and Linux.
Require the `quality-gate` status in branch protection.
Obtain an independent review before merging a meaningful change.
Local hooks and repository configuration do not establish remote branch
protection or prove that a review occurred.
