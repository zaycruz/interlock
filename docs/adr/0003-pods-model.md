# ADR 0003: Pods model

- Status: Accepted (QA adversarial architecture review PASS, verdict #643, MF-A..E resolved at e59af35; head-office ratification #649, 2026-08-18)
- Date: 2026-08-17
- Product authority: `docs/plans/2026-08-17-001-feat-pods-model-plan.md` (R1–R20,
  F1–F6, AE1–AE6). That contract is the WHAT/WHY and is non-negotiable. This ADR
  owns the HOW.
- Review driver: `/Users/master/projects/qa-w380-review.md` (forgery by
  convention, stale-vs-done reap guard, dead-holder wedge).
- Product rulings (head office #562, 2026-08-17): pods ship in v0.0.1 (the
  Product Contract owns release scope); the awareness feed reuses the digest
  machinery's plumbing, never its content payloads. Both match this ADR as
  drafted.
- Review resolutions: the QA adversarial review
  (`docs/adr/0001-0003-qa-adversarial-review.md`, verdict
  approve-with-conditions) is resolved in this text. Must-fix items MF-A
  through MF-E are written into D3, D4, and D6; the seven non-blocking
  observations are written into the sections they concern.

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
  process: ProcessIdentity | null;  // { pid, startedAt }; rebind lifecycle in D6
  registeredAt: string;
}

