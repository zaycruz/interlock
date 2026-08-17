# ADR 0003: Pods model

- Status: Proposed (pending adversarial architecture review, per DIRECTIVE.md)
- Date: 2026-08-17
- Product authority: `docs/plans/2026-08-17-001-feat-pods-model-plan.md` (R1–R20,
  F1–F6, AE1–AE6). That contract is the WHAT/WHY and is non-negotiable. This ADR
  owns the HOW.
- Review driver: `/Users/master/projects/qa-w380-review.md` (forgery by
  convention, stale-vs-done reap guard, dead-holder wedge).

## Context

The coordination plane today is flat: any registered pane can send to any other
pane (`src/coordination/commands.ts` `sendCommand`), identity is a per-pane
token (`src/coordination/state.ts` `assertPaneToken`), and there is no group
concept. Pods add a group primitive with an enforced communication boundary, a
leader per pod, one orchestrator entity per deployment, and death-verified
succession. The W380 review showed what identity and routing by convention
cost; every rule below is enforced by mechanism inside the coordination lock.

Threat model is unchanged: local, same-user coordination, plaintext state at
rest. Pods do not defend against an attacker who can already write the state
directory; they defend against confused or misbehaving agents operating
through the CLI.

## D1. Pod schema and member identity (R3, R4, R17)

New state on `CoordinationState` (state.json version 2):

```ts
interface Pod {
  name: string;                 // validateCoordinationName charset, unique across all time
  createdAt: string;
  leader: string;               // member name
  succession: string[];         // ranked member names, fixed at creation
  status: "open" | "closed";
  closedAt: string | null;
}

interface PodMember {
  member: string;               // the engine identity word; "pane" stays herdr's word
  pod: string;                  // exclusive membership: one pod field, not a list
  role: "leader" | "worker";
  process: ProcessIdentity | null;  // { pid, startedAt } from core/process-identity
  registeredAt: string;
}

interface LeaderChannel {
  id: number;
  fromPod: string;
  toPod: string;
  topic: string;                // mandatory, non-empty at open
  openedAt: string;
  closedAt: string | null;
  messageCount: number;
}

interface AwarenessEvent {
  id: number;
  kind: "pod-created" | "pod-closed" | "channel-opened" | "channel-closed"
      | "leader-death-verified" | "leader-promoted" | "leader-done";
  createdAt: string;
  // metadata only: pod names, member names, topic, messageCount. Never text.
}
```

Host-agnosticism check, field by field: `name`, timestamps, `leader`,
`succession`, `status` are generic group concepts. `member`, `role`, `pod` are
engine words defined by R4. `process` is OS-level identity, not host identity —
every host runs processes. `topic`, `messageCount`, channel endpoints are
generic. No field names a space, pane, workspace, agent thread, or IDE
concept. Third-host test: a new host maps its native identity to `member` and
its native grouping to `pod` at the adapter boundary; no schema change.

Member tokens reuse the existing token machinery: `paneTokens` becomes
`memberTokens` (same sha256 hash + `timingSafeEqual` verification), keyed by
member name. The herdr adapter maps pane to member 1:1 (R20); the engine never
sees the word "pane".

## D2. Creation: orchestrator-only, template-driven (R1, R2, R5)

New command: `interlock pod create --name <pod> --template <file>
--orchestrator-token <token>`. The template (JSON) defines the roster, the
leader, and the ranked succession order. The shipped default template is one
leader plus three workers; smaller rosters are legal (R2). Succession order is
fixed at creation and immutable afterward; changing it means closing and
recreating the pod.

Creation runs inside `withCoordinationLock` and:

1. Authenticates the orchestrator token (see D3).
2. Validates the pod name and every roster name with
   `validateCoordinationName` (existing charset, `..` rejected).
3. Rejects a name that matches any existing or closed pod. Pod names are never
   reused; a closed pod stays in state as history (F6), and reuse would fork
   that history.
4. Provisions each member: generates a 256-bit random token engine-side,
   stores only its hash, and binds the member's `ProcessIdentity` at first
   registration. If a roster name is already present in `memberTokens` with a
   different hash (squatted or stale), creation aborts and reports the name;
   the operator picks another name. This closes first-registration squatting
   for pod members by construction: the orchestrator mints identity, no member
   self-asserts it.
