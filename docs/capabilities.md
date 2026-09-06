# V1 capability map

This map describes the supported interfaces. It is not a release-test report. CLI and MCP use the same coordination engine. MCP supplies the pane identity from its process environment.

| Capability | CLI | MCP | Boundary |
|---|---|---|---|
| Discover work | `task list` | `task_list` | Local task metadata |
| Inspect or resume | `task inspect`, `task resume` | `task_inspect`, `task_resume` | Read-only; messages restricted to sender/recipient |
| Create work | `task add` | `task_create` | Optional Beads contract; no contract means no lease |
| Correct or withdraw | `task update`, `task withdraw` | `task_update`, `task_withdraw` | Current revision; eligible creator/owner; open unclaimed work only |
| Claim | `task claim` | `task_claim` | Exclusive owner; linked work also obtains exact-path leases |
| Record progress | `task progress`, `task checkpoint`, `task block` | `task_progress`, `task_checkpoint`, `task_block` | Active owner; not acceptance evidence |
| Refresh or release | `task heartbeat`, `task release` | `task_heartbeat`, `task_release` | Exact linked execution; optional contract-ID guard |
| Complete | `task complete` | `task_complete` | Linked work runs captured checks; coordination-only done is a declaration |
| Recover or resolve | `task recover`, `task resolve` | `task_recover`, `task_resolve` | Linked execution; verified death or exact pending intent |
| Read inbox | `inbox`, `inbox summary` | `inbox_list`, `inbox_summary` | Pane token; summary excludes message bodies |
| Handle messages | `send`, `inbox claim`, `inbox close` | `message_send`, `inbox_claim`, `inbox_close` | Task references, reply threads, stable retry IDs |
| Discover pods | `pod list`, `pod show` | `pod_list`, `pod_inspect` | Roster metadata, including member process identities |
| Discover channels | `pod channel list` | `channel_list` | Channel metadata |
| Manage leader channels | `pod channel open`, `pod channel close` | `channel_open`, `channel_close` | Existing leader authorization rules |
| Provision identities | `orchestrator init`, `pod create`, `pod appoint`, `pod close`, `session register`, `pod rebind` | None | Operator or member-specific CLI rules |
| Host integration | `setup`, `doctor` | None | Existing Herdr adapter; setup requires consent |
| Local observation | `dashboard --once`, `status <bead>`, `status --all --json` | Task/inbox projections | Read-only; does not repair pending operations |

The Pi adapter supplies slash commands for resume, inspect, claim, heartbeat, release, and completion. It also handles session startup, lease refresh, and shutdown. Full task creation and messaging remain available through CLI or MCP.

`task recover` is for linked work. Coordination-only `task reap --dead-claimer <pane>` requires that session to be explicitly `done`. Quiet time alone does not permit either recovery path.

MCP lifecycle calls can supply `contract_id` to reject a stale invocation against a different execution. Capture that ID from the claim or inspection result. The server uses its own process identity for claims; callers cannot provide a foreign PID.

Pod members communicate within their pod. Cross-pod messages require an authorized leader channel. Task linkage does not override those routing rules.
