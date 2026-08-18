import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../../src/cli/index.js";
import { currentProcessIdentity, inspectProcess } from "../../src/core/process-identity.js";
import { emptyCoordinationState, readCoordinationState, writeCoordinationState } from "../../src/coordination/state.js";
import type { CoordinationState } from "../../src/coordination/types.js";
import type { ProcessIdentity } from "../../src/core/types.js";

const NOW = "2026-08-18T00:00:00.000Z";

const stateDirs: string[] = [];
const originalStateDir = process.env.INTERLOCK_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalStateDir;
  while (stateDirs.length > 0) rmSync(stateDirs.pop()!, { recursive: true, force: true });
});

function isolatedState(): string {
  const directory = mkdtempSync(join(tmpdir(), "interlock-pods-succession-test-"));
  stateDirs.push(directory);
  process.env.INTERLOCK_STATE_DIR = directory;
  return directory;
}

function json(result: ReturnType<typeof runCli>): any {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function initOrchestrator(): string {
  return json(runCli(["orchestrator", "init"])).token as string;
}

function createPod(orchestrator: string, name: string, members: string[], leader = members[0]!, succession = [...members]): Map<string, string> {
  const template = join(process.env.INTERLOCK_STATE_DIR!, `template-${name}.json`);
  writeFileSync(template, JSON.stringify({ members, leader, succession }));
  const created = json(runCli(["pod", "create", "--name", name, "--template", template, "--orchestrator-token", orchestrator]));
  return new Map<string, string>(Object.entries(created.tokens as Record<string, string>));
}

// Two pods: eng (leader wT:p1, workers wT:p2, wT:p3) and ops (leader wQ:p1,
// worker wQ:p2), plus the orchestrator token.
function twoPods(): { orchestrator: string; tokens: Map<string, string> } {
  const orchestrator = initOrchestrator();
  const tokens = createPod(orchestrator, "eng", ["wT:p1", "wT:p2", "wT:p3"]);
  for (const [member, token] of createPod(orchestrator, "ops", ["wQ:p1", "wQ:p2"])) tokens.set(member, token);
  tokens.set("orchestrator", orchestrator);
  return { orchestrator, tokens };
}

function send(tokens: Map<string, string>, from: string, to: string, text = "hello"): ReturnType<typeof runCli> {
  return runCli(["send", "--from-pane", from, "--to-pane", to, "--token", tokens.get(from) ?? "forged-token", "--text", text]);
}

function liveIdentity(): ProcessIdentity {
  return currentProcessIdentity();
}

// A verifiably dead identity: a pid the OS has never run, so it stays absent
// for the whole test with no recycle window. (A really-spawned-then-exited pid
// is reaped immediately under spawnSync and the OS recycles it within
// milliseconds, landing the identity on a live process — mismatched, not
// dead — which is honest AE2 coverage but the wrong signal here.) Death
// verification reads the pid's absence; the start time is only compared when
// the pid is alive.
let unusedPid = 0;
function deadIdentity(): ProcessIdentity {
  if (unusedPid === 0) unusedPid = 900000 + Math.floor(Math.random() * 9999);
  // Retry past the (rare) case where a drawn pid happens to sit on a live
  // process; the assertion is the point of the fixture, so keep drawing until
  // the identity verifiably reads dead.
  for (;;) {
    const identity = { pid: unusedPid++, startedAt: "ps:recorded-at-exit" };
    if (inspectProcess(identity) === "dead") return identity;
  }
}

// Pid-recycle proof without an OS race: the recorded identity holds a live pid
// but a start time that no longer matches the live process — exactly the
// mismatch the engine must treat as death (AE2).
function mismatchedLiveIdentity(): ProcessIdentity {
  const identity = liveIdentity();
  return { pid: identity.pid, startedAt: `${identity.startedAt}:recycled` };
}

// Seed a member's recorded process identity directly, the way the engine's
// registration-time bind (D2 step 4) would have persisted it for a member
// process that has since exited. The CLI bind path itself is live-only.
function bindMember(tokens: Map<string, string>, member: string, identity: ProcessIdentity): void {
  void tokens;
  const state = readCoordinationState();
  const record = state.podMembers.find((candidate) => candidate.member === member);
  assert.ok(record !== undefined, `member ${member} must exist to seed an identity`);
  record.process = identity;
  writeCoordinationState(state);
}

function podLeader(name: string): string | undefined {
  return readCoordinationState().pods.find((pod) => pod.name === name)?.leader;
}

// Seed an open leader channel the way slice 3's channel-open command will
// record it, so leader-done's channel closure can be verified end to end.
function seedOpenChannel(fromPod: string, toPod: string, topic: string, messageCount = 0): void {
  const state = readCoordinationState();
  state.leaderChannels.push({ id: state.nextChannelId++, fromPod, toPod, topic, openedAt: NOW, closedAt: null, messageCount });
  writeCoordinationState(state);
}

test("a leader whose process is alive and silent is never promoted (AE1)", () => {
  isolatedState();
  const { tokens } = twoPods();
  bindMember(tokens, "wT:p1", liveIdentity());

  // Staleness is not death: the busy leader never checks in, and both the
  // watch sweep and lazy send-time evaluation must leave it in place.
  json(send(tokens, "wT:p2", "wT:p3", "steady state"));
  json(runCli(["watch", "--once"]));

  assert.equal(podLeader("eng"), "wT:p1");
  const events = readCoordinationState().awarenessEvents;
  assert.equal(events.some((event) => event.kind === "leader-death-verified" || event.kind === "leader-promoted"), false);
});

test("a verified-dead leader is auto-promoted in ranked order on the next send (R13, R16)", () => {
  isolatedState();
  const { tokens } = twoPods();
  bindMember(tokens, "wT:p1", deadIdentity());
  bindMember(tokens, "wT:p2", liveIdentity());

  const sent = send(tokens, "wT:p2", "wT:p3", "first send after leader death");
  assert.equal(sent.exitCode, 0, sent.stderr);

  const state = readCoordinationState();
  assert.equal(podLeader("eng"), "wT:p2");
  assert.deepEqual(state.podMembers.filter((member) => member.pod === "eng").map((member) => [member.member, member.role]), [
    ["wT:p1", "worker"],
    ["wT:p2", "leader"],
    ["wT:p3", "worker"],
  ]);
  assert.equal(state.memberTokens["wT:p1"], undefined, "the dead leader's token must be deleted (MF-B)");
  assert.notEqual(state.memberTokens["wT:p2"], undefined);

  const death = state.awarenessEvents.find((event) => event.kind === "leader-death-verified");
  assert.equal(death?.pod, "eng");
  assert.equal(death?.member, "wT:p1");
  const promotion = state.awarenessEvents.find((event) => event.kind === "leader-promoted");
  assert.equal(promotion?.pod, "eng");
  assert.equal(promotion?.member, "wT:p2");
});

test("the watch sweep also promotes a verified-dead leader", () => {
  isolatedState();
  const { tokens } = twoPods();
  bindMember(tokens, "wT:p1", deadIdentity());
  bindMember(tokens, "wT:p2", liveIdentity());

  json(runCli(["watch", "--once"]));

  assert.equal(podLeader("eng"), "wT:p2");
  const state = readCoordinationState();
  assert.equal(state.awarenessEvents.some((event) => event.kind === "leader-death-verified" && event.member === "wT:p1"), true);
  assert.equal(state.awarenessEvents.some((event) => event.kind === "leader-promoted" && event.member === "wT:p2"), true);
});

test("a pid recycled to a different start time is treated as death and promotes (AE2)", () => {
  isolatedState();
  const { tokens } = twoPods();
  const mismatched = mismatchedLiveIdentity();
  assert.equal(inspectProcess(mismatched), "mismatched", "the seeded identity must verify as a recycled pid");
  bindMember(tokens, "wT:p1", mismatched);
  bindMember(tokens, "wT:p2", liveIdentity());

  json(send(tokens, "wT:p3", "wT:p2"));

  const state = readCoordinationState();
  assert.equal(podLeader("eng"), "wT:p2");
  assert.equal(state.memberTokens["wT:p1"], undefined);
});

test("succession walks down the ranked order when multiple leaders die (R16)", () => {
  isolatedState();
  const { tokens } = twoPods();
  bindMember(tokens, "wT:p1", deadIdentity());
  bindMember(tokens, "wT:p2", liveIdentity());
  json(send(tokens, "wT:p2", "wT:p3", "promote wT:p2"));

  bindMember(tokens, "wT:p2", deadIdentity());
  bindMember(tokens, "wT:p3", liveIdentity());
  json(send(tokens, "wT:p3", "wT:p2", "promote wT:p3"));

  const state = readCoordinationState();
  assert.equal(podLeader("eng"), "wT:p3");
  assert.equal(state.memberTokens["wT:p1"], undefined);
  assert.equal(state.memberTokens["wT:p2"], undefined);
  assert.notEqual(state.memberTokens["wT:p3"], undefined);
  const promotions = state.awarenessEvents.filter((event) => event.kind === "leader-promoted");
  assert.deepEqual(promotions.map((event) => event.member), ["wT:p2", "wT:p3"]);
});

test("a dead successor is skipped for the next ranked live member (R16)", () => {
  isolatedState();
  const { tokens } = twoPods();
  bindMember(tokens, "wT:p1", deadIdentity());
  bindMember(tokens, "wT:p2", deadIdentity());
  bindMember(tokens, "wT:p3", liveIdentity());

  json(send(tokens, "wT:p3", "wT:p2", "trigger"));

  const state = readCoordinationState();
  assert.equal(podLeader("eng"), "wT:p3");
  assert.equal(state.awarenessEvents.filter((event) => event.kind === "leader-promoted").length, 1);
});

test("when every candidate is dead the pod keeps its roster, loses reach, and waits for the orchestrator", () => {
  isolatedState();
  const { tokens } = twoPods();
  // The leader is bound and verifiably dead; both successors are bound to
  // dead identities too, so every ranked candidate fails verification and
  // nothing can promote.
  bindMember(tokens, "wT:p1", deadIdentity());
  bindMember(tokens, "wT:p2", deadIdentity());
  bindMember(tokens, "wT:p3", deadIdentity());
  bindMember(tokens, "wQ:p1", liveIdentity());

  // The engine records the death and leaves the pod leaderless in place;
  // routing into the leaderless pod is rejected, and nothing closes (R15).
  const sent = runCli(["send", "--from-pane", "wQ:p1", "--to-pane", "wT:p1", "--token", tokens.get("wQ:p1")!, "--text", "anybody home"]);
  assert.equal(sent.exitCode, 1);

  const state = readCoordinationState();
  assert.equal(state.awarenessEvents.some((event) => event.kind === "leader-death-verified" && event.member === "wT:p1"), true);
  assert.equal(state.awarenessEvents.some((event) => event.kind === "leader-promoted"), false);
  assert.equal(state.pods.find((pod) => pod.name === "eng")?.status, "open");
  assert.equal(state.podMembers.filter((member) => member.pod === "eng").length, 3);
  assert.equal(state.messages.length, 0);
});

test("an unbound leader cannot be verified dead, so nothing promotes", () => {
  isolatedState();
  const { tokens } = twoPods();

  json(send(tokens, "wT:p2", "wT:p1"));

  assert.equal(podLeader("eng"), "wT:p1");
});

test("the triggering send is re-evaluated as a worker after its own pod's promotion (MF-B, MF-D)", () => {
  isolatedState();
  const { tokens } = twoPods();
  bindMember(tokens, "wT:p1", deadIdentity());
  bindMember(tokens, "wT:p2", liveIdentity());
  bindMember(tokens, "wQ:p1", liveIdentity());

  // Token authentication precedes the pre-send seam, so the dead leader's
  // copied token still authenticates this one send; the seam then promotes
  // wT:p2 and re-evaluates the sender as a worker, whose external reach is
  // rejected. No external send rides through mid-promotion on the stale role.
  const external = send(tokens, "wT:p1", "wQ:p1");
  assert.equal(external.exitCode, 1);
  assert.match(external.stderr, /worker wT:p1 cannot send outside pod eng/);
  assert.equal(podLeader("eng"), "wT:p2");

  // The same locked mutation deleted the dead leader's token hash (MF-B): the
  // next send with the copied token fails authentication outright.
  const intra = send(tokens, "wT:p1", "wT:p3");
  assert.equal(intra.exitCode, 1);
  assert.match(intra.stderr, /not registered/);
});

test("the promoted successor immediately has the pod's external reach", () => {
  isolatedState();
  const { tokens } = twoPods();
  bindMember(tokens, "wT:p1", deadIdentity());
  bindMember(tokens, "wT:p2", liveIdentity());

  // wT:p1 dies holding the pod's reach; an orchestrator directive to the dead
  // leader's name is rejected (the recipient is a worker now), and the same
  // directive to the promoted successor routes.
  const stale = send(tokens, "orchestrator", "wT:p1", "stale directive");
  assert.equal(stale.exitCode, 1);
  assert.match(stale.stderr, /pod leaders/);

  const directive = send(tokens, "orchestrator", "wT:p2", "you lead now");
  assert.equal(directive.exitCode, 0, directive.stderr);

  const state = readCoordinationState();
  assert.equal(podLeader("eng"), "wT:p2");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.toPane, "wT:p2");
});

