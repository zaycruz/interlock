import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../../src/cli/index.js";
import { coordinationStatePath, emptyCoordinationState, readCoordinationState, writeCoordinationState } from "../../src/coordination/state.js";
import { assertMemberToken } from "../../src/coordination/state.js";

const NOW = "2026-08-18T00:00:00.000Z";

const stateDirs: string[] = [];
const originalStateDir = process.env.INTERLOCK_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalStateDir;
  while (stateDirs.length > 0) rmSync(stateDirs.pop()!, { recursive: true, force: true });
});

function isolatedState(): string {
  const directory = mkdtempSync(join(tmpdir(), "interlock-pods-test-"));
  stateDirs.push(directory);
  process.env.INTERLOCK_STATE_DIR = directory;
  return directory;
}

function json(result: ReturnType<typeof runCli>): any {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }

function legacyState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    nextMessageId: 3,
    nextDigestId: 2,
    paneTokens: { "wT:p1": hash("legacy-token-wt-p1-secret"), "wT:p2": hash("legacy-token-wt-p2-secret") },
    tasks: [{ id: "T1", title: "Legacy task", businessValue: "history", workspace: null, ownerPane: null, stage: "open", claimer: null, blocker: null, createdAt: NOW, lastProgressAt: NOW, revision: 1 }],
    messages: [
      { id: 1, threadId: 1, replyTo: null, fromPane: "wT:p1", toPane: "wT:p2", workspace: null, text: "legacy one", state: "handled", claimer: null, createdAt: NOW },
      { id: 2, threadId: 2, replyTo: null, fromPane: "wT:p2", toPane: "wT:p1", workspace: null, text: "legacy two", state: "queued", claimer: null, createdAt: NOW },
    ],
    sessions: [{ pane: "wT:p1", state: "idle", lastSeenAt: NOW }],
    digests: [{ id: 1, pane: "wT:p1", messageIds: [1], reason: "watcher-heartbeat", createdAt: NOW, file: join(process.env.INTERLOCK_STATE_DIR ?? "", "deliveries", "wT:p1", "digest-1.json") }],
    lastWatchAt: NOW,
    ...overrides,
  };
}

test("version-1 state is hard-refused with a message naming the state migrate escape", () => {
  isolatedState();
  writeFileSync(coordinationStatePath(), JSON.stringify({ version: 1, paneTokens: {}, messages: [] }));

  assert.throws(() => readCoordinationState(), /state migrate/);
  assert.throws(() => readCoordinationState(), /orchestrator init/);

  const listed = runCli(["task", "list"]);
  assert.equal(listed.exitCode, 1);
  assert.match(listed.stderr, /state migrate/);
});

test("versionless legacy state is hard-refused with the same migrate message", () => {
  isolatedState();
  writeFileSync(coordinationStatePath(), JSON.stringify({ nextMessageId: 1, messages: [] }));

  assert.throws(() => readCoordinationState(), /state migrate/);
});

test("version-2 state round-trips pods, members, channels, awareness events, and member tokens", () => {
  isolatedState();
  const state = emptyCoordinationState();
  assert.equal(state.version, 2);
  state.memberTokens["wT:p1"] = hash("token-wt-p1-secret");
  state.pods.push({ name: "eng", createdAt: NOW, leader: "wT:p1", succession: ["wT:p1", "wT:p2"], status: "open", closedAt: null });
  state.podMembers.push(
    { member: "wT:p1", pod: "eng", role: "leader", process: { pid: 123, startedAt: "linux:456" }, registeredAt: NOW, diedAt: null, doneAt: null },
    { member: "wT:p2", pod: "eng", role: "worker", process: null, registeredAt: NOW, diedAt: null, doneAt: null },
  );
  state.leaderChannels.push({ id: 1, fromPod: "eng", toPod: "ops", topic: "release coordination", openedAt: NOW, closedAt: null, messageCount: 3 });
  state.awarenessEvents.push({ id: 1, kind: "pod-created", createdAt: NOW, pod: "eng", members: ["wT:p1", "wT:p2"] });
  state.orchestrator = { initializedAt: NOW };
  state.nextChannelId = 2;
  state.nextAwarenessEventId = 2;
  writeCoordinationState(state);

  assert.deepEqual(readCoordinationState(), state);
});

test("corrupt member token hashes refuse loudly", () => {
  isolatedState();
  writeFileSync(coordinationStatePath(), JSON.stringify({ version: 2, memberTokens: { "wT:p1": "not-a-hash" } }));

  assert.throws(() => readCoordinationState(), /member token hash/);
});

