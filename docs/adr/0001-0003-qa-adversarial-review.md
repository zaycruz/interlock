# Adversarial architecture review — ADR-0001/0002/0003 (pods model)

- Date: 2026-08-17
- Reviewer: qa-mgr-raven (qa space, wP:p1) — head-office request #555, board item il-5aq
- Target: branch `docs/adr-set` @ `5e1233d`; authority: pods Product Contract R1–R20, F1–F6, AE1–AE6
- Mandate: attack failure modes, identity forgery paths, upgrade compatibility. Design review, not style.

## Verdicts

| ADR | Verdict |
|---|---|
| 0001 Install detection and setup flow | **approve-with-conditions** |
| 0002 Host adapter boundary | **approve** |
| 0003 Pods model | **approve-with-conditions — 5 must-fix items below** |

ADR finalization should wait for the ADR-0003 must-fix resolutions to be written into the ADR. None of them requires reopening session-settled product decisions; all are HOW-level.

## ADR-0003 must-fix items (block finalization)

### MF-A — Member ProcessIdentity rebind lifecycle is undefined (D1, D6)

`process` is bound "at first registration" and never again specified. Both unresolved directions break R13:

1. **No rebind:** a legitimately restarted leader keeps the old recorded pid. The next `watch` sweep reads its recorded identity as `dead`/`mismatched` and auto-promotes the successor against a **live** leader — exactly the wrongful displacement AE1 forbids, now triggered by an ordinary restart.
2. **Token-based rebind:** if presenting the member token rebinds a new pid, any token holder can pin the member's identity to an immortal process (e.g. pid 1 — the W380 follow-up #3 lesson) and block succession forever, or bind a pid the caller does not own.

