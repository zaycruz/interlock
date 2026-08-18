# ADR-0002: Host adapter boundary

- Status: Accepted (QA adversarial architecture review PASS, verdict #643; head-office ratification #649, 2026-08-18)
- Date: 2026-08-17
- Deciders: interlock team
- Sources: `DIRECTIVE.md` ("Community release, 2026-08-17"), pods plan Product
  Contract R4, R17, R19, R20, repo `AGENTS.md`

## Context

Pods and members are engine primitives. Herdr is the first host; BB IDE is
scheduled for v0.0.2; unknown hosts come after. The engine schema must carry
no host-specific fields (R17), BB IDE must land as an adapter with zero
engine changes (R19), and the herdr plugin must map pod→herdr space and
member→initialized pane (R20). The engine needs a single, versioned boundary
that every host adapter implements. Today the only adapter-shaped code is
`src/coordination/space-adapter.ts`, an in-process convenience wrapper that
translates `space.js` call shapes into coordination CLI invocations. It is
herdr-specific code living inside the engine — exactly what this boundary
must end.

## Decision

### The adapter contract

A host adapter is a module that implements one TypeScript interface,
`HostAdapter`, exported from the engine at `interlock/coordination` as a
type-only contract. The engine never imports an adapter; adapters import the
engine.

```ts
interface HostAdapter {
  readonly host: string;              // "herdr", "bb-ide", ...
  readonly contractVersion: 1;        // adapter contract version, see Upgrades

  // Identity mapping: native identity -> engine member.
  // Provisions the member and returns its pod-scoped token.
  provisionMember(native: NativeIdentity, pod: PodName): MemberHandle;
  revokeMember(member: MemberHandle): void;

  // Group mapping: native group -> engine pod.
  // Materializes a pod from a template via the orchestrator.
  materializePod(native: NativeGroup, template: PodTemplate): PodHandle;
  releasePod(pod: PodHandle): void;

  // Event translation, both directions.
  toEngine(event: NativeEvent): EngineEvent | null;   // null = not ours
  fromEngine(event: AwarenessEvent | Delivery): NativeEffect;
}
```

The engine side of the boundary is a small set of engine-owned operations the
adapter calls: create pod (orchestrator only), register member into pod,
mint/revoke member token, send/route message, subscribe to deliveries and
the awareness feed. The adapter side is everything native: herdr spaces and
panes, BB IDE agent threads, lifecycle hooks, UI.

Ownership split:

- **Engine owns:** pods, members, the roster, succession order, tokens and
  their hashes, routing enforcement (R9), the awareness feed, all durable
  state. The engine schema contains no host fields — no `pane`, no `space`,
  no `threadId`.
- **Adapter owns:** the native↔engine mapping table (native identity →
  member name), native lifecycle, and native-side persistence of that
  mapping. The mapping is adapter state, never engine state.

### Module layout

- Engine: `src/coordination/host-adapter.ts` — the interface and contract
  version only. No herdr identifiers. Repo `AGENTS.md` module rule stands:
  core/beads/cli/pi/coordination stay host-free.
- Herdr plugin: separate package `@raava/interlock-plugin-herdr` (installed
  per ADR-0001). It contains the herdr adapter implementation and the moved
  `space-adapter.ts` transport.
- BB IDE plugin (v0.0.2): separate package, same contract, no engine change
  — this is the executable proof of R17 (R19).

### Evolution of `space-adapter.ts`

`src/coordination/space-adapter.ts` moves out of the engine into the herdr
plugin package. Its pane/token call shapes become the herdr adapter's
transport layer; its vocabulary translates at the boundary (`pane` →
`member`, `workspace` → pod-scoped context). The engine keeps only the
`HostAdapter` type. Per repo `AGENTS.md`, no backward-compatibility shim is
kept: the coordination CLI stays the stable surface, and `space.js` migrates
to the plugin package in the same release.

### Third-host walkthrough (required by the Product Contract)

Hypothetical host "Gridline", a CI runner fleet that does not exist today.
Adoption steps:

1. Author `gridline-interlock-adapter`, a package that imports
   `interlock/coordination` and implements `HostAdapter` with
   `host: "gridline"`.
2. Map a Gridline runner to a member: `provisionMember` with the runner's
   native ID. Map a Gridline job group to a pod: `materializePod` with an
   engine template. No engine schema is read or written by these calls —
   the adapter only names members and pods.
3. Translate Gridline's job events into engine events in `toEngine`; render
   deliveries into Gridline's log stream in `fromEngine`.
4. Run the engine's published adapter conformance suite (token-checked
   routing rejections, boundary cases AE4/AE6, token revocation) against the
   adapter.