test("corrupt pod and member records refuse loudly", () => {
  isolatedState();
  writeFileSync(coordinationStatePath(), JSON.stringify({
    version: 2,
    pods: [{ name: "eng", createdAt: NOW, leader: "wT:p1", succession: ["wT:p1"], status: "weird", closedAt: null }],
  }));
  assert.throws(() => readCoordinationState(), /pod eng status is corrupt/);

  writeFileSync(coordinationStatePath(), JSON.stringify({
    version: 2,
    pods: [
      { name: "eng", createdAt: NOW, leader: "wT:p1", succession: ["wT:p1"], status: "open", closedAt: null },
      { name: "eng", createdAt: NOW, leader: "wT:p2", succession: ["wT:p2"], status: "open", closedAt: null },
    ],
  }));
  assert.throws(() => readCoordinationState(), /pod eng is duplicated/);

  writeFileSync(coordinationStatePath(), JSON.stringify({
    version: 2,
    podMembers: [{ member: "wT:p1", pod: "eng", role: "manager", process: null, registeredAt: NOW }],
  }));
  assert.throws(() => readCoordinationState(), /member wT:p1 role is corrupt/);

  writeFileSync(coordinationStatePath(), JSON.stringify({
    version: 2,
    podMembers: [{ member: "wT:p1", pod: "eng", role: "worker", process: { pid: -1, startedAt: "linux:1" }, registeredAt: NOW }],
  }));
  assert.throws(() => readCoordinationState(), /member wT:p1 process identity is corrupt/);

  writeFileSync(coordinationStatePath(), JSON.stringify({
    version: 2,
    podMembers: [
      { member: "wT:p1", pod: "eng", role: "worker", process: null, registeredAt: NOW },
      { member: "wT:p1", pod: "ops", role: "worker", process: null, registeredAt: NOW },
    ],
  }));
  assert.throws(() => readCoordinationState(), /member wT:p1 is duplicated/);
});

test("corrupt channel and awareness event records refuse loudly", () => {
  isolatedState();
  writeFileSync(coordinationStatePath(), JSON.stringify({
    version: 2,
    leaderChannels: [{ id: "oops", fromPod: "eng", toPod: "ops", topic: "release", openedAt: NOW, closedAt: null, messageCount: 0 }],
  }));
  assert.throws(() => readCoordinationState(), /channel id is corrupt/);

  writeFileSync(coordinationStatePath(), JSON.stringify({
    version: 2,
    awarenessEvents: [{ id: 1, kind: "pod-nuked", createdAt: NOW }],
  }));
  assert.throws(() => readCoordinationState(), /awareness event kind is corrupt/);
});

test("channel and awareness id counters recover above the highest existing id", () => {
  isolatedState();
  writeFileSync(coordinationStatePath(), JSON.stringify({
    version: 2,
    nextChannelId: 1,
    nextAwarenessEventId: "corrupt",
    leaderChannels: [{ id: 5, fromPod: "eng", toPod: "ops", topic: "release", openedAt: NOW, closedAt: null, messageCount: 2 }],
    awarenessEvents: [{ id: 3, kind: "pod-created", createdAt: NOW, pod: "eng" }],
  }));

  const state = readCoordinationState();
  assert.equal(state.nextChannelId, 6);
  assert.equal(state.nextAwarenessEventId, 4);
});

test("healthy channel and awareness counters above the highest existing id are preserved", () => {
  isolatedState();
  writeFileSync(coordinationStatePath(), JSON.stringify({
    version: 2,
    nextChannelId: 12,
    nextAwarenessEventId: 9,
    leaderChannels: [{ id: 5, fromPod: "eng", toPod: "ops", topic: "release", openedAt: NOW, closedAt: null, messageCount: 2 }],
    awarenessEvents: [{ id: 3, kind: "pod-created", createdAt: NOW, pod: "eng" }],
  }));

  const state = readCoordinationState();
  assert.equal(state.nextChannelId, 12);
  assert.equal(state.nextAwarenessEventId, 9);
});

test("orchestrator init mints a token, stores only its hash, and prints it once", () => {
  isolatedState();
  const init = json(runCli(["orchestrator", "init"]));
  assert.equal(init.ok, true);
  assert.match(init.token, /^[a-f0-9]{64}$/);
  assert.equal(init.rotated, false);

  const raw = readFileSync(coordinationStatePath(), "utf8");
  assert.equal(raw.includes(init.token), false, "the minted token must never be persisted");
  const persisted = JSON.parse(raw);
  assert.equal(persisted.version, 2);
  assert.match(persisted.memberTokens.orchestrator, /^[a-f0-9]{64}$/);
  assert.equal(typeof persisted.orchestrator.initializedAt, "string");

  const state = readCoordinationState();
  assertMemberToken(state, "orchestrator", init.token);
});

test("orchestrator init twice refuses and --rotate replaces the token", () => {
  isolatedState();
  const first = json(runCli(["orchestrator", "init"]));

  const second = runCli(["orchestrator", "init"]);
  assert.equal(second.exitCode, 1);
  assert.match(second.stderr, /already initialized/);
  assert.match(second.stderr, /--rotate/);

  const rotated = json(runCli(["orchestrator", "init", "--rotate"]));
  assert.equal(rotated.rotated, true);
  assert.notEqual(rotated.token, first.token);

  const state = readCoordinationState();
  assert.throws(() => assertMemberToken(state, "orchestrator", first.token), /does not authenticate/);
  assertMemberToken(state, "orchestrator", rotated.token);
});