The ADR must define: who may rebind (token + orchestrator? token alone?), when (only when recorded identity verifies dead/mismatched?), and what caller-to-pid ownership proof is required (the lease slice already has this machinery's strengths and its documented weakness).

### MF-B — Dead leader's token is never revoked at promotion (D6)

D6 promotes the successor and updates roles, but nothing touches the dead leader's entry in `memberTokens`. A token copied out of the dead process's environment (crash dump, shell history, logged argv) remains valid for intra-pod messaging indefinitely — posthumous forgery against the pod the identity was just removed from leading. D7 already has the mechanism (pod close deletes roster token hashes). Fix: on `leader-death-verified`, delete or rotate the dead member's token hash in the same locked mutation as the promotion.

### MF-C — Done leader retains unbounded external reach (D6, F5) — flagged by head office

`leader-done` fires an awareness event and nothing else: no promotion (correct per R14/AE3), but also **no power reduction**. The done leader keeps `role: "leader"`, keeps its token, and under D4 rules 2–3 can still open new channels and speak for the pod while "the pod waits for the orchestrator". In v0.0.1 the orchestrator is a human-driven CLI with no daemon — that wait can be days. A leader that reported done (or was told to stop, or whose assignment ended) remains the pod's external voice indefinitely. Fix: define done-leader powers explicitly. Recommended: a done leader cannot open new channels; existing channels freeze or close with their counts; intra-pod reach survives until the orchestrator appoints or closes.

### MF-D — Lazy promotion ordering on the triggering send is unspecified (D6)

Promotion evaluates "whenever a send, channel open, or channel reply touches a pod whose leader fails verification". If the triggering command is a leader-channel send authenticated with the dead leader's token, the ADR does not state whether the send is re-evaluated against post-promotion state (sender is now a worker → reject) or completes on pre-promotion authority (one last external send rides through mid-promotion). Implementers will pick differently. Fix: state the order — evaluate death, apply promotion, then evaluate the triggering operation against the new state — and add the regression test.

### MF-E — `pod appoint` is unconstrained (D3, R3, R16)

D3 lets the orchestrator "appoint leaders and successors" without saying from which population. Appointing a member of another pod would put that member in two pods, breaking R3's exclusive membership by operator action; appointing a non-member creates an unprovisioned leader with no token binding. Fix: `pod appoint` must require the appointee to be a roster member of that pod; state whether the appointment must follow the ranked succession order or may deviate deliberately (R16 fixes the order for auto-promotion; F5 says "from the roster" for done-succession — say which governs appoint).

## ADR-0003 — attacked and found defended

- **Forged death signal:** no CLI input asserts death; promotion reads `inspectProcess` only, over the engine-recorded identity. Solid — this is the right lesson from `task reap`.
- **Death rule (process-gone or pid-recycled only):** `ambiguous`/`unknown`/staleness/silence never promote; fail-closed matches AE1 and the W380 stale-reap lesson. Killing a leader to force succession is real but bounded (successor has own token) and correctly disclosed under the same-user model.
- **Worker external send / AE4:** pure-function `assertSendAllowed` inside the lock, post-auth, pre-mutation; directly unit-testable. Good.
- **R12 structural argument:** channel content can never be addressed to `orchestrator` (rule 2 names pods, rule 4 rejects the rest); `AwarenessEvent` has no text-capable field; awareness delivery reuses the transport but not the message payload. The argument holds.
- **Pod-name squatting:** orchestrator-only creation plus abort-on-foreign-roster-name closes the W380 follow-up #14 class by construction.
- **Busy-leader wedge:** staleness is a non-input; a live busy leader is never displaced (AE1), a provably dead one is displaced within one sweep.

## ADR-0003 — non-blocking observations (fix in implementation or disclose)

1. **R12 is mechanism-level, not operator-level.** Anyone who can read the state dir reads channel content in `state.json` directly — and the orchestrator-token holder is typically exactly that person. The ADR discloses this under "Orchestrator compromise"; the community README must repeat it plainly, or R12 will be misread as content confidentiality from the operator.
2. **Topic is a content-shaped field.** A leader can smuggle channel content to the awareness feed one channel-open at a time via `topic`. This is endpoint self-disclosure, not engine leakage, but a length/charset bound and a disclosure note would keep "awareness, not minutes" honest.
3. **Orchestrator token recovery is unspecified.** `orchestrator init` twice refuses (registered hash differs) — a lost token strands topology control permanently short of state surgery. Provide `orchestrator init --rotate` semantics for the local operator, or document the manual path.
4. **Role bookkeeping on promotion:** "update `pod.leader` and the member's role" should say *both* members — successor to leader, dead leader to worker — so no roster ever shows two leaders.
5. **Channel directionality:** rule 2 should state channels are bidirectional once open (B may send on A→B), else one-way readings will diverge.
6. **Awareness-feed spam:** nothing bounds channel open/close churn; the feed is append-only (plan OQ2). Note it with the retention work.
7. **D8 migration sequencing:** `state migrate` creates a pod, which requires an initialized orchestrator — state the required order (init → migrate) and confirm v1 messages/digests carry over as history.

## ADR-0001 — conditions (none block design soundness)

1. **Verify the herdr plugin CLI surface before marking Accepted.** The ADR's own open question is the real gate: `herdr plugin add/list/remove` is assumed. The defined fallback (abort with instructions) is correct; the ADR should not finalize "Proposed → Accepted" until the surface is confirmed or the fallback is exercised.
2. **Repair-path version direction:** "repair moves the plugin to the version the engine expects" sits next to "never silently downgrades". Say which wins when the engine is older than the active plugin (recommend: repair refuses downgrade and reports; upgrade the engine instead).
3. Non-blocking and well handled: non-TTY refusal with distinct exit 2; consent written last so failed installs leave no record; decline writes nothing; PATH-hijack disclosure with resolved-binary display; all mutations through herdr's own CLI. The three-write surface enumeration is exactly the right discipline.

## ADR-0002 — approve

Ownership split is right: engine owns identity, tokens, routing enforcement, and state; adapters own native mapping and never touch engine schema. Engine-refuses-unknown-`contractVersion`, fail-closed `toEngine`, adapter-scoped provisioning credentials, and "the adapter is not trusted to enforce the boundary" are the correct readings of the W380 lessons. One implementation-level note (not a condition): define the adapter credential's issuance and revocation in the implementing slice — the ADR fixes ownership, which is what an ADR should fix.

## Requirement coverage spot-check

R5/R9/R13/R15/R17 carry the security weight; each has mechanism (orchestrator-only creation; token-checked routing; process-fact-only promotion; no auto-close; field-by-field host-free schema with a credible third-host walkthrough). The two success-criteria suites (forgery cases, awareness reconstruction) map to testable behavior. Coverage is adequate once MF-A through MF-E are resolved in text.