5. Prints each member token exactly once, to the operator, who distributes
   tokens to the member processes out of band (host adapter's job).
6. Emits the `pod-created` awareness event.

## D3. The orchestrator entity (R10)

Exactly one orchestrator per deployment, addressable by rule: the reserved
member name `orchestrator`. `validateCoordinationName` callers in member
provisioning reject this name for any regular member; it can only be
provisioned by `interlock orchestrator init`, an operator-run command that
mints the orchestrator token, stores its hash, and prints the token once. In
the local same-user deployment the orchestrator is driven by the human
operator (or the host's operator-level automation) through the CLI; there is
no orchestrator daemon in v0.0.1.

Orchestrator powers, all token-checked:

- Create pods, appoint leaders and successors after `leader-done` events
  (`pod appoint --pod <pod> --leader <member>`), close pods.
- Send messages to any pod leader.
- Read the awareness feed.

The orchestrator cannot send to workers, cannot open leader channels (it leads
no pod), and has no command that returns leader-channel content (D5).

## D4. Routing enforcement by mechanism (R6–R9)

Hook point: `sendCommand` in `src/coordination/commands.ts`, inside the
existing `withCoordinationLock` block, immediately after `assertPaneToken`
authenticates the sender. One new pure function decides:

```ts
assertSendAllowed(state, fromMember, toMember, channelId?): void
```

Rules, evaluated in order:

1. Same pod: any member → any member of its own pod (including its leader).
   Allowed.
2. Leader → leader of another pod: allowed only with a `--channel <id>`
   naming an open `LeaderChannel` whose endpoints are exactly the two pods.
   The send increments `channel.messageCount`.
3. Leader → `orchestrator`: allowed (reports). Orchestrator → any pod leader:
   allowed.
4. Everything else is rejected: worker → other pod, worker → orchestrator
   (AE4), worker → any external address, orchestrator → worker, any send from
   or to a member of a closed pod, any send from a member in no pod.

The reply path inherits the parent message's channel; a reply cannot escape a
channel its parent rode in on. Channel open is a new token-checked command:
`interlock channel open --from-pod <pod> --to-pod <pod> --topic <topic>`. The
caller must authenticate as the current leader of `from-pod`; `--topic` must
be non-empty after trim, or the open is rejected (AE6). `channel close`
records `messageCount` and emits the awareness event.

There is no `--to-pod` address. Design question 4 (addressing: leader vs
roster) resolves to: external mail to a pod goes to the leader, by name. The
roster is never an address; intra-pod fan-out is the members' own business.

## D5. Awareness feed (R11, R12)

Storage reuses the digest machinery, not its payload: awareness events are
appended to `state.awareness` inside the coordination lock, persisted by the
same atomic tmp-write-plus-rename path, and delivered to the orchestrator
through `writeDigestDelivery` into the orchestrator's delivery directory. What
is not reused is the message-bearing digest file: the awareness delivery
contains only `AwarenessEvent` records.

Event set, exactly R11: `pod-created`, `pod-closed`, `channel-opened`
(participants + topic), `channel-closed` (message count), plus
`leader-death-verified`, `leader-promoted`, `leader-done`. From this feed
alone the orchestrator reconstructs who talked to whom, about what, and when
leadership changed — never what was said.

Structural guarantee for R12: leader-channel content lives in
`state.messages`, addressed between the two channel leaders. The orchestrator
is not a pod leader, so D4 rule 2 can never name it as a channel endpoint,
and rule 4 rejects every other path by which a channel message could be
addressed to it. The only orchestrator-readable store is the awareness feed,
whose `AwarenessEvent` type has no field capable of carrying message text.
There is no `inbox --pane orchestrator` over channel messages because no
channel message is ever addressed to `orchestrator`.

## D6. Succession (R13, R14, R16)

Death verification generalizes `src/core/process-identity.ts` from lease
holders to members. Each member binds `ProcessIdentity` (`pid` + `startedAt`)
at registration. `inspectProcess` returns `alive | ambiguous | mismatched |
dead | unknown`; promotion fires only on `dead` or `mismatched` (pid gone, or
pid recycled under a different start time — AE2). `ambiguous` (weak `ps`
precision), `unknown`, staleness, silence, and missed heartbeats never fire
promotion (AE1). This is the stale-vs-done reap lesson applied to leadership:
only provable death mutates the roster.

Evaluation points: the `watch --once` sweep, and lazily whenever a send,
channel open, or channel reply touches a pod whose leader fails verification.
Promotion path, no elections (R16): walk `pod.succession` in ranked order;
promote the first candidate whose own process identity verifies `alive`;
update `pod.leader` and the member's `role`; emit `leader-death-verified` and
`leader-promoted`. If every candidate is dead or unverifiable, the pod keeps
its roster, loses external reach (D4 rejects sends from a pod with no live
leader), emits the death event, and waits for the orchestrator. It never
closes (R15).

`leader-done` (F5): the leader reports done through the existing session
path; the engine emits `leader-done` and nothing else. No promotion, no token
revocation — intra-pod communication continues while the pod waits for the
orchestrator to appoint or close (AE3). This mirrors the W380 stale-vs-done
guard in the opposite direction: `done` is a signal to the orchestrator,
never to the machinery.

Forged-death defense: no CLI input asserts death. There is no `--dead-leader`
flag on any promotion path (contrast `task reap --dead-claimer`, which needed
an operator-token guard; promotion needs no operator at all). Death is a fact
the engine reads from the OS, not a claim a caller makes.

## D7. Pod lifecycle (R15)

Pods close only by `interlock pod close --pod <pod> --orchestrator-token
<token>`. Nothing automatic closes a pod — not all-members-done (AE5), not
all-members-dead, not time.

On close, inside the lock:

1. `status` flips to `closed`, `closedAt` is set, `pod-closed` is emitted.
2. Member token hashes for the roster are deleted from `memberTokens`, so no
   further command can authenticate as a member of the pod. D4 rule 4 already
   rejects sends touching closed pods.
3. Open leader channels involving the pod are closed with their message
   counts, emitting `channel-closed` per channel.
4. The pod record, member records, channels, and all messages persist as
   history. Nothing is compacted or deleted except the token hashes.

## D8. Upgrade and compatibility

`CoordinationState.version` moves 1 → 2. Version-1 state is hard-refused with
a remediation message, matching the lease layer's legacy-schema refusal
(praised in the W380 review) and the repo rule against backward-compatibility
shims. The escape hatch is explicit: `interlock state migrate --legacy-pod
<name> --legacy-leader <pane>` runs once under operator control, wraps all
version-1 panes into a single orchestrator-created pod with the named leader,
renames `paneTokens` to `memberTokens`, and writes version-2 state. No
silent upgrade, no flat-messaging compatibility mode (R18 forbids a flat
release preceding pods; a silent flat mode in version 2 would be the same
hole, shipped).

## Security considerations / anticipated attacks

- **Forged leader token.** Tokens are 256-bit random, engine-minted at
  provisioning, stored as sha256 hashes, compared with `timingSafeEqual`
  (existing `assertPaneToken` machinery, verified by QA in the W380
  re-review). A forger must guess the token or read the state dir; the latter
  is outside the threat model. Defended.
- **Forged death signal.** No command accepts a death claim. Promotion reads
  `inspectProcess` output only; a caller cannot name a pid for the leader —
  the engine holds the recorded `ProcessIdentity` and re-derives current fact.
  A attacker who kills the leader process achieves a real promotion, which is
  the designed behavior (same-user threat model). Defended by construction.
- **Worker external-send attempt.** Rejected by `assertSendAllowed` inside
  the lock, after token authentication, before any state mutation (AE4). The
  check is a pure function over state, so it is directly unit-testable with
  forged sender/recipient combinations. Defended.
- **Pod-name squatting.** Only the orchestrator creates pods, so the
  first-registration race that hit pane names (follow-up item 14) has no
  window at pod scope. Member-name squatting ahead of pod creation fails
  loudly: creation aborts on a foreign-registered roster name instead of
  adopting it. The reserved `orchestrator` name cannot be registered by
  anyone. Defended; residual risk is denial of a chosen name, disclosed.
- **Orchestrator compromise.** The orchestrator token controls topology:
  create/close pods, appoint leaders. It still cannot read leader-channel
  content through any engine command (D5 is structural, not a permission
  check). Scope of compromise is therefore full availability and topology
  damage, limited confidentiality damage. Accepted: in the local same-user
  threat model the orchestrator token lives with the operator, and anyone who
  can read the state dir can read `state.json` directly. Disclosed in the
  README threat-model section.
- **Busy-leader wedge (inverted dead-holder).** The W380 dead-holder wedge
  came from acting on staleness. Here staleness and silence are explicitly
  non-inputs to promotion (AE1), so a live busy leader is never displaced,
  and a genuinely dead one is displaced within one watch sweep. Defended.
- **Channel-content exfiltration via reply.** Replies inherit their parent's
  channel and recipient validation; a leader cannot reply a channel message
  to a third party. Defended by D4's reply rule.

## Alternatives considered

- **Flat messaging first, boundary later.** Rejected (session-settled): the
  boundary is a security invariant; retrofitting it onto a released flat API
  forces a breaking v0.0.2 and teaches hosts habits we then punish.
- **Strict hub routing through the orchestrator.** Rejected (session-settled):
  leaders coordinate directly as real leadership teams do; a hub both
  bottlenecks coordination and puts content in front of the orchestrator,
  violating the awareness-only decision.
- **Host-level orchestrator (herdr wires oversight).** Rejected
  (session-settled): a hard requirement needs engine enforcement; a host that
  forgets to wire oversight fails open, and the BB IDE adapter would have to
  re-derive the same logic.
- **Multi-pod membership.** Rejected (session-settled): a member in two pods
  is a person-shaped hole in the boundary; enforcement reduces to one `pod`
  field per member, not a set to diff on every send.
- **Elections or staleness-based promotion.** Rejected (session-settled):
  elections add machinery for a problem the creation-time ranked order already
  solves; staleness heuristics fire on exactly the busy-silent leader AE1
  forbids displacing. Only provable death promotes.

## Open questions

- Awareness feed retention and compaction (plan OQ2): this ADR makes it
  append-only; unbounded growth is already follow-up item 7 for the plane.
  Retention policy lands with the compaction work, not here.
- Maximum pods and roster sizes (plan OQ3): unenforced in v0.0.1; state-file
  scaling is the practical ceiling.
- BB IDE plugin surface (plan OQ1): adapter boundary only; no engine impact.

## References

- `docs/plans/2026-08-17-001-feat-pods-model-plan.md`
- `DIRECTIVE.md` — community release, host-agnosticism hard rule, five design
  questions
- `/Users/master/projects/qa-w380-review.md`
- `src/coordination/commands.ts`, `src/coordination/state.ts`,
  `src/coordination/types.ts`, `src/coordination/validation.ts`,
  `src/core/process-identity.ts`
