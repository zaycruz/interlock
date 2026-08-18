import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../../src/cli/index.js";
import { assertSendAllowed } from "../../src/coordination/pods.js";
import { coordinationStatePath, emptyCoordinationState, readCoordinationState } from "../../src/coordination/state.js";
import type { CoordinationState } from "../../src/coordination/types.js";

const NOW = "2026-08-18T00:00:00.000Z";

const stateDirs: string[] = [];
const originalStateDir = process.env.INTERLOCK_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalStateDir;
  while (stateDirs.length > 0) rmSync(stateDirs.pop()!, { recursive: true, force: true });
});

function isolatedState(): string {
  const directory = mkdtempSync(join(tmpdir(), "interlock-pods-boundary-test-"));
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

function writeTemplate(name: string, template: unknown): string {
  const file = join(process.env.INTERLOCK_STATE_DIR!, `template-${name}.json`);
  writeFileSync(file, JSON.stringify(template));
  return file;
}

function createPod(orchestratorToken: string, name: string, members: string[], leader = members[0]!, succession = [...members]): Map<string, string> {
  const created = json(runCli(["pod", "create", "--name", name, "--template", writeTemplate(name, { members, leader, succession }), "--orchestrator-token", orchestratorToken]));
  return new Map<string, string>(Object.entries(created.tokens as Record<string, string>));
}

function send(tokens: Map<string, string>, from: string, to: string, text = "hello"): ReturnType<typeof runCli> {
  return runCli(["send", "--from-pane", from, "--to-pane", to, "--token", tokens.get(from) ?? "forged-token", "--text", text]);
}

// Two pods: eng (leader wT:p1, worker wT:p2), ops (leader wQ:p1, worker wQ:p2).
function twoPods(): { orchestrator: string; tokens: Map<string, string> } {
  const orchestrator = initOrchestrator();
  const tokens = createPod(orchestrator, "eng", ["wT:p1", "wT:p2"]);
  for (const [member, token] of createPod(orchestrator, "ops", ["wQ:p1", "wQ:p2"])) tokens.set(member, token);
  tokens.set("orchestrator", orchestrator);
  return { orchestrator, tokens };
}

test("pod create provisions the roster, mints 256-bit tokens printed once, and emits pod-created", () => {
  isolatedState();
  const orchestrator = initOrchestrator();
  const created = json(runCli(["pod", "create", "--name", "eng", "--template", writeTemplate("eng", {
    members: ["wT:p1", "wT:p2", "wT:p3"],
    leader: "wT:p1",
    succession: ["wT:p1", "wT:p2", "wT:p3"],
  }), "--orchestrator-token", orchestrator]));

  assert.equal(created.ok, true);
  assert.equal(created.pod.name, "eng");
  assert.equal(created.pod.leader, "wT:p1");
  assert.equal(created.pod.status, "open");
  assert.deepEqual(created.pod.succession, ["wT:p1", "wT:p2", "wT:p3"]);
  assert.deepEqual(Object.keys(created.tokens).sort(), ["wT:p1", "wT:p2", "wT:p3"]);
  for (const token of Object.values(created.tokens) as string[]) assert.match(token, /^[a-f0-9]{64}$/);

  const raw = readFileSync(coordinationStatePath(), "utf8");
  for (const token of Object.values(created.tokens) as string[]) {
    assert.equal(raw.includes(token), false, "minted member tokens must never be persisted");
  }

  const state = readCoordinationState();
  assert.equal(state.pods.length, 1);
  assert.deepEqual(state.podMembers.map((member) => [member.member, member.role, member.process]), [
    ["wT:p1", "leader", null],
    ["wT:p2", "worker", null],
    ["wT:p3", "worker", null],
  ]);
  for (const member of state.podMembers) assert.equal(member.pod, "eng");
  assert.deepEqual(Object.keys(state.memberTokens).sort(), ["orchestrator", "wT:p1", "wT:p2", "wT:p3"]);

  assert.equal(state.awarenessEvents.length, 1);
  assert.equal(state.awarenessEvents[0]?.kind, "pod-created");
  assert.equal(state.awarenessEvents[0]?.pod, "eng");
  assert.deepEqual(state.awarenessEvents[0]?.members, ["wT:p1", "wT:p2", "wT:p3"]);
  assert.equal(state.awarenessEvents[0]?.member, "wT:p1");
});

test("pod create rejects a non-orchestrator token and an uninitialized orchestrator", () => {
  isolatedState();
  const template = writeTemplate("eng", { members: ["wT:p1"], leader: "wT:p1", succession: ["wT:p1"] });

  const uninitialized = runCli(["pod", "create", "--name", "eng", "--template", template, "--orchestrator-token", "whatever-token"]);
  assert.equal(uninitialized.exitCode, 1);
  assert.match(uninitialized.stderr, /orchestrator init/);

  initOrchestrator();
  json(runCli(["session", "register", "--pane", "wT:p9", "--token", "flat-member-token"]));
  const intruder = runCli(["pod", "create", "--name", "eng", "--template", template, "--orchestrator-token", "flat-member-token"]);
  assert.equal(intruder.exitCode, 1);
  assert.match(intruder.stderr, /does not authenticate/);
  assert.equal(readCoordinationState().pods.length, 0);
});

test("pod create aborts loudly on a roster name registered to a foreign token hash", () => {
  isolatedState();
  const orchestrator = initOrchestrator();
  json(runCli(["session", "register", "--pane", "wT:p2", "--token", "squatter-token-secret"]));

  const result = runCli(["pod", "create", "--name", "eng", "--template", writeTemplate("eng", {
    members: ["wT:p1", "wT:p2"],
    leader: "wT:p1",
    succession: ["wT:p1", "wT:p2"],
  }), "--orchestrator-token", orchestrator]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /wT:p2/);
  assert.match(result.stderr, /already registered/);

  // The abort is atomic: no pod, no members, no partial token provisioning.
  const state = readCoordinationState();
  assert.equal(state.pods.length, 0);
  assert.equal(state.podMembers.length, 0);
  assert.equal(state.memberTokens["wT:p1"], undefined);
});

test("pod create rejects a member already bound to another pod", () => {
  isolatedState();
  const orchestrator = initOrchestrator();
  createPod(orchestrator, "eng", ["wT:p1", "wT:p2"]);

  const result = runCli(["pod", "create", "--name", "ops", "--template", writeTemplate("ops", {
    members: ["wT:p2", "wQ:p1"],
    leader: "wQ:p1",
    succession: ["wQ:p1", "wT:p2"],
  }), "--orchestrator-token", orchestrator]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /wT:p2/);
  assert.match(result.stderr, /already belongs to pod eng/);
});

test("pod names are never reused, including closed pods", () => {
  isolatedState();
  const orchestrator = initOrchestrator();
  createPod(orchestrator, "eng", ["wT:p1", "wT:p2"]);

  const duplicate = runCli(["pod", "create", "--name", "eng", "--template", writeTemplate("eng-2", {
    members: ["wQ:p1"], leader: "wQ:p1", succession: ["wQ:p1"],
  }), "--orchestrator-token", orchestrator]);
  assert.equal(duplicate.exitCode, 1);
  assert.match(duplicate.stderr, /never reused/);

  json(runCli(["pod", "close", "--pod", "eng", "--orchestrator-token", orchestrator]));
  const closedReuse = runCli(["pod", "create", "--name", "eng", "--template", writeTemplate("eng-3", {
    members: ["wQ:p1"], leader: "wQ:p1", succession: ["wQ:p1"],
  }), "--orchestrator-token", orchestrator]);
  assert.equal(closedReuse.exitCode, 1);
  assert.match(closedReuse.stderr, /never reused/);
});

test("pod template validation rejects a missing leader, an empty roster, and succession outside the roster", () => {
  isolatedState();
  const orchestrator = initOrchestrator();

  const missingLeader = runCli(["pod", "create", "--name", "eng", "--template", writeTemplate("no-leader", {
    members: ["wT:p1", "wT:p2"], succession: ["wT:p1"],
  }), "--orchestrator-token", orchestrator]);
  assert.equal(missingLeader.exitCode, 1);
  assert.match(missingLeader.stderr, /leader/);

  const leaderOutsideRoster = runCli(["pod", "create", "--name", "eng", "--template", writeTemplate("bad-leader", {
    members: ["wT:p1", "wT:p2"], leader: "wT:p9", succession: ["wT:p1"],
  }), "--orchestrator-token", orchestrator]);
  assert.equal(leaderOutsideRoster.exitCode, 1);
  assert.match(leaderOutsideRoster.stderr, /leader/);

  const emptyRoster = runCli(["pod", "create", "--name", "eng", "--template", writeTemplate("empty", {
    members: [], leader: "wT:p1", succession: ["wT:p1"],
  }), "--orchestrator-token", orchestrator]);
  assert.equal(emptyRoster.exitCode, 1);
  assert.match(emptyRoster.stderr, /roster/);

  const successionOutside = runCli(["pod", "create", "--name", "eng", "--template", writeTemplate("bad-succession", {
    members: ["wT:p1", "wT:p2"], leader: "wT:p1", succession: ["wT:p1", "wT:p9"],
  }), "--orchestrator-token", orchestrator]);
  assert.equal(successionOutside.exitCode, 1);
  assert.match(successionOutside.stderr, /succession/);
  assert.match(successionOutside.stderr, /wT:p9/);

  const reserved = runCli(["pod", "create", "--name", "eng", "--template", writeTemplate("reserved", {
    members: ["orchestrator", "wT:p1"], leader: "wT:p1", succession: ["wT:p1"],
  }), "--orchestrator-token", orchestrator]);
  assert.equal(reserved.exitCode, 1);
  assert.match(reserved.stderr, /reserved/);

  assert.equal(readCoordinationState().pods.length, 0);
});

test("worker to worker inside the same pod delivers", () => {
  isolatedState();
  const { tokens } = twoPods();
  const sent = send(tokens, "wT:p2", "wT:p1", "intra-pod note");
  assert.equal(sent.exitCode, 0, sent.stderr);
  const inbox = json(runCli(["inbox", "--pane", "wT:p1", "--token", tokens.get("wT:p1")!, "--json"]));
  assert.equal(inbox.messages[0].text, "intra-pod note");
});

test("worker to another pod is rejected (AE4)", () => {
  isolatedState();
  const { tokens } = twoPods();
  const toWorker = send(tokens, "wT:p2", "wQ:p2");
  assert.equal(toWorker.exitCode, 1);
  assert.match(toWorker.stderr, /outside pod eng/);

  const toLeader = send(tokens, "wT:p2", "wQ:p1");
  assert.equal(toLeader.exitCode, 1);
  assert.match(toLeader.stderr, /outside pod eng/);

  assert.equal(readCoordinationState().messages.length, 0);
});

test("worker to orchestrator is rejected (AE4)", () => {
  isolatedState();
  const { tokens } = twoPods();
  const result = send(tokens, "wT:p2", "orchestrator", "status report");
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /orchestrator/);
  assert.equal(readCoordinationState().messages.length, 0);
});

