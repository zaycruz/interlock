# Interlock V1 goal

## Outcome

An agent discovers useful work, claims its exact scope, coordinates with other agents, survives interruption, and delivers a verified result without a human transferring context between agents.

The initial user runs multiple local coding agents in Git worktrees under one operating-system user. Beads remains the issue authority. Interlock provides execution ownership, exact-path leases, task context, and quiet communication.

## Product contract

- Provide local CLI and MCP worker operations for discovery, creation, inspection, correction, withdrawal, claim, checkpoint, blocking, release, completion, recovery, and resume.
- Identify a linked coding task by Git common directory and Beads ID. Keep its execution worktree separate. Reject duplicate canonical links.
- Obtain all exact repository-relative path leases before claiming the Beads issue. Store lease state in SQLite under the Git common directory.
- Require Beads `Value:`, `Work:`, and acceptance criteria. Render the work contract with paths and upstream/downstream dependency context.
- Capture acceptance and verification commands at claim. Run those commands with bounded timeouts before completion. Record observed outcomes separately from agent declarations.
- Preserve durable operation intents across ambiguous Beads or local-store failures. Resolve only the exact contract. Prevent legacy operations and raw task stages from bypassing linked lifecycle checks.
- Recover only a verified-dead execution. Protect live, quiet, unknown, and ambiguous identities. Preserve checkpoints and execution history.
- Link communication to task IDs. Deduplicate identical sender/request retries. Preserve authorized discussion and retry receipts during compaction.
- Retain coordination-only tasks without granting leases or claiming verified acceptance.
- Keep operator provisioning outside worker authority. Provide pod discovery and authorized leader channels.
- Provide a Pi extension that binds the host session to the CLI lifecycle. Preserve ownership across reload. Do not treat idle as completion.
- Keep the existing Herdr adapter compatible with the shared coordination engine.
- Preserve existing state on supported upgrades. Refuse unsafe version downgrades.

## Non-goals and boundaries

- No hosted service, multi-machine lease store, or replacement issue tracker.
- No model scheduler, graphical product, or new runtime dependency for V1 delivery.
- No path globs or hard operating-system isolation.
- No security claim between same-user agents with direct filesystem access.
- No new Herdr feature scope. Verify the existing adapter boundary.
- No smoke-target application edits.

## Completion evidence

- Focused public-interface tests prove ownership, collision rejection, retries, acceptance verification, state upgrade, and recovery failure cases.
- CLI smoke tests pass in at least three disposable Git repositories with real Beads and SQLite.
- Two Git worktrees contend for one exact path and produce one valid owner.
- Packed CLI/MCP clients complete a combined two-agent scenario across restart, crash recovery, and a lost-response retry. Record zero human context transfers, zero duplicate effects, and evidence for each acceptance item. Measure recovery duration.
- The packed artifact exposes CLI, MCP, and the Pi adapter. Verify actual host lifecycle behavior separately from unit tests.
- A safe Atlas Terminal smoke runs only when its tracked tree is initially clean. Tracked application files remain unchanged.
- Root and adapter tests, type checks, and the full engineering gate pass. Record independent review and resolve required findings.
- Documentation and release evidence distinguish implemented behavior, observed verification, and remaining limits. Package creation or green unit tests alone do not establish release completion.

## Smoke targets

Use controlled disposable repositories first. Use `/Users/master/projects/atlas-terminal` only if its tracked tree is clean. Exclude `/Users/master/projects/spark-stats-bar` until its existing tracked changes are resolved. Do not guess a location for `cocker_mcp`.

The detailed delivery plan and test specification are in `.omx/plans/prd-gtm-v1.md` and `.omx/plans/test-spec-gtm-v1.md`.