interface LeaderChannel {
  id: number;
  fromPod: string;
  toPod: string;
  topic: string;                // mandatory, bounded; see D4
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

`pod appoint` is constrained: the appointee must be a current roster member of
that pod. Appointing a member of another pod would break R3's exclusive
membership by operator action, and appointing a non-member would create a
leader with no token binding — both are rejected. R16's ranked succession
order governs auto-promotion only; a deliberate appointment after
`leader-done` (F5) may name any roster member, in or out of order. The
appointment updates both members' roles — appointee to `leader`, prior leader
to `worker` — so no roster ever shows two leaders, and it is recorded with
the existing `leader-promoted` awareness event kind.

The orchestrator cannot send to workers, cannot open leader channels (it leads
no pod), and has no command that returns leader-channel content (D5).

Token recovery: `orchestrator init` run twice refuses, because the registered
hash differs. A lost token would strand topology control short of state
surgery, so `orchestrator init --rotate` exists for the local operator: it
mints a new orchestrator token, replaces the stored hash, and prints the new
token once. Rotation is operator-run and local; it authenticates by
filesystem access to the state directory, which the threat model already
grants the operator.

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
   The send increments `channel.messageCount`. Channels are bidirectional
   once open: either endpoint's leader may send on the channel, in either
   direction.
3. Leader → `orchestrator`: allowed (reports). Orchestrator → any pod leader:
   allowed.
4. Everything else is rejected: worker → other pod, worker → orchestrator
   (AE4), worker → any external address, orchestrator → worker, any send from
   or to a member of a closed pod, any send from a member in no pod.

The reply path inherits the parent message's channel; a reply cannot escape a
channel its parent rode in on. Channel open is a new token-checked command:
`interlock channel open --from-pod <pod> --to-pod <pod> --topic <topic>`. The
caller must authenticate as the current leader of `from-pod`; a leader that
has reported done cannot open new channels (D6). `--topic` must be non-empty
after trim, or the open is rejected (AE6). Topic is bounded: the
`validateCoordinationName` charset is too narrow for prose, so topic accepts
printable non-whitespace-plus-space UTF-8 up to 140 characters. The bound
matters because topic is the one content-shaped field that reaches the
awareness feed — a leader could smuggle channel content to the feed one
channel-open at a time. That is endpoint self-disclosure, not engine leakage,
but the bound and this note keep "awareness, not minutes" honest. `channel
close` records `messageCount` and emits the awareness event.

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
leadership changed — never what was said. Nothing bounds channel open/close
churn, so a noisy pair of leaders can grow the append-only feed quickly;
retention and compaction are plan OQ2 and land with the state-file compaction
work (see Open questions), not with v0.0.1.

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

Rebind lifecycle (MF-A). A member's recorded identity must be able to follow a
legitimate restart, or the next watch sweep would read a live restarted leader
as dead and wrongfully promote the successor — AE1 violated by an ordinary
restart. Rebind rules:

- **Who:** the member token holder only. The orchestrator cannot rebind a
  member's identity; topology control does not include pinning processes.
- **When:** only when the recorded identity verifies `dead` or `mismatched`
  via `inspectProcess`. A recorded identity that verifies `alive` (or is only
  `ambiguous`/`unknown`) refuses the rebind — a token holder cannot pin the
  member's identity to an immortal process and block succession forever.
- **Ownership proof:** the rebind binds the calling process's own pid,
  captured engine-side via `processIdentityFor(process.pid)`. There is no
  `--pid` flag and no way to name another process. This applies the W380
  follow-up #3 lesson directly: the lease slice's `--session-pid` accepts any
  live pid (pid 1 included); the member rebind does not import that weakness.
  A stolen token can therefore rebind only to a process the thief actually
  runs, and only after the real member's process is verifiably gone.

Evaluation points: the `watch --once` sweep, and lazily whenever a send,
channel open, or channel reply touches a pod whose leader fails verification.
Lazy evaluation ordering (MF-D) is fixed: evaluate death, apply the promotion,
then evaluate the triggering operation against post-promotion state. A send
authenticated with the just-dead leader's token is re-evaluated with the
sender as a worker — and rejected, because the token hash was deleted in the
same mutation (below) and a worker has no external reach. No external send
rides through mid-promotion on pre-promotion authority. Required regression
test: a leader-channel send that triggers lazy promotion of its own sender's
pod is rejected, and the promoted successor can immediately open or continue
channels.

Promotion path, no elections (R16): walk `pod.succession` in ranked order;
promote the first candidate whose own process identity verifies `alive`;
update `pod.leader` and **both** members' roles — successor to `leader`, dead
leader to `worker` — so no roster ever shows two leaders; emit
`leader-death-verified` and `leader-promoted`. In the same locked mutation,
delete the dead leader's token hash from `memberTokens` (MF-B): a token
copied out of the dead process's environment must not survive as a
posthumous forgery path. This is the same mechanism D7 already specifies for
pod close, applied per member at promotion. If every candidate is dead or
unverifiable, the pod keeps its roster, loses external reach (D4 rejects
sends from a pod with no live leader), emits the death event, and waits for
the orchestrator. It never closes (R15).

`leader-done` (F5): the leader reports done through the existing session
path; the engine emits `leader-done`, and reduces the done leader's powers
(MF-C). A done leader keeps `role: "leader"` for addressing and keeps its
token, but it cannot open new channels, and its existing open channels are
closed in the same mutation, each with its message count recorded as a
`channel-closed` awareness event. Intra-pod reach survives: the done leader
can still send and receive inside the pod while the pod waits for the
orchestrator to appoint a successor or close it (AE3). No promotion fires
(R14). The wait can be days in v0.0.1 — the orchestrator is a human-driven
CLI with no daemon — which is exactly why done cannot leave full external
reach in place. This mirrors the W380 stale-vs-done guard in the opposite
direction: `done` is a signal to the orchestrator, never to the succession
machinery.

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
renames `paneTokens` to `memberTokens`, and writes version-2 state. Required
order: `orchestrator init` first, then `state migrate` — migration creates a
pod, and pod creation requires an initialized orchestrator; the migrate
command checks and names the init step in its error if run first. Version-1
messages, tasks, sessions, and digests carry over unchanged as history; the
migration adds pod structure, it does not rewrite the plane's records. No
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
- **R12 is mechanism-level, not operator-level.** The structural guarantee in
  D5 bounds what the *orchestrator entity* can receive through the engine. It
  does not create content confidentiality from the *operator*: anyone with
  state-dir read access — typically the same person who holds the
  orchestrator token — reads channel content in `state.json` directly. The
  community README must say this plainly, or R12 will be misread.
- **Posthumous token use.** A token copied from a dead leader's environment
  is invalidated at promotion (D6 deletes the hash in the same locked
  mutation), and pod close deletes the whole roster's hashes (D7). Residual
  window: between death and the next evaluation point the copied token still
  authenticates intra-pod sends. Accepted — the process is verifiably dead,
  the reach is intra-pod only, and the window closes on the next sweep.
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

- Awareness feed retention and compaction (plan OQ2, resolved): the feed is
  append-only but capped at the most recent 1000 events
  (`AWARENESS_FEED_MAX_EVENTS`), enforced inside `appendAwarenessEvent` on
  every write, so channel open/close churn (D5) can never grow the persisted
  state file past the bound. The id counter is never lowered and the retained
  events are always the highest-id contiguous suffix; the oldest events age
  out first. A state file written before the cap can carry an oversized feed:
  state load trims it to the newest 1000, so the next mutation — including
  `compact` — persists the bounded feed with no operator action. The `compact`
  command keeps its message/digest sweep; the awareness cap needs no sweep of
  its own.
- Maximum pods and roster sizes (plan OQ3, resolved): enforced at pod create
  time as named constants — `MAX_PODS_PER_DEPLOYMENT` (64) and
  `MAX_ROSTER_SIZE` (16) — with refusal errors that name the limit. Closed
  pods count toward the deployment limit because their rosters persist as
  history and their names are never reusable; an over-limit attempt leaves no
  partial state behind.
- BB IDE plugin surface (plan OQ1): adapter boundary only; no engine impact.

## References

- `docs/plans/2026-08-17-001-feat-pods-model-plan.md`
- `docs/adr/0001-0003-qa-adversarial-review.md` — QA adversarial review; MF-A
  through MF-E and observations 1–7 resolved in this text
- `DIRECTIVE.md` — community release, host-agnosticism hard rule, five design
  questions
- `/Users/master/projects/qa-w380-review.md`
- `src/coordination/commands.ts`, `src/coordination/state.ts`,
  `src/coordination/types.ts`, `src/coordination/validation.ts`,
  `src/core/process-identity.ts`