test("leader to orchestrator non-channel report is allowed", () => {
  isolatedState();
  const { orchestrator, tokens } = twoPods();
  const sent = send(tokens, "wT:p1", "orchestrator", "weekly report");
  assert.equal(sent.exitCode, 0, sent.stderr);
  const inbox = json(runCli(["inbox", "--pane", "orchestrator", "--token", orchestrator, "--json"]));
  assert.equal(inbox.messages[0].text, "weekly report");
});

test("orchestrator can message a pod leader but never a worker", () => {
  isolatedState();
  const { tokens } = twoPods();
  const toLeader = send(tokens, "orchestrator", "wT:p1", "directive");
  assert.equal(toLeader.exitCode, 0, toLeader.stderr);

  const toWorker = send(tokens, "orchestrator", "wT:p2", "directive");
  assert.equal(toWorker.exitCode, 1);
  assert.match(toWorker.stderr, /pod leaders/);
});

test("leader to another pod's leader without a channel is rejected", () => {
  isolatedState();
  const { tokens } = twoPods();
  const result = send(tokens, "wT:p1", "wQ:p1", "cross-pod ask");
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /leader channel/);
  assert.equal(readCoordinationState().messages.length, 0);
});

test("pod close deletes member token hashes, persists history, and emits pod-closed", () => {
  isolatedState();
  const { orchestrator, tokens } = twoPods();
  json(send(tokens, "wT:p2", "wT:p1", "history to keep"));

  const closed = json(runCli(["pod", "close", "--pod", "eng", "--orchestrator-token", orchestrator]));
  assert.equal(closed.ok, true);
  assert.equal(closed.pod.status, "closed");
  assert.equal(typeof closed.pod.closedAt, "string");

  const state = readCoordinationState();
  const pod = state.pods.find((candidate) => candidate.name === "eng");
  assert.equal(pod?.status, "closed");
  assert.equal(state.memberTokens["wT:p1"], undefined);
  assert.equal(state.memberTokens["wT:p2"], undefined);
  assert.notEqual(state.memberTokens["wQ:p1"], undefined, "other pods keep their tokens");

  // History persists: pod record, member records, and messages survive the close.
  assert.equal(state.podMembers.filter((member) => member.pod === "eng").length, 2);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0]?.text, "history to keep");

  const closedEvent = state.awarenessEvents.find((event) => event.kind === "pod-closed");
  assert.equal(closedEvent?.pod, "eng");
  assert.deepEqual(closedEvent?.members, ["wT:p1", "wT:p2"]);

  const again = runCli(["pod", "close", "--pod", "eng", "--orchestrator-token", orchestrator]);
  assert.equal(again.exitCode, 1);
  assert.match(again.stderr, /already closed/);
});

