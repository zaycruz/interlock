# V1 operation and limits

Interlock serves developers who run cooperating local agents in Git worktrees. Its product promise is a complete execution handoff: useful work, exclusive scope, relevant discussion, a recoverable checkpoint, and an observed verification result.

## Authority and acceptance

Beads owns linked issue title, value, work, and acceptance. Coordination stores the canonical issue reference and execution context. SQLite stores exact-path leases. A coordination-only task does not claim files or modify a Beads issue.

The canonical link uses the Git common directory and Beads ID. Separate worktrees share this repository identity. The execution captures a specific worktree, process identity, contract ID, paths, acceptance, and checks.

Acceptance checks use executable argument arrays. They run in the captured worktree. The default timeout is 30 seconds per check; the maximum configured timeout is 300 seconds. Each nonempty acceptance line must have one check. Remove its bullet marker when setting `criterion`.

The completion caller supplies a result summary and artifact references. Interlock labels them `agent-declared`. The engine records command outcomes as `interlock-executed`. Artifact references are not uploaded or independently reviewed. Passing an inadequate command does not prove a useful result. Choose checks that test the stated behavior.

Use `task checkpoint` to record a finding and the next action. Use `task block` to record the dependency that prevents progress. Use `task resume` to retrieve the execution and authorized discussion. These operations do not establish acceptance.

## Failure recovery

| Observation | Action | Required outcome |
|---|---|---|
| Another task owns a path | Inspect the owner and coordinate | Do not change undeclared or conflicting paths |
| You must stop active work | Save a checkpoint; call `task release <id> --reason <reason>` | Linked lease released and Beads issue reopened |
| Claim, completion, or release reports a pending operation | Inspect the task; call `task resolve <id>` | Exact intent converges or the diagnostic remains explicit |
| Worker process is verified dead | Call `task recover <id>` | Recover its exact linked execution; retain context |
| Worker is quiet or process identity is uncertain | Keep ownership reserved | No time-only reclamation |
| Acceptance changed or staged paths exceed scope | Correct the issue/scope through an eligible lifecycle | Completion remains blocked |
| A send response was lost | Retry with the same request ID and identical payload | One logical message |
| A coordination-only owner is done | Another pane calls `task reap <id> --dead-claimer <pane>` | Only eligible nonterminal work reopens |

Add `--pane <pane>` to coordination commands. Supply the token through `INTERLOCK_PANE_TOKEN`. Use `--contract-id <id>` on linked lifecycle operations when an invocation must target one captured execution. Inspect and status are read-only. They do not repair ownership.

Never delete a lock, lease database, or coordination record to clear a conflict. A Beads write can succeed before its response is lost. Follow the reported exact-contract recovery path.

## Upgrade and retention

Current coordination writes use state version 3. Version-2 state is accepted and normalized by the current engine. Existing unlinked tasks remain coordination-only. Version-1 state requires the explicit operator migration shown by the CLI diagnostic.

Older engines that support only version 2 refuse version-3 state. Do not edit the version field to force a downgrade. Stop writers and back up the coordination directory and Git-common Interlock lease data before an upgrade. A backup restored to an older point also loses later changes; it is not a live rollback mechanism.

Task-linked threads and request-key threads are retained through compaction to preserve context and retries. They can grow indefinitely. Inbox summary output is bounded, but the file-backed engine still loads local state. V1 does not provide a retention service or a large-deployment performance guarantee.

## Host setup

Use one MCP server process per pane. Inject its matching token and the shared state path. The server exposes worker tools without accepting a different pane or PID from a tool caller. Registration, pod provisioning, and host installation remain separate operations.

The Pi extension uses the host's session-start and shutdown lifecycle. It binds claims to the Pi process and refreshes active linked work. Reload stops and restarts extension resources without releasing the task. Departure releases the exact active execution. SIGKILL cannot run shutdown cleanup; use verified-death recovery. The installed host inspected during development was Pi 0.84.4. OMP compatibility requires separate evidence.

Pi context is queued for the next model turn without triggering inference. A successful lifecycle smoke does not prove that a model consumed that context.

`interlock setup`, `setup --remove`, and `doctor` operate the existing Herdr integration. Setup displays the planned host changes and requests consent. Use `--yes` only when automation already has that consent. Doctor is read-only. A successful adapter test does not prove a live host installation.

## Trust and scope limits

- Interlock coordinates same-user local processes. Anyone who can directly change its files can bypass its rules. Pane tokens do not create operating-system isolation.
- State and digests contain plaintext task and message content. Keep secrets in 1Password. Inject tokens into process environments.
- Exact Git paths use portable separators, Unicode normalization, and deterministic case folding. Globs are unsupported. Symlink and hard-link aliases are not physical-file locks.
- Lease checks constrain declared ownership and staged completion paths. They do not intercept every filesystem write.
- Task metadata is locally discoverable. Resume filters messages to the requesting sender or recipient. It does not make all local files private.
- First standalone registration binds an unused pane name. Provision expected identities before agents start.
- Verification commands run with the local user's authority. This is not a sandbox or a hostile-code runner.
- No hosted transport, multi-machine state, general scheduler, or replacement tracker is included.

## Release evidence

The release owner must record packed installation, three real disposable-repository smokes, two-worktree contention, MCP-only execution, host lifecycle behavior, crash/retry dogfood, and the full engineering gate. The combined scenario must preserve one owner, avoid duplicate effects, and complete each acceptance check without human context transfer. Record measured recovery duration and any unverified integration.

These instructions and capability descriptions are not proof that those release checks passed. Use the actual release evidence and quality report when deciding whether to deploy a build.
