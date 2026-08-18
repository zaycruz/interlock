# ADR-0001: Install detection and setup flow

- Status: Accepted (QA adversarial architecture review PASS, verdict #643; head-office ratification #649, 2026-08-18)
- Date: 2026-08-17
- Deciders: interlock team
- Sources: `DIRECTIVE.md` ("Community release, 2026-08-17"), pods plan Product
  Contract R20, repo `AGENTS.md`

## Context

`@raava/interlock` becomes a public npm package. `npm install` must give the
engine only. Herdr integration must be opt-in: a setup step detects herdr,
explains what it will do, asks permission, and installs the herdr plugin only
on yes. No npm lifecycle script may mutate another tool. The threat model
stays local, same-user; this ADR does not change that.

## Decision

### Command surface

Two new CLI commands, wired in `src/cli/run.ts` next to the existing command
dispatch. Neither touches leases or the coordination plane.

- `interlock setup` — the only command that mutates host tools. It detects
  herdr, prints the plan, asks permission, and installs the herdr plugin only
  on an explicit yes. It is interactive. In a non-TTY environment it refuses
  to prompt and exits with code 2 unless `--yes` is passed; `--yes` is the
  explicit, scriptable form of consent.
- `interlock doctor` — read-only diagnosis. It reports: engine version, state
  directory health, herdr detection result, plugin install state, and version
  drift between engine and plugin. It never writes outside its own output.
  Exit code 0 when healthy, 1 when a check fails. Doctor is safe to run in
  CI and from any tool.

### Detection logic

Herdr is "present" when all of these hold:

1. A `herdr` executable resolves on `PATH`.
2. `herdr --version` exits 0 within a 5-second timeout.
3. The reported version satisfies the plugin's minimum supported herdr
   version.

Anything else — a stale binary that errors, a timed-out invocation, a version
below the floor — is reported by doctor as "herdr not usable" with the exact
reason. Setup treats "not usable" as "absent" and does not retry in a loop.

Setup does not scan the home directory for herdr config files, and does not
infer presence from other tools' directories. The CLI is the contract; files
are herdr's private business.

### The permission prompt

Setup prints, before any question:

- that herdr was detected, with the resolved binary path and version;
- the exact list of actions it will take (see "Install location" below);
- the exact uninstall command;
- that the engine works fully without the plugin.

The question accepts only an explicit `yes` (full word) as consent. Any other
input, including empty input, is a decline. Consent is recorded in
interlock's own state directory as a consent record: timestamp, interlock
version, plugin version, herdr version, and the actions taken. The record is
an audit trail, not a license check; doctor displays it. Setup never writes
consent into herdr's configuration — herdr's files belong to herdr.

### Install location and mechanism

Product ruling (head office, 2026-08-17, #562): install is automated on
explicit yes, with the exact command echoed before it runs.

The herdr plugin is a separate package, `@raava/interlock-plugin-herdr`,
versioned in lockstep with the engine (ADR-0002 covers the boundary). On
consent, setup runs two steps, echoing each exact command before it runs:

1. Package install: `npm install -g @raava/interlock-plugin-herdr`. Setup
   runs this itself after the explicit yes; echoing the command first keeps
   the supply-chain event visible in the user's own terminal. If the plugin
   package is already resolvable at the expected version, setup skips this
   step and says so.
2. Activation — the only write setup performs into herdr — goes through
   herdr's own plugin CLI: `herdr plugin link <path>` (verified surface;
   the manifest is `herdr-plugin.toml`, reference implementation
   `~/projects/herdr-space-manager`). Setup never hand-edits herdr config
   files. If the link command fails, setup aborts with instructions instead
   of guessing the format.
3. Setup verifies the activation with `herdr plugin list` and confirms the
   plugin appears. Unverified installs are reported as failed.

Uninstall is `interlock setup --remove`. It calls `herdr plugin unlink
<path>`, then removes interlock's consent record and plugin-side
registration state. It does not remove the npm package; it prints the
matching `npm uninstall -g` command.

### Failure and partial states

- **Setup run twice.** Idempotent. If the plugin is already active at the
  expected version, setup reports "already installed" and exits 0 without
  prompting. Version drift triggers a repair path: deactivate, re-activate,
  re-verify — each step through herdr's CLI.
- **Herdr absent.** Setup says the engine works standalone, installs nothing,
  exits 0. Doctor reports "herdr: not detected" and exits 0 — a missing
  optional host is not a failure.
- **Plugin directory or herdr CLI not writable.** Any write failure aborts
  the step immediately. Because every mutation goes through herdr's CLI,
  herdr owns its own rollback; setup's only cleanup duty is its own consent
  record, which is written last, after verification, so a failed install
  leaves no record. Setup exits 1 with the failing command and its output.
- **User declines.** Setup prints "nothing was changed", exits 0, and writes
  nothing — not even a decline record. A decline must never become a nag
  list or a fingerprint.
- **Partial activation (herdr CLI crashes mid-install).** The next
  `interlock doctor` run detects the divergence (consent record absent but
  plugin present, or the reverse) and reports the exact repair command.
  Setup's re-run repair path converges the state.

## Alternatives considered

- **npm `postinstall` hook that auto-detects and installs.** Rejected. A
  postinstall script runs with the package manager's privileges, invisible to
  the user, and would mutate another tool (herdr) without consent. That is
  the supply-chain pattern this product exists to avoid: install must not
  mutate other tools. It also runs in contexts (CI, transitive installs)
  where prompting is impossible, forcing either a silent mutation or a
  broken prompt.
- **`postinstall` that only prints a hint.** Rejected as the mechanism for
  activation, accepted as documentation. A one-line "run `interlock setup`"
  message in the README and package description is enough; lifecycle output
  is frequently suppressed.
- **Plugin bundled inside `@raava/interlock` as an inert module, activated by
  a local file write.** Rejected for v0.0.1. It removes the second npm fetch
  but forces setup to write files into herdr's directory tree directly,
  which breaks the "herdr owns its config" rule and couples setup to herdr's
  on-disk layout. A separate package plus herdr's own plugin CLI keeps each
  tool's mutation surface owned by that tool. Revisit if herdr's plugin
  loading turns out to require co-location.
- **Detect herdr by config files (`~/.herdr`, project directories).**
  Rejected. Config layouts are herdr's private contract and differ across
  versions; a false positive would offer to mutate a tool that is not
  actually usable. The CLI probe is the only stable signal.

## Security considerations

Threat model: local, same-user. The risks below are about buggy or
impersonated installers, not about crossing OS user boundaries.

- **What a malicious setup could do.** Anything the user can do. The binding
  constraint is therefore *surface*, not privilege: setup's write surface is
  exactly four things — one echoed `npm install -g` for the plugin package,
  one `herdr plugin link` invocation, one `herdr plugin list` verification,
  and interlock's own consent record. It holds no credentials and opens no
  sockets. An attacker who swaps the
  `interlock` binary wins regardless; these bounds exist so that a *buggy*
  setup cannot silently corrupt herdr, and so review can enumerate every
  write.
- **Consent spoofing.** `--yes` is scriptable consent; a wrapper script can
  pass it without the user reading the plan. Accepted risk, disclosed: the
  alternative (TTY-only consent) makes automation impossible, and the
  same-user attacker can already edit herdr directly. The consent record
  gives doctor an audit trail of what was done and when.
- **PATH hijack of the `herdr` probe.** A malicious `herdr` earlier on PATH
  would receive one invocation (`--version`) and possibly a `plugin link`
  call.
  Setup mitigates by printing the resolved binary path in the plan, so the
  user sees *which* herdr will be touched before consenting.
- **No downgrade via repair.** When the active plugin is older than the
  engine expects, repair moves it forward. When the active plugin is NEWER
  than the engine expects (engine is the stale component), repair refuses
  the downgrade, reports the mismatch, and tells the user to upgrade the
  engine instead. It never silently downgrades herdr, the plugin, or the
  engine.
- **Uninstall completeness.** `--remove` leaves no interlock-registered
  tokens or pane mappings behind in herdr; the plugin's own teardown
  (ADR-0002) revokes the member tokens it provisioned before deactivating.

## Open questions

- ~~The exact herdr plugin CLI surface~~ Resolved (head office ruling,
  2026-08-17, #562): `herdr plugin link <path>` / `unlink` / `list`, with a
  `herdr-plugin.toml` manifest. Verified on the development machine against
  the reference plugin `~/projects/herdr-space-manager`.
- Whether the plugin package is installed globally or per-user is delegated
  to the user's npm setup; setup only checks resolvability.