test("pod bind records a process identity for a roster member and is token-checked", () => {
  isolatedState();
  const { tokens } = twoPods();
  const identity = liveIdentity();

  const forged = runCli(["pod", "bind", "--member", "wT:p2", "--token", "forged-token", "--identity-pid", String(identity.pid), "--identity-started-at", identity.startedAt]);
  assert.equal(forged.exitCode, 1);
  assert.match(forged.stderr, /does not authenticate/);

  const outsider = runCli(["pod", "bind", "--member", "wT:p9", "--token", tokens.get("wT:p1")!, "--identity-pid", String(identity.pid), "--identity-started-at", identity.startedAt]);
  assert.equal(outsider.exitCode, 1);
  assert.match(outsider.stderr, /not registered/);

  const bound = json(runCli(["pod", "bind", "--member", "wT:p2", "--token", tokens.get("wT:p2")!, "--identity-pid", String(identity.pid), "--identity-started-at", identity.startedAt]));
  assert.equal(bound.member.member, "wT:p2");
  const member = readCoordinationState().podMembers.find((candidate) => candidate.member === "wT:p2");
  assert.deepEqual(member?.process, identity);
});

test("pod unbind clears the process identity and is token-checked", () => {
  isolatedState();
  const { tokens } = twoPods();
  json(runCli(["pod", "bind", "--member", "wT:p2", "--token", tokens.get("wT:p2")!, "--identity-pid", String(liveIdentity().pid), "--identity-started-at", liveIdentity().startedAt]));

  const forged = runCli(["pod", "unbind", "--member", "wT:p2", "--token", "forged-token"]);
  assert.equal(forged.exitCode, 1);
  assert.match(forged.stderr, /does not authenticate/);

  const unbound = json(runCli(["pod", "unbind", "--member", "wT:p2", "--token", tokens.get("wT:p2")!]));
  assert.equal(unbound.ok, true);
  const member = readCoordinationState().podMembers.find((candidate) => candidate.member === "wT:p2");
  assert.equal(member?.process, null);
});

