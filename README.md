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

## Interlock in Herdr

Use the Herdr adapter when you run Interlock from Herdr panes.

### Install the engine and adapter

Install the Interlock engine from npm.

```sh
npm install -g @raava-solutions/interlock
```

Run setup from a terminal that can use Herdr.

```sh
interlock setup
```

Read the setup plan before you answer the prompt.

Type `yes` to install the `@raava-solutions/interlock-plugin-herdr` adapter.

Setup echoes each host command before it runs the command.

Setup installs the adapter package when the expected version is not resolvable.

Setup activates the adapter only through `herdr plugin link <path>`.

Setup does not write Herdr configuration files directly.

Run the scriptable form only when your automation provides explicit consent.

```sh
interlock setup --yes
```

Run `interlock setup --remove` to unlink the adapter.

The remove command keeps the npm package installed.

### Check the integration

Run this command after setup and before you diagnose a Herdr problem.

```sh
interlock doctor
```

Doctor does not change Herdr or Interlock state.

Doctor checks the engine version, the Interlock state directory, the consent
record, Herdr availability, the plugin link, and engine-plugin version drift.

Doctor reports an unusable Herdr binary with the exact reason.

Run `interlock setup --yes` to repair a missing link or an older adapter.

Upgrade the engine when doctor reports that the adapter is newer than the
engine.

### Provision pane tokens

**Warning:** Treat each pane token as a bearer secret.

Do not put a token in a message, a task value, or a tracked file.

Store each pane token in the 1Password team vault.

Name each item `interlock member token <pane>`.

Give the token only to the matching Herdr pane session.

The orchestrator mints one token for each pod member with `interlock pod create`. Store each token in the 1Password team vault as `interlock member token <pane>`. `interlock session register` is for standalone members only.

Interlock stores only the token hash in its state directory.

### Send messages from panes

The Herdr adapter maps each pane to one Interlock member.

The adapter registers the pane session with its pane token.

The adapter sends pane messages through Interlock channels.

Members can message members in the same pod.

Only pod leaders can use a channel to message a leader in another pod.

The adapter updates session state when a pane becomes idle, busy, or done.

Interlock writes durable digests for idle panes and done panes.

The adapter reads the shared `$INTERLOCK_STATE_DIR` state directory.

The adapter does not keep a second message or digest store.

The orchestrator mints one token per pane with `interlock pod create`; the coordination
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

## Security and threat model

Read this section before you deploy Interlock. Interlock is a **local,
same-user** coordination tool. It assumes every process that can reach its
state directory already runs as you, on your machine. It does not provide
security boundaries between OS users, machines, or networks, and it does not
defend against an attacker who can read or write your state directory
directly — that attacker already owns everything Interlock protects.

Within that model, Interlock authenticates every mutating CLI command with
per-pane tokens (only SHA-256 hashes are stored, compared timing-safe) and
validates all identifiers against a strict character set. What it protects
against is confused or misbehaving *agents* acting through the CLI, not
adversaries with filesystem access.

Known limitations, disclosed plainly:

- **Plaintext state at rest.** Messages, task values, and coordination state
  are stored unencrypted in `$INTERLOCK_STATE_DIR` (including
  `state.json` and digest delivery files). Never paste secrets, credentials,
  or sensitive personal data into Interlock messages or task values.
- **First-registration identity trust.** A pane identity is bound to
  whichever local process registers that pane name first. A local process can
  squat an unclaimed pane name. Provision pane names you care about early,
  and treat unexpected registration conflicts as a signal to investigate.
- **`--session-pid` is caller-scoped.** The lease lifecycle accepts only the
  calling process or one of its ancestors as a session identity; foreign
  process IDs (including PID 1) are rejected. Within the same-user model this
  is a courtesy check, not a security boundary — a caller can still bind
  leases to a long-lived ancestor (for example its shell) and delay
  stale-session reclamation. Do not rely on PID binding as proof of
  identity.
- **Beads metadata is visible to repo collaborators.** Interlock records
  actor, PID, process start time, and leased repository-relative paths in
  Beads issue metadata. Keep secrets out of paths and identifiers.
- **Tokens are bearer secrets in your environment.** Pane tokens are
  delivered through your local provisioning channel (for example, your
  terminal or agent configuration). Anyone who reads a token can act as that
  pane through the CLI. Store tokens in a secret manager, never in files or
  messages.

If you need multi-user, multi-machine, or networked coordination with real
adversaries, Interlock's current threat model does not cover your use case.
