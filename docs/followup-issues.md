# Interlock follow-up issues

These items were classified ACCEPTABLE-RISK by qa-mgr-raven in
qa-w380-review.md. They are deliberately not fixed in W380 and are accepted
for the current local, same-user coordination threat model. Each item remains
tracked here for a future issue/runbook pass.

1. Ambiguous claim wedge — FIXED on branch fix/claim-resolve. The new
   operator command `interlock resolve <bead-id>` inspects the wedged
   remote_attempted=1 and remote_confirmed=0 contract and checks the actual
   Beads state: if the claim did not land it clears the attempted contract so
   the bead can be claimed again, and if the claim landed it confirms the
   contract into the normal confirmed state. It fails closed with the exact
   manual `bd show` step when the remote state is unverifiable or unexpected.
   Refs: src/cli/run.ts:118-122; src/core/lease-store.ts:402-407.

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

3. Arbitrary session PID — FIXED 2026-08-18 on branch fix/session-pid-ancestry.
   --session-pid accepted any live PID, allowing a caller to bind a lease to
   another process identity. Resolution: claim now resolves the session
   through sessionProcessIdentityFor, which walks the caller's parent chain
   (ps on Darwin, /proc on Linux) and rejects any PID that is not the calling
   process or one of its ancestors; PID 1 and non-positive PIDs are always
   rejected. Refs: src/cli/run.ts:114; src/core/process-identity.ts:30-92.

4. Plain status opens the writable lease store — FIXED 2026-08-18 on branch
   fix/p3-batch (commit 58b06f7, il-ke1). Plain status now reads leases through
   the read-only LeaseReader like the --json and --all paths, and computes
   lease health from the injected dependencies.clock instead of Date.now().
   Refs: src/cli/run.ts:141-157.

5. Full database validation on every operation — not fixed, accepted risk.
   validatePersistedState scans the complete database for every operation,
   including heartbeats, which creates an O(database-size) scaling ceiling.
   Refs: src/core/lease-store.ts:356-378.

6. Beads metadata sensitivity — not fixed, accepted risk. Metadata carries
   actor, PID, process start time, and leased repository-relative paths. The
   values are low sensitivity under the current same-user model, but agents
   must not place secrets in them. Refs: src/cli/run.ts:117;
   src/contracts/issue.ts.

7. Unbounded coordination state — FIXED (growth half) on fix/state-compaction.
   `interlock compact` removes terminal messages (handled/closed) and digests
   that no longer cover a retained message, along with their delivery files.
   nextMessageId/nextDigestId are never lowered, so the persisted counters stay
   the id high-water mark and dedupe cannot be defeated by deletion. The
   full-file-rewrite per mutation (the other half of this item) is unchanged
   and remains accepted risk. Refs: src/coordination/commands.ts;
   src/coordination/state.ts:29-39; src/coordination/types.ts.

8. Counter reset can reuse IDs — FIXED on branch fix/id-counter-floor.
   normalizeState used to reset corrupted nextMessageId or nextDigestId
   values to 1, which could reuse IDs and silently suppress a new digest
   during deduplication. normalizeState now derives a missing, corrupted,
   or too-low counter as max(existing ids of that kind) + 1, preserves a
   healthy counter above that floor, and refuses loudly when an existing
   message or digest id is itself corrupt. Refs:
   src/coordination/state.ts:73-85.

9. Partial digest delivery can duplicate — not fixed, accepted risk. If one
   pane's digest file write fails after another pane succeeds, the persisted
   state may not record the earlier delivery and the next sweep may duplicate
   it. Refs: src/coordination/commands.ts:198-216;
   src/coordination/state.ts:65-72.

10. Done sessions receive future digests — FIXED 2026-08-18 on branch
    fix/p3-batch (commit ce109e4, il-7uz). deliverDigests now only considers
    idle sessions eligible, so a done session produces no new digest on later
    sweeps; idle and busy behavior is unchanged. Refs:
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

13. Temporary state files are not fsynced or cleaned — FIXED 2026-08-18 on
    branch fix/p3-batch (commit 4044a1f, il-5fa). writeCoordinationState now
    fsyncs the temporary file before rename and removes stale state.json.tmp.*
    files in the state directory on every write. Refs:
    src/coordination/state.ts:29-36.

14. First-registration squatting — not fixed, accepted risk. Any local
    process can register an unclaimed pane name first and own that identity.
    The planned mitigation is Herdr-boundary token provisioning per the
    commit directive. Source: qa-w380-review.md re-review 2026-08-15.

15. Reap guard admits a stale-but-busy claimer — FIXED on branch
    fix/reap-guard. Reap now requires the claimer session state to be done;
    staleness is never a death input, because lastSeenAt only advances on
    session set and a live agent quiet for more than 15 minutes was reap-able
    by any registered operator pane. Verified-death via process identity was
    not wired: coordination sessions carry no process identity and each CLI
    invocation is a short-lived process, so no durable pane pid exists to
    inspect. Consequence: a crashed agent that never set done can no longer
    be reaped; a session heartbeat or pane process registration is the
    follow-up if that wedges work. Source: qa-w380-review.md re-review
    2026-08-15.
