# Interlock team directive (head office, 2026-08-16)

## Purpose

This space is the dedicated interlock team. It owns the repository at
/Users/master/projects/interlock end to end: code, tests, roadmap, and merges
to canonical main. The network charter (~/projects/CHARTER.md) applies in
full. Re-read it and ~/.agents/skills/space-ops/SKILL.md after any restart or
compaction, before you answer space traffic.

## Current state of the product

- Canonical main is at 019f142.
- Branch w380-unification (tip 3be3174) carries the unified coordination
  plane plus fixes for all five QA must-fix items. 85 tests, 84 pass, 1 skip,
  0 fail per engineering.
- QA (space wP) is running the re-review now. The verdict is the merge gate.
- The QA NO-GO report is at /Users/master/projects/qa-w380-review.md.
- Thirteen accepted-risk minors are tracked in docs/followup-issues.md on the
  branch.

## Immediate work, in order

1. Read GOAL.md, qa-w380-review.md, and docs/followup-issues.md. Know the
   five must-fix items and what the fixes claim to do.
2. Write a merge runbook for w380-unification: exact commands, the full test
   suite run on the merged result, and the rollback step. Put it in
   docs/merge-runbook-w380.md on the branch.
3. Triage docs/followup-issues.md into work items on this space's board with
   a proposed priority and a one-line reason each.
4. When head office relays the QA PASS verdict: staff one codex engineer
   (charter §6.2), run the merge, run the full suite on merged main yourself,
   and report the resulting main SHA to head office. If the verdict is NO-GO,
   route the findings back to engineering (space wT) through head office.

## Standing rules

- Nothing merges to canonical main without a QA PASS from space wP.
- Verify on disk. Never trust a self-report. Run the tests yourself.
- Charter §9: all credentials in the team 1Password account via the op CLI.
  Never in messages, never in files, never in Keychain.
- Report FOCUS and BLOCKERS when head office asks.
- One manager plus engineers staffed per active work. Close idle panes you
  created.

## Interfaces

- Head office: space wN (pane wN:p6). Escalate external decisions there.
- QA: space wP (qa-mgr-raven). Request reviews through head office.
- Engineering (wT) owns w380-unification until the merge. This team owns the
  repository from the merge onward, plus the follow-up queue starting now.

## Community release (CEO directive, 2026-08-17) — supersedes item 4 (done)

Interlock becomes a public product. This team owns that work end to end.

### Shape

- Package name: @raava/interlock (DevOps is creating the npm org).
- License: MIT (head-office default; CEO may override).
- Install flow: npm install @raava/interlock gives the engine. A setup step
  (interlock setup / doctor) detects herdr, explains what it will do, asks
  permission, and installs the herdr plugin only on yes. No npm postinstall
  mutations of other tools.
- v0.0.1: engine + herdr plugin path only.
- v0.0.2: BB IDE plugin — an agent thread in BB IDE joins the same plane as
  herdr space teams. A BB IDE thread is a pane: named identity, token, inbox,
  session state. New adapter at the boundary; no core surgery. BB IDE plugin
  API docs are pending from the CEO; design against the adapter boundary
  until they arrive.

### The pods concept (v0.0.2 scope)

A pane is an identity. A pod is a focused effort: a named group of panes that
contribute to one effort together, with one designated pod leader pane for
communications and management.

Pods are host-agnostic. The pod is an engine primitive, not a herdr concept
and not a BB IDE concept. Hosts only materialize pods: a herdr space maps
down to a pod (manager = pod leader); a BB IDE agent-thread group maps up to
the same pod. The pod schema must carry no herdr-specific or BB-IDE-specific
fields. Design test: a third, unknown host must be able to adopt pods without
any schema change.

Design questions the ADR must answer:

1. Pod lifecycle: who creates and closes a pod, and with what authority?
2. Membership: can a pane belong to more than one pod at once?
3. Leader powers and succession: what happens when the leader pane dies?
   (Apply the dead-claim reap learning: no manual database edits.)
4. Addressing: does mail to a pod go to the leader, the roster, or both?
5. Squatting: pod names hit the same first-registration risk as pane names
   (follow-up item 14). The ADR must say how pod identity is provisioned.

### Review requirements (standing for this release)

- Every merge to main keeps the QA adversarial code review (space wP).
- Every architecture decision gets an ADR in docs/adr/ AND an adversarial
  architecture review before the decision is called final: attack failure
  modes, identity forgery paths, and upgrade compatibility, not style.
- The public README must carry a threat-model disclosure: local same-user
  trust, plaintext state at rest, first-registration squatting, --session-pid
  trust. Follow-up items 3, 11, 14 worded for strangers.

### Order of work

1. Continue the P1 follow-up items (already triaged).
2. Release pass: license, package metadata, CI on macOS and Linux, threat-
   model section, publish dry-run (npm publish --dry-run, no real publish
   without CEO approval).
3. ADRs: install/detection flow, adapter boundary, pods.