At no step does Gridline touch `src/`, the pod schema, or the coordination
state format. If a step had required a new engine field, R17 would be
violated and the design — not the host — would be at fault. BB IDE in v0.0.2
repeats this walkthrough against real documentation (OQ1).

## Alternatives considered

- **Adapters as engine plugins loaded by the engine (in-process).** Rejected.
  The engine would import host code, re-coupling release cycles and putting
  host bugs inside the engine's process and trust boundary. The CLI/IPC
  surface already exists and is tested; the engine stays smaller.
- **Keep `space-adapter.ts` in the engine as a permanent herdr shim.**
  Rejected. It is herdr code in the engine, violating the module rule, and
  every future host would demand the same favor. The contract-type-only
  module is strictly smaller.
- **Host fields on the pod schema behind a generic `labels` map.** Rejected.
  A `labels` escape hatch is a host-specific field with extra steps; it
  invites herdr-only semantics to leak into engine routing. Native mapping
  lives in adapter state instead.
- **Adapter-owned token storage (adapter keeps the token database).**
  Rejected. Tokens authenticate members to the engine; the engine must be
  the sole issuer and verifier, or a confused adapter becomes a mint.

## Security considerations

- **Token provisioning at the boundary.** Only the engine mints member
  tokens, and only through the orchestrator-scoped provisioning operation
  (R5). An adapter receives a provisioning credential scoped to the pods it
  materialized; it cannot register members into foreign pods and cannot call
  orchestrator operations outside `materializePod`/`releasePod`. Member
  tokens are delivered to the member's native identity and are visible to
  the provisioning adapter — this is inherent and disclosed — but the
  adapter never sees tokens of members it did not provision.
- **Adapter spoofing scope.** A process impersonating an adapter still needs
  that adapter's credential, and holding it grants only that adapter's
  scope: its pods, its members. It cannot mint tokens for other pods, cannot
  read the awareness feed beyond its scope, and cannot forge a death signal
  — succession promotion requires engine-verified process death (R13), which
  no adapter message can assert. The worst case is a confused-deputy within
  one host's own namespace.
- **Forgery paths carried over from W380.** Pane-name squatting closed for
  pods by construction (R5: only the orchestrator creates pods). Worker
  external-send forgery is rejected by token-checked routing (R9) regardless
  of what the adapter asks — the adapter is not trusted to enforce the
  boundary; the engine is.
- **Adapter state is untrusted input.** The native↔member mapping file is
  plaintext, same-user, like all interlock state (README threat-model
  disclosure). A corrupted mapping causes misdelivery the engine detects at
  the token check, not silent privilege gain.
- **Event translation is fail-closed.** `toEngine` returning garbage is a
  validation error at the engine edge, not a partial mutation; unknown
  native events map to `null`, never to a default engine action.

## Upgrade compatibility

- The contract carries an integer `contractVersion`. The engine refuses an
  adapter declaring an unknown version with an explicit error; it never
  silently misinterprets one. Version 1 is defined by this ADR.
- Engine and plugin packages version in lockstep for v0.0.x (ADR-0001);
  independent adapter versioning starts only when contract version 2 exists.
- Engine state schema (`CoordinationState.version`) evolves independently of
  the adapter contract; adapters hold no engine-schema state, so engine
  migrations never strand an adapter.
- Per repo policy, no backward-compatibility shims: breaking contract
  changes bump `contractVersion`, and old adapters fail loudly at load.

## Open questions

- OQ1 (BB IDE plugin surface) blocks only the v0.0.2 instance of this
  contract, not the contract itself.
- Whether `provisionMember` is one call or a register-then-activate pair is
  left to the implementing slice; the ADR fixes the ownership, not the call
  arity.