test("the reserved orchestrator name cannot be registered by a regular member", () => {
  isolatedState();
  const result = runCli(["session", "register", "--pane", "orchestrator", "--token", "squatter-token-secret"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /reserved/);
});

test("member token verification rejects forged and unregistered members", () => {
  isolatedState();
  const token = "member-token-wt-p1-secret";
  json(runCli(["session", "register", "--pane", "wT:p1", "--token", token]));

  const state = readCoordinationState();
  assertMemberToken(state, "wT:p1", token);
  // Same-length wrong token: the timing-safe hash comparison must reject it.
  assert.throws(() => assertMemberToken(state, "wT:p1", "member-token-wt-p1-FORGED"), /does not authenticate/);
  assert.throws(() => assertMemberToken(state, "wT:p9", token), /not registered/);
});

test("state migrate before orchestrator init refuses and names the init step", () => {
  isolatedState();
  writeFileSync(coordinationStatePath(), JSON.stringify(legacyState()));

  const result = runCli(["state", "migrate", "--legacy-pod", "legacy", "--legacy-leader", "wT:p1"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /orchestrator init/);
});

test("state migrate refuses on missing or version-2 state and on an unknown legacy leader", () => {
  isolatedState();
  const missing = runCli(["state", "migrate", "--legacy-pod", "legacy", "--legacy-leader", "wT:p1"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /no coordination state/);

  json(runCli(["orchestrator", "init"]));
  const already = runCli(["state", "migrate", "--legacy-pod", "legacy", "--legacy-leader", "wT:p1"]);
  assert.equal(already.exitCode, 1);
  assert.match(already.stderr, /already version 2/);

  writeFileSync(coordinationStatePath(), JSON.stringify(legacyState()));
  json(runCli(["orchestrator", "init"]));
  const unknownLeader = runCli(["state", "migrate", "--legacy-pod", "legacy", "--legacy-leader", "wT:p9"]);
  assert.equal(unknownLeader.exitCode, 1);
  assert.match(unknownLeader.stderr, /not a registered version-1 pane/);
});

test("state migrate refuses the reserved orchestrator name as legacy leader", () => {
  isolatedState();
  writeFileSync(coordinationStatePath(), JSON.stringify(legacyState()));
  json(runCli(["orchestrator", "init"]));

  // init records the orchestrator hash in the v1 token map, so the
  // "registered version-1 pane" guard alone would accept it (QA il-1af MF-1).
  const result = runCli(["state", "migrate", "--legacy-pod", "legacy", "--legacy-leader", "orchestrator"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /reserved for the orchestrator/);

  // A refused migrate leaves the version-1 state untouched, nothing to repair.
  assert.throws(() => readCoordinationState(), /state migrate/);
});

test("state migrate wraps version-1 panes into one pod and preserves history", () => {
  isolatedState();
  writeFileSync(coordinationStatePath(), JSON.stringify(legacyState()));

  // Required order per ADR D8: orchestrator init first, even against version-1 state.
  const init = json(runCli(["orchestrator", "init"]));
  assert.match(init.token, /^[a-f0-9]{64}$/);

  const migrated = json(runCli(["state", "migrate", "--legacy-pod", "legacy", "--legacy-leader", "wT:p1"]));
  assert.equal(migrated.pod.name, "legacy");
  assert.equal(migrated.pod.leader, "wT:p1");
  assert.equal(migrated.pod.status, "open");
  assert.equal(migrated.pod.closedAt, null);
  assert.deepEqual(migrated.pod.succession, ["wT:p1", "wT:p2"]);

  const state = readCoordinationState();
  assert.equal(state.version, 2);
  assert.deepEqual(Object.keys(state.memberTokens).sort(), ["orchestrator", "wT:p1", "wT:p2"]);
  assert.equal(state.memberTokens["wT:p1"], hash("legacy-token-wt-p1-secret"));
  assert.equal(state.memberTokens["wT:p2"], hash("legacy-token-wt-p2-secret"));

  assert.equal(state.pods.length, 1);
  assert.deepEqual(state.podMembers.map((member) => [member.member, member.role, member.process]), [
    ["wT:p1", "leader", null],
    ["wT:p2", "worker", null],
  ]);
  for (const member of state.podMembers) assert.equal(member.pod, "legacy");

  // Version-1 messages, tasks, sessions, and digests carry over unchanged as history.
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[1]?.text, "legacy two");
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0]?.id, "T1");
  assert.equal(state.sessions.length, 1);
  assert.equal(state.digests.length, 1);
  assert.equal(state.lastWatchAt, NOW);
  assert.equal(state.nextMessageId, 3);
  assert.equal(state.nextDigestId, 2);
  assert.equal(state.orchestrator?.initializedAt !== undefined, true);

  // The migrated plane is immediately operable with the carried-over tokens.
  assertMemberToken(state, "wT:p1", "legacy-token-wt-p1-secret");
  assertMemberToken(state, "orchestrator", init.token);
  const sent = runCli(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--token", "legacy-token-wt-p1-secret", "--text", "post-migration"]);
  assert.equal(sent.exitCode, 0, sent.stderr);
  assert.equal(json(sent).message.id, 3);
});