test("pod close is orchestrator-only", () => {
  isolatedState();
  const { tokens } = twoPods();
  const result = runCli(["pod", "close", "--pod", "eng", "--orchestrator-token", tokens.get("wT:p1")!]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /does not authenticate/);
  assert.equal(readCoordinationState().pods.find((pod) => pod.name === "eng")?.status, "open");
});

test("a member of a closed pod cannot send", () => {
  isolatedState();
  const { orchestrator, tokens } = twoPods();
  json(runCli(["pod", "close", "--pod", "eng", "--orchestrator-token", orchestrator]));

  const intraPod = send(tokens, "wT:p2", "wT:p1");
  assert.equal(intraPod.exitCode, 1);

  const external = send(tokens, "wQ:p2", "wT:p1");
  assert.equal(external.exitCode, 1);
  assert.equal(readCoordinationState().messages.length, 0);
});

test("pod list and show are read-only views including closed pods", () => {
  isolatedState();
  const { orchestrator } = twoPods();
  json(runCli(["pod", "close", "--pod", "ops", "--orchestrator-token", orchestrator]));

  const before = readFileSync(coordinationStatePath(), "utf8");
  const listed = json(runCli(["pod", "list", "--json"]));
  assert.deepEqual(listed.pods.map((pod: any) => [pod.name, pod.status]), [["eng", "open"], ["ops", "closed"]]);

  const shown = json(runCli(["pod", "show", "--pod", "eng", "--json"]));
  assert.equal(shown.pod.leader, "wT:p1");
  assert.deepEqual(shown.members.map((member: any) => [member.member, member.role]), [["wT:p1", "leader"], ["wT:p2", "worker"]]);
  assert.equal(readFileSync(coordinationStatePath(), "utf8"), before);

  const missing = runCli(["pod", "show", "--pod", "nope"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /unknown pod/);
});

// The channel path of the routing decision is exercised directly against the
// D1 LeaderChannel type; the channel open/close commands land in slice 3.
function channelState(): CoordinationState {
  const state = emptyCoordinationState();
  state.pods.push(
    { name: "eng", createdAt: NOW, leader: "wT:p1", succession: ["wT:p1", "wT:p2"], status: "open", closedAt: null },
    { name: "ops", createdAt: NOW, leader: "wQ:p1", succession: ["wQ:p1", "wQ:p2"], status: "open", closedAt: null },
    { name: "old", createdAt: NOW, leader: "wX:p1", succession: ["wX:p1"], status: "closed", closedAt: NOW },
  );
  state.podMembers.push(
    { member: "wT:p1", pod: "eng", role: "leader", process: null, registeredAt: NOW },
    { member: "wT:p2", pod: "eng", role: "worker", process: null, registeredAt: NOW },
    { member: "wQ:p1", pod: "ops", role: "leader", process: null, registeredAt: NOW },
    { member: "wQ:p2", pod: "ops", role: "worker", process: null, registeredAt: NOW },
    { member: "wX:p1", pod: "old", role: "leader", process: null, registeredAt: NOW },
  );
  state.leaderChannels.push(
    { id: 1, fromPod: "eng", toPod: "ops", topic: "release", openedAt: NOW, closedAt: null, messageCount: 0 },
    { id: 2, fromPod: "eng", toPod: "ops", topic: "archive", openedAt: NOW, closedAt: NOW, messageCount: 4 },
  );
  return state;
}

test("assertSendAllowed allows leader-channel sends only between the channel endpoints while open", () => {
  const state = channelState();
  assert.doesNotThrow(() => assertSendAllowed(state, "wT:p1", "wQ:p1", 1));
  // Channels are bidirectional once open (ADR 0003 D4 rule 2).
  assert.doesNotThrow(() => assertSendAllowed(state, "wQ:p1", "wT:p1", 1));

  assert.throws(() => assertSendAllowed(state, "wT:p1", "wQ:p1"), /leader channel/);
  assert.throws(() => assertSendAllowed(state, "wT:p1", "wQ:p1", 2), /is closed/);
  assert.throws(() => assertSendAllowed(state, "wT:p1", "wQ:p1", 99), /unknown leader channel/);
  // A worker cannot ride a channel even when one is open between the pods.
  assert.throws(() => assertSendAllowed(state, "wT:p2", "wQ:p1", 1), /outside pod eng/);
  // A channel does not authorize a leader to bypass a worker address.
  assert.throws(() => assertSendAllowed(state, "wT:p1", "wQ:p2", 1), /leader/);
});

test("assertSendAllowed keeps the orchestrator off channels and out of worker reach", () => {
  const state = channelState();
  assert.doesNotThrow(() => assertSendAllowed(state, "wT:p1", "orchestrator"));
  assert.doesNotThrow(() => assertSendAllowed(state, "orchestrator", "wT:p1"));
  assert.throws(() => assertSendAllowed(state, "wT:p1", "orchestrator", 1), /orchestrator/);
  assert.throws(() => assertSendAllowed(state, "orchestrator", "wT:p1", 1), /orchestrator/);
  assert.throws(() => assertSendAllowed(state, "orchestrator", "wT:p2"), /pod leaders/);
  assert.throws(() => assertSendAllowed(state, "orchestrator", "orchestrator"), /pod leaders/);
});

test("assertSendAllowed rejects members in no pod and members of closed pods", () => {
  const state = channelState();
  assert.throws(() => assertSendAllowed(state, "wZ:p1", "wT:p1"), /not in a pod/);
  assert.throws(() => assertSendAllowed(state, "wT:p1", "wZ:p1"), /not in a pod/);
  assert.throws(() => assertSendAllowed(state, "wX:p1", "wT:p1"), /closed/);
  assert.throws(() => assertSendAllowed(state, "wT:p1", "wX:p1", 2), /closed/);
});
