# ADR-0004: Live interactive dashboard UI

- Status: Draft for QA architecture review and head-office ratification
- Date: 2026-08-20
- Deciders: interlock team, QA architecture, head office
- Product direction: head-office #1017; CEO direction #931
- Existing surfaces: `interlock dashboard --once`, the coordination state
  reader, and the read-only lease reader

## Context

Interlock has a read-only dashboard snapshot. `interlock dashboard --once`
renders watcher health, task state, sessions, message counts, and digest
deliveries. It does not update while it is open. It does not let an operator
select a record, filter a list, or inspect a relationship.

The v0.0.5 product needs a real interactive live/watch dashboard. It must let
an operator inspect sessions, pods, channels, leases, tasks, and inbox digests
in one local surface. A terminal-first UI is acceptable. A static screen that
the operator reruns is not sufficient.

The current data has two local authorities:

- Coordination state is a lock-protected JSON file. It contains sessions,
  pods, members, leader channels, tasks, messages, awareness events, and
  digest deliveries.
- Lease state is a read-only SQLite database in the repository's Git common
  directory. It contains active work contracts and their exact leased paths.

These stores do not share a transaction. The UI must not imply that one visual
frame is an atomic snapshot of both stores.

The threat model remains local and same-user. The UI must not weaken ADR-0003
routing, roster, token, or awareness-content boundaries. In particular, an
operator view of awareness remains metadata-only. The UI must not become an
unauthenticated control plane by accident.

## Decision

### D1. Ship a terminal-first Ink UI in v0.0.5

Ship an Ink-based terminal UI behind a new explicit command:

```text
interlock dashboard --watch [--repository <path>] [--refresh-ms <ms>]
```

`interlock dashboard --once` remains unchanged. It remains the one-shot,
plain-text and JSON-compatible surface for scripts, CI, and non-TTY callers.
The new `--watch` mode requires an interactive TTY. It fails with a clear
instruction to use `--once` when no TTY is available.

Ink supplies a persistent screen, keyboard input, and testable component
boundaries while keeping the product local and terminal-first. The build slice
must select a maintained ESM-compatible Ink release and record its version in
the lockfile. It must not add a web server in this release.

The UI is interactive in navigation, filtering, drill-down, refresh control,
and copyable command guidance. It is read-only in v0.0.5. Existing CLI commands
remain the only mutation path. The UI does not collect, persist, or forward
member or orchestrator tokens.

### D2. Present six linked views and a persistent health bar

The watch UI has a persistent health bar and six selectable views.

| View | Required content | Interactions |
| --- | --- | --- |
| Sessions | member or pane name, state, last seen, owning pod when known | filter by state; select for details |
| Pods | pod status, current leader, roster, succession, terminal markers | select a pod; expand members; show leaderless or done-leader warnings |
| Channels | endpoints, topic, open or closed state, message count | filter by pod or state; select endpoints |
| Leases | work contract, Beads issue, actor, heartbeat, exact paths, remote state | filter by health; expand exact paths |
| Tasks | stage, owner, value, title, blocker, stale marker | filter by stage or owner; select task |
| Inbox digests | recipient, reason, message IDs, timestamp, delivery file status | filter by recipient or reason; select digest metadata |

The health bar shows the last successful coordination read, the last successful
lease read, refresh state, selected repository, and any current read error. It
must label a retained view as stale after a failed refresh. It must not erase a
last known-good view when the next refresh fails.

The default screen opens on a concise overview. The overview has counts and
attention markers for each view. It must not show message text. A detail view
can show only fields already legal for that view. In particular, the channel
and awareness surfaces show metadata, not channel message content. The digest
view shows digest metadata and message IDs, not message bodies.

### D3. Use a read-only snapshot provider and polling watch loop

The implementation introduces a dashboard snapshot provider. It reads through
the existing public read interfaces. It does not parse state files in the UI
components.

```text
coordination state.json --atomic write--> coordination snapshot reader --+
                                                                    |
lease SQLite database --read-only query--> lease snapshot reader ---+--> immutable DashboardSnapshot --> Ink render
                                                                                                      ^
keyboard input --> local UiState (view, selection, filters, pause) --+
```

Each refresh performs these steps in order:

1. Read and validate coordination state through the existing reader.
2. Build the coordination portion from the validated state.
3. Open a read-only lease reader for the selected repository when a lease
   database exists.
4. Build the lease portion from validated lease records.
5. Stamp each source with its own observation time.
6. Replace the displayed snapshot only after both requested reads succeed.

The UI polls. It does not depend on filesystem watch events because Interlock
persists state through atomic rename and a filesystem watch can drop, merge, or
misorder notifications. The default refresh interval is one second. The UI
must clamp a caller-supplied interval to a documented safe minimum. A refresh
key requests an immediate read. A pause key stops polling and labels the frame
as paused.

The provider returns a partial result when the lease database is absent. This
is normal for a repository with no leases. It returns an explicit error state
when a present store cannot be read or validates as corrupt. The UI keeps the
prior complete snapshot, shows the source-specific error, and retries at the
next interval. It does not create a state directory or lease database while it
reads.

The provider records `coordinationObservedAt` and `leasesObservedAt` separately.
The UI displays both values. It never describes the combined view as
transactionally consistent.

### D4. Preserve authority boundaries

The v0.0.5 UI has no write actions. It may display a copyable CLI command that
an operator can run separately. It must not execute that command.

This restriction preserves the current authority model:

- `withCoordinationLock` remains the sole coordination mutation boundary.
- Existing token checks remain the sole member and orchestrator authorization
  boundary.