test("rebind follows a legitimate restart: the dead identity is replaced by the caller's own pid (MF-A)", () => {
  isolatedState();
  const { tokens } = twoPods();
  bindMember(tokens, "wT:p1", deadIdentity());

  // No --pid flag exists: the rebind binds the calling process's own identity,
  // captured engine-side, so a stolen token cannot pin a foreign process.
  const rebound = json(runCli(["pod", "rebind", "--member", "wT:p1", "--token", tokens.get("wT:p1")!]));
  assert.equal(rebound.ok, true);
  const member = readCoordinationState().podMembers.find((candidate) => candidate.member === "wT:p1");
  assert.deepEqual(member?.process, liveIdentity());

  // The rebound leader is alive: the sweep and lazy evaluation leave it alone.
  json(runCli(["watch", "--once"]));
  json(send(tokens, "wT:p2", "wT:p3"));
  assert.equal(podLeader("eng"), "wT:p1");
});

test("rebind refuses while the recorded identity is still alive and names no other process", () => {
  isolatedState();
  const { tokens } = twoPods();
  bindMember(tokens, "wT:p1", liveIdentity());

  const alive = runCli(["pod", "rebind", "--member", "wT:p1", "--token", tokens.get("wT:p1")!]);
  assert.equal(alive.exitCode, 1);
  assert.match(alive.stderr, /still alive/);

  // There is no flag to name another process: the rebind surface has no --pid.
  const named = runCli(["pod", "rebind", "--member", "wT:p1", "--token", tokens.get("wT:p1")!, "--pid", "1"]);
  assert.equal(named.exitCode, 1);
});

