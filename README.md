# Interlock

Interlock coordinates local coding agents that work in Git worktrees. An agent can discover a task, claim exact paths, exchange task-linked messages, save a checkpoint, and submit a result for verification. Beads owns the issue. Interlock owns execution coordination and leases.

Interlock is for cooperating agents that run as the same operating-system user. It is not a hosted tracker, an agent scheduler, or a security boundary between agents.

## Install V1

Install the verified GitHub release archive:

```sh
npm install --global https://github.com/zaycruz/interlock/releases/download/v1.0.0/raava-solutions-interlock-1.0.0.tgz
interlock --help
```

Use this archive for version 1.0.0. The npm registry release is separate. Install Node.js 22 or later and the Beads CLI before you create linked coding tasks.

## Start from source

Use Node.js 22.13 or later to develop from source on macOS or Linux. The published runtime supports Node.js 22 or later. Install the Beads CLI before you use linked coding tasks. Initialize Beads in the target Git repository.

```sh
npm ci
npm run build
node dist/src/cli/main.js --help
```

The package provides `interlock` and `interlock-mcp` executables. Run `npm pack` to create a local release archive. Install that archive in your chosen tool environment. Package creation does not establish publication or release acceptance.

Set `INTERLOCK_STATE_DIR` to one shared local directory for the participating agents. Inject `INTERLOCK_PANE_TOKEN` from 1Password into each agent process. Do not put tokens in tracked configuration, command arguments, task text, or messages.

Register a standalone pane with the token already in its environment:

```sh
interlock session register --pane worker-a
```

For managed pods, the operator provisions membership with `interlock orchestrator init` and `interlock pod create`. Pod creation returns member tokens once. Give each token only to its matching pane. Standalone registration does not provision pod membership.

## Complete a coding task

A linked task identifies one Beads issue by its Git common directory and issue ID. Its selected worktree is separate from that identity. Different task IDs cannot link to the same canonical issue.

Create a Beads issue with `Value:`, `Work:`, and acceptance criteria. Supply one verification command for each nonempty acceptance line. A check's `criterion` must match that line without its bullet marker.

This example assumes the issue's acceptance criterion is `Unit tests pass`:

```sh
interlock task add --id fix-parser --pane worker-a \
  --workspace /absolute/path/to/worktree \
  --contract '{"beadId":"project-123","paths":["src/parser.ts"],"checks":[{"criterion":"Unit tests pass","command":["npm","test"]}]}'
interlock task inspect fix-parser --pane worker-a
interlock task claim fix-parser --pane worker-a --session-pid $$
interlock task checkpoint fix-parser --pane worker-a --text 'Parser changed. Run the acceptance check next.'
interlock task complete fix-parser --pane worker-a \
  --result '{"summary":"Corrected parser behavior","artifacts":["src/parser.ts"]}'
```

The shell example binds ownership to that shell's lifetime. Host adapters bind ownership to their own process. A claim requires all exact-path leases before Beads ownership changes. Use `task heartbeat` at work seams during a long task.

Completion runs the checks captured at claim in the claimed worktree. Failed checks, changed acceptance, contract drift, or staged paths outside the lease block completion. The result summary and artifact references remain `agent-declared`. Recorded check outcomes are `interlock-executed`. A successful check proves only the behavior that its command tests.

A task created with `--title` and `--value` but no `--contract` is coordination-only work. It does not grant file ownership. Its `done` state does not represent executed acceptance checks.

## Coordinate without interruptions

```sh
interlock send --from-pane worker-a --to-pane worker-b \
  --task fix-parser --request-id parser-question-1 --text 'Which input caused the failure?'
interlock inbox summary --pane worker-b
interlock inbox --pane worker-b --task fix-parser --json
interlock task resume fix-parser --pane worker-a
```

Claim a message before you act on it. Reply with `--reply <message-id>`. Close the handled message with `interlock inbox close --message <message-id> --pane <pane>`.

Reuse a sender's request ID only for an identical retry. A changed payload with the same key fails. Task and request threads survive compaction. Task resume returns only messages sent or received by the requesting pane. Sharing a task does not expose other panes' private messages.

Sends are quiet. Agents pull their inbox at natural seams. `interlock dashboard --once` provides a read-only local view. Inbox summaries contain counts and a bounded digest listing. The engine still loads local coordination state.

## Connect an agent host

Start `interlock-mcp` as a stdio server. Set `INTERLOCK_PANE`, `INTERLOCK_PANE_TOKEN`, and `INTERLOCK_STATE_DIR` in the server environment. Run one server per pane. Supply secrets through the host's environment injection mechanism.

MCP exposes task discovery, execution, recovery, messaging, and pod/channel discovery. Tools return structured results. The server supplies its own pane and process identity. Pod provisioning and host installation remain operator operations. See the [capability map](docs/capabilities.md).

The Pi extension is exported as `@raava-solutions/interlock/pi`. For a source build, load its entry point explicitly:

```sh
pi -e /absolute/path/to/interlock/dist/src/pi/index.js
```

Inject `INTERLOCK_PANE_TOKEN` before Pi starts. Set `INTERLOCK_PANE` for a provisioned pane. If it is absent, the extension registers `pi:<session-id>` as a standalone pane. Use `/interlock-resume`, `/interlock-inspect`, `/interlock-claim`, `/interlock-heartbeat`, `/interlock-release`, and `/interlock-complete <task-id> <JSON result>`.

The extension refreshes owned active leases and preserves ownership during reload. Session departure releases its exact active linked contracts. Idle does not complete work. A killed host requires verified-death recovery.

The existing Herdr adapter uses the same coordination store. `interlock setup` shows its install plan and requests consent. `interlock setup --yes` provides scriptable consent. `interlock doctor` checks the integration without changing state. `interlock setup --remove` unlinks the adapter and retains its installed package. These commands are Herdr-specific.

## Recover and operate

Read [V1 operation and limits](docs/gtm-v1.md) for recovery, upgrades, and release criteria. Read [GOAL.md](GOAL.md) for the completion contract. Run `npm run typecheck`, `npm test`, and `npm run test:adapter` for repository checks. The engineering gate and release dogfood require separate recorded evidence.
