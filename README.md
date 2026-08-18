# Interlock

Interlock is a local coordination product for agent sessions. It combines
exact-path lease safety with agent-native task claims, pane messaging, durable
inbox digests, and a read-only dashboard.

See `GOAL.md` for the product completion contract.

## Agent-native coordination

Tasks carry a business value so agents can see why work matters, not only what
files it touches. Claims are exclusive and fail closed when another pane owns
the task. Messages are correlated by thread and delivered to pane-scoped
inboxes. Idle and done transitions, plus the watcher heartbeat, create durable
digest artifacts under `$INTERLOCK_STATE_DIR/deliveries/<pane>/`.

The coordination CLI is available through the `interlock` command:

```text
interlock session register --pane <pane> --token <pane-token>
interlock task add --id <id> --title <title> --value <business-value> --pane <pane> --token <pane-token>
interlock task claim <id> --pane <pane> --token <pane-token>
interlock task reap <id> --pane <operator-pane> --token <operator-token> --dead-claimer <pane>  # claimer session must be done; staleness alone never allows reap
interlock send --from-pane <pane> --to-pane <pane> --token <pane-token> --text <text>
interlock inbox --pane <pane> --token <pane-token> --json
interlock session set --pane <pane> --token <pane-token> --state <idle|busy|done>
interlock watch --once
interlock dashboard --once
```

`dashboard` only reads coordination state. It is the human awareness surface;
task and message mutations remain agent/CLI operations.

Herdr provisions one token per pane with `session register`; the coordination
state stores only token hashes. Mutating commands and pane-scoped inbox reads
must present the matching token. Pane and task identifiers accept only
`^[A-Za-z0-9:._-]+$` without `..`.

The Herdr `space.js` and Pi extension integration uses the exported
`createSpaceAdapter()` boundary. `space.js` resolves its existing routing to a
pane, then delegates `send`, `inbox`, `session`, and one-shot `watch` calls to
Interlock with the pane token. The adapter shares `$INTERLOCK_STATE_DIR`; it
does not maintain a second message or digest ledger.

## Lease safety

Interlock conflicts only on exact declared repository-relative Git paths after
portable separator normalization, NFC Unicode normalization, and deterministic
case folding. This conservative rule applies on every filesystem so clients in
worktrees on different filesystems cannot miss a shared lease collision.

Interlock does not treat symlink or hard-link physical-file aliases as lock
aliases. Agents must declare the same repository-relative Git path when they
need a conflict.