- The lease reader remains query-only.
- Host adapters remain responsible for host-specific presentation and token
  provisioning.

Later write actions need a separate ADR. That ADR must define confirmation,
token handling, audit records, error recovery, and the exact command-level
authorization boundary before implementation starts.

### D5. Define deterministic degraded states

The UI must distinguish these states:

- **No coordination state:** show an empty deployment and the exact
  initialization command. Do not create state.
- **No lease database:** show an empty leases view. Mark it as not yet created,
  not failed.
- **Unreadable or invalid source:** retain the previous good data, mark the
  source stale, and show the exact reader error.
- **Non-TTY caller:** refuse `--watch` without changing state. Offer
  `interlock dashboard --once`.
- **Slow refresh:** do not overlap reads. Finish or time out one refresh before
  starting the next. Show the age of the last successful result.
- **Process interrupt:** restore terminal state and exit without writing data.

## State-flow implications

The current `DashboardView` is a coordination-only, one-shot projection. The
v0.0.5 provider will need a new immutable view model. It should compose:

- current `DashboardView` data;
- pod records, roster members, and leader channels;
- digest delivery metadata;
- read-only lease records and their repository identity; and
- source observation and error metadata.

The provider must not expose token hashes, plaintext tokens, or message text.
It must copy mutable arrays and records before the Ink layer receives them.
This prevents a future interactive component from changing an object that a
reader owns.

Polling reads state outside the coordination lock. This is safe because the
writer uses atomic replacement and the reader validates the complete file. It
does not make coordination and lease reads atomic with one another. Separate
observation times make this honest to the operator and give QA a visible
assertion target.

Lease health uses the existing heartbeat semantics. The UI renders an expired
lease as an observed condition. It does not reap, release, or reconcile it.
Task stale markers retain the existing dashboard threshold until a separate
product decision changes that threshold.

## Alternatives considered

### Keep extending `dashboard --once`

Rejected. Repeated static output is not interactive. It gives no selection,
filtering, relationship drill-down, or persistent refresh state. Shell loops
also interleave frames badly when an operator needs to compare a pod, a lease,
and an inbox digest.

### Blessed-style TUI

Rejected for the first implementation. A Blessed-style API can build a
terminal UI, but its imperative screen mutation model would make state updates,
selection state, and renderer tests more manual in this TypeScript ESM codebase.
Ink gives the same terminal-first deployment with a declarative render tree and
component-level test seams. This is a framework choice, not a license to add a
browser dependency.

### Local web dashboard

Rejected for v0.0.5. A web UI improves dense tables and future write controls,
but it adds a server lifecycle, port and bind policy, browser launch behavior,
origin controls, and an additional remote-access threat surface. Those concerns
are disproportionate for the first interactive local operator view. Revisit
after a read-only TUI proves the view model and operator workflows.

### A web dashboard that reads state files directly

Rejected. It would duplicate the engine validation path and tempt the browser
layer to access host state or token files. The snapshot provider must be the
only UI data boundary regardless of a later renderer choice.

### Put mutations in the first UI release

Rejected. A button or key binding that invokes topology, task, or message
commands would need token collection, consent, confirmation, audit, and
recovery design. It would turn an observability release into a control-plane
release and bypass the existing explicit CLI authority model.

## Security considerations

- The UI reads only through validated coordination and lease readers.
- The UI does not display token hashes, plaintext tokens, or message bodies.
- The awareness and channel views remain metadata-only.
- The UI does not bind a network port, start a server, or open a browser.
- A corrupt source produces an error state. The UI does not repair it.
- A stale view is visibly stale. The UI does not claim it is current.
- Terminal cleanup runs on normal exit, error, and interrupt so the caller
  regains a usable shell.

## QA architecture review questions

QA must confirm these properties before implementation approval:

1. The snapshot provider cannot write coordination state, lease state, digest
   files, or host configuration.
2. A frame labels coordination and lease observation times separately.
3. A failed refresh retains the last good frame and exposes the exact failing
   source.
4. The UI cannot display channel message content through overview, channel,
   awareness, or digest views.
5. Keyboard actions mutate only local UI state in v0.0.5.
6. `--once` behavior remains compatible for scripts and non-TTY callers.
7. The watch loop never overlaps refreshes and always restores terminal state.

## Acceptance criteria for the implementation plan

- A TTY smoke test proves navigation, filter, detail, refresh, pause, and quit.
- Unit tests cover the snapshot provider for complete, absent-lease, corrupt
  coordination, corrupt lease, and retained-last-good results.
- Tests prove that the view model excludes tokens and message text.
- Tests prove separate source observation timestamps and non-overlapping
  refreshes.
- A non-TTY test proves `--watch` refuses without state mutation.
- Existing `dashboard --once` tests remain unchanged and pass.

## Open questions

- Select the exact maintained Ink package version and terminal test harness
  during the implementation ADR review. Do not add a dependency before that
  decision.
- Decide whether a later web renderer consumes the same snapshot provider or
  requires a local socket protocol. This ADR makes no web transport decision.
- Decide the minimum and maximum configurable refresh intervals with measured
  CPU use on supported terminals.

## References

- `docs/adr/0001-install-detection-flow.md`
- `docs/adr/0002-host-adapter-boundary.md`
- `docs/adr/0003-pods-model.md`
- `src/coordination/render.ts`
- `src/coordination/state.ts`
- `src/core/lease-reader.ts`
- `src/cli/snapshot.ts`
