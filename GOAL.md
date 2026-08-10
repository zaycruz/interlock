# Interlock V1 goal

## Outcome

Build a local coordination product for one Pi agent session in one Git repository.

The agent claims one Beads issue and exact source paths.

Interlock holds the claim until the agent completes it or the agent session is verified dead.

## V1 scope

- Provide a local `interlock` CLI.
- Store exact-path leases in a local SQLite database under the Git common directory.
- Claim a Beads issue after Interlock obtains all requested path leases.
- Save the session, path scope, and lease state in Beads metadata.
- Render a one-screen work contract from the Beads issue.
- Require `Value:`, `Work:`, and acceptance criteria.
- Derive upstream and downstream dependency context from Beads at render time.
- Support heartbeat, completion, explicit release, and stale-session reconciliation.
- On verified session death, release leases, reopen the Beads issue, and clear its assignee.
- Verify staged changed paths before completion.
- Provide a Pi extension that binds a Pi session and calls the CLI lifecycle.

## V1 non-goals

- No Herdr delivery or cross-session routing.
- No hosted service or multi-machine lease store.
- No file globs. Use exact paths only.
- No replacement issue tracker.
- No hard operating-system isolation.

## V2 boundary

V2 uses Herdr to send Beads-backed notices to direct dependencies, dependents, exact-path conflicts, and explicitly named agents.

## Verification

- Unit tests prove lease acquisition, collision rejection, release, heartbeat, and stale-session recovery.
- Unit tests prove contract rendering includes value, work, exact paths, upstream dependencies, downstream dependencies, and acceptance criteria.
- CLI smoke tests run in at least three disposable Git repositories.
- A safe smoke test runs in Atlas Terminal without changing tracked application files.
- A two-worktree test proves that an exact-path collision is rejected.
- The complete test suite and lint/type checks pass.

## Target repositories for smoke testing

1. Controlled disposable repositories created by the smoke harness.
2. `/Users/master/projects/atlas-terminal`, if its tracked tree is clean at test time.
3. `/Users/master/projects/spark-stats-bar` is excluded until its existing tracked changes are resolved.
4. `cocker_mcp` is not present under `/Users/master`; do not guess its location.
