# Interlock follow-up issues

These items were classified ACCEPTABLE-RISK by qa-mgr-raven in
qa-w380-review.md. They are deliberately not fixed in W380 and are accepted
for the current local, same-user coordination threat model. Each item remains
tracked here for a future issue/runbook pass.

1. Ambiguous claim wedge — not fixed, accepted risk. A
   remote_attempted=1 and remote_confirmed=0 contract has no deliberate clear
   path; only hand-editing SQLite can clear it, and validation may reject that
   edit. Refs: src/cli/run.ts:118-122; src/core/lease-store.ts:402-407.

2. Lifecycle lock spans slow Beads calls — PARTIALLY FIXED
   (fix/lifecycle-lock-span). Heartbeat now performs its Beads preflight read
   before acquiring the lifecycle lock and its post-write verification read
   after releasing it, so its locked region covers only local validation, the
   local renewal, and one Beads metadata write. Residual window: the write
   stays locked because a lock-free write could land after a concurrent
   release/reconcile recovered the bead and re-wedge its cleared metadata, and
   claim, complete, release, and reconcile still hold the lock across all
   their Beads calls — claim check-then-act and the durable-intent recovery
   protocols require it. A heartbeat that arrives during another command's
   locked region can still exit 1; retry is safe. Refs: src/cli/run.ts:70-93,
   src/cli/run.ts:183-204.

3. Arbitrary session PID — not fixed, accepted risk. --session-pid accepts any
   live PID, allowing a caller to bind a lease to another process identity.
   Refs: src/cli/run.ts:114; src/core/process-identity.ts:22-28.

4. Plain status opens the writable lease store — not fixed, accepted risk.
   Non-JSON status can initialize SQLite and write WAL state outside the
   lifecycle lock; JSON and --all use the read-only reader. It also uses
   Date.now() instead of the injected clock. Refs: src/cli/run.ts:141-157.

5. Full database validation on every operation — not fixed, accepted risk.
   validatePersistedState scans the complete database for every operation,
   including heartbeats, which creates an O(database-size) scaling ceiling.
   Refs: src/core/lease-store.ts:356-378.

6. Beads metadata sensitivity — not fixed, accepted risk. Metadata carries
   actor, PID, process start time, and leased repository-relative paths. The
   values are low sensitivity under the current same-user model, but agents
   must not place secrets in them. Refs: src/cli/run.ts:117;
   src/contracts/issue.ts.

7. Unbounded coordination state — not fixed, accepted risk. state.json
   retains messages and digests without compaction and rewrites the full file
   on each mutation, increasing the coordination lock window over time. Refs:
   src/coordination/state.ts:29-39; src/coordination/types.ts.

8. Counter reset can reuse IDs — not fixed, accepted risk. normalizeState
   resets corrupted nextMessageId or nextDigestId values to 1, which can
   reuse IDs and silently suppress a new digest during deduplication. Refs:
   src/coordination/state.ts:75-82.

9. Partial digest delivery can duplicate — not fixed, accepted risk. If one
   pane's digest file write fails after another pane succeeds, the persisted
   state may not record the earlier delivery and the next sweep may duplicate
   it. Refs: src/coordination/commands.ts:198-216;
   src/coordination/state.ts:65-72.

10. Done sessions receive future digests — not fixed, accepted risk. A done
    session remains eligible for delivery forever, so future queued messages
    can continue producing digest files for it. Refs:
    src/coordination/commands.ts:198-216.

11. Coordination content is plaintext at rest — not fixed, accepted risk.
    Message text and business values are stored in state.json and digest
    files. This matches the current same-user threat model; agents must not
    paste secrets. Refs: src/coordination/state.ts:29-39;
    src/coordination/state.ts:65-72.

12. Task and message stage transitions are weakly constrained — not fixed,
    accepted risk. Task owners can jump between stages without a transition
    matrix, while claimed and closed message stages are not reachable through
    the CLI. Refs: src/coordination/commands.ts:50-125;
    src/coordination/types.ts.

13. Temporary state files are not fsynced or cleaned — not fixed, accepted
    risk. A crash between temporary write and rename can leave .tmp.<pid>
    litter, and there is no fsync before rename. Refs:
    src/coordination/state.ts:29-36.

14. First-registration squatting — not fixed, accepted risk. Any local
    process can register an unclaimed pane name first and own that identity.
    The planned mitigation is Herdr-boundary token provisioning per the
    commit directive. Source: qa-w380-review.md re-review 2026-08-15.

15. Reap guard admits a stale-but-busy claimer — not fixed, accepted risk.
    lastSeenAt only advances on session set, so a live agent quiet for more
    than 15 minutes is reap-able by any registered operator pane. Tighten
    the guard to done-only or add a session heartbeat. Source:
    qa-w380-review.md re-review 2026-08-15.