test("leader done emits leader-done, keeps role and token, and fires no promotion (AE3, R14)", () => {
  isolatedState();
  const { tokens } = twoPods();
  bindMember(tokens, "wT:p1", liveIdentity());

  const done = json(runCli(["session", "set", "--pane", "wT:p1", "--token", tokens.get("wT:p1")!, "--state", "done"]));
  assert.equal(done.ok, true);

  const state = readCoordinationState();
  const pod = state.pods.find((candidate) => candidate.name === "eng");
  assert.equal(pod?.leader, "wT:p1", "leader done must not trigger auto-promotion (R14)");
  assert.equal(state.podMembers.find((member) => member.member === "wT:p1")?.role, "leader");
  assert.notEqual(state.memberTokens["wT:p1"], undefined, "leader done never deletes the leader's token");
  assert.equal(state.awarenessEvents.some((event) => event.kind === "leader-done" && event.pod === "eng" && event.member === "wT:p1"), true);
  assert.equal(state.awarenessEvents.some((event) => event.kind === "leader-promoted" || event.kind === "leader-death-verified"), false);

  // Intra-pod reach survives while the pod waits for the orchestrator.
  const intra = send(tokens, "wT:p1", "wT:p2", "wrapping up notes");
  assert.equal(intra.exitCode, 0, intra.stderr);
});

test("leader done closes its open channels with message counts recorded (MF-C)", () => {
  isolatedState();
  const { tokens } = twoPods();
  bindMember(tokens, "wT:p1", liveIdentity());
  bindMember(tokens, "wQ:p1", liveIdentity());

  seedOpenChannel("eng", "ops", "release", 2);

  json(runCli(["session", "set", "--pane", "wT:p1", "--token", tokens.get("wT:p1")!, "--state", "done"]));

  const state = readCoordinationState();
  const channel = state.leaderChannels.find((candidate) => candidate.fromPod === "eng" && candidate.toPod === "ops");
  assert.notEqual(channel?.closedAt, null);
  assert.equal(channel?.messageCount, 2);
  const closed = state.awarenessEvents.find((event) => event.kind === "channel-closed");
  assert.equal(closed?.fromPod, "eng");
  assert.equal(closed?.toPod, "ops");
  assert.equal(closed?.messageCount, 2);
});

test("a worker reporting done keeps full power: no awareness event, no channel impact", () => {
  isolatedState();
  const { tokens } = twoPods();
  bindMember(tokens, "wT:p1", liveIdentity());
  seedOpenChannel("eng", "ops", "release");

  json(runCli(["session", "set", "--pane", "wT:p2", "--token", tokens.get("wT:p2")!, "--state", "done"]));

  const state = readCoordinationState();
  assert.equal(state.awarenessEvents.some((event) => event.kind === "leader-done"), false);
  const channel = state.leaderChannels.find((candidate) => candidate.fromPod === "eng");
  assert.equal(channel?.closedAt, null);
});

test("pod show lists live process bindings for the operator", () => {
  isolatedState();
  const { tokens } = twoPods();
  const identity = liveIdentity();
  json(runCli(["pod", "bind", "--member", "wT:p2", "--token", tokens.get("wT:p2")!, "--identity-pid", String(identity.pid), "--identity-started-at", identity.startedAt]));

  const shown = json(runCli(["pod", "show", "--pod", "eng", "--json"]));
  const bound = shown.members.find((member: any) => member.member === "wT:p2");
  assert.deepEqual(bound.process, identity);
});
