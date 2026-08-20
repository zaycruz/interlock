import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../../src/cli/index.js";
import { MAX_ROSTER_SIZE } from "../../src/coordination/index.js";
import { readCoordinationState, writeCoordinationState } from "../../src/coordination/state.js";

const stateDirs: string[] = [];
const originalStateDir = process.env.INTERLOCK_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalStateDir;
  while (stateDirs.length > 0) rmSync(stateDirs.pop()!, { recursive: true, force: true });
});

function isolatedState(): void {
  const directory = mkdtempSync(join(tmpdir(), "interlock-pods-appoint-test-"));
  stateDirs.push(directory);
  process.env.INTERLOCK_STATE_DIR = directory;
}

function json(result: ReturnType<typeof runCli>): any {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function createPod(orchestrator: string, name: string, members = ["wT:p1", "wT:p2"], leader = members[0]!, succession = [...members]): Record<string, string> {
  const template = join(process.env.INTERLOCK_STATE_DIR!, `template-${name}.json`);
  writeFileSync(template, JSON.stringify({ members, leader, succession }));
  return json(runCli(["pod", "create", "--name", name, "--template", template, "--orchestrator-token", orchestrator])).tokens;
}

function setup(): { orchestrator: string; tokens: Record<string, string> } {
  isolatedState();
  const orchestrator = json(runCli(["orchestrator", "init"])).token as string;
  return { orchestrator, tokens: createPod(orchestrator, "eng") };
}

function appoint(orchestrator: string, ...args: string[]): ReturnType<typeof runCli> {
  return runCli(["pod", "appoint", ...args, "--orchestrator-token", orchestrator]);
}

test("pod appoint atomically promotes a current roster member and records awareness", () => {
  const { orchestrator } = setup();

  const appointed = json(appoint(orchestrator, "--pod", "eng", "--leader", "wT:p2"));

  assert.equal(appointed.pod.leader, "wT:p2");
  const state = readCoordinationState();
  assert.deepEqual(state.podMembers.filter((member) => member.pod === "eng" && member.role === "leader").map((member) => member.member), ["wT:p2"]);
  assert.equal(state.awarenessEvents.at(-1)?.kind, "leader-promoted");
  assert.equal(state.awarenessEvents.at(-1)?.member, "wT:p2");
});

test("pod appoint adds a member once, mints its token once, and appends succession by default", () => {
  const { orchestrator } = setup();

  const appointed = json(appoint(orchestrator, "--pod", "eng", "--member", "wT:p3", "--role", "worker"));

  assert.match(appointed.tokens["wT:p3"], /^[a-f0-9]{64}$/);
  const state = readCoordinationState();
  assert.equal(state.podMembers.find((member) => member.member === "wT:p3")?.role, "worker");
  assert.deepEqual(state.pods[0]?.succession, ["wT:p1", "wT:p2", "wT:p3"]);
  assert.equal(state.awarenessEvents.at(-1)?.kind, "member-appointed");
});

test("pod appoint growth enforces closed-roster exclusivity, reserved names, squat detection, and roster cap", () => {
  const { orchestrator } = setup();
  createPod(orchestrator, "retired", ["wQ:p1"]);
  json(runCli(["pod", "close", "--pod", "retired", "--orchestrator-token", orchestrator]));

  const reused = appoint(orchestrator, "--pod", "eng", "--member", "wQ:p1");
  assert.equal(reused.exitCode, 1);
  assert.match(reused.stderr, /already belongs to pod retired/);

  const reserved = appoint(orchestrator, "--pod", "eng", "--member", "orchestrator");
  assert.equal(reserved.exitCode, 1);
  assert.match(reserved.stderr, /reserved/);

  const squattedToken = "squatted-member-token";
  json(runCli(["session", "register", "--pane", "wT:p3", "--token", squattedToken]));
  const squatted = appoint(orchestrator, "--pod", "eng", "--member", "wT:p3");
  assert.equal(squatted.exitCode, 1);
  assert.match(squatted.stderr, /different token/);

  for (let index = 3; index <= MAX_ROSTER_SIZE; index += 1) {
    json(appoint(orchestrator, "--pod", "eng", "--member", `wT:p${index + 1}`));
  }
  const overLimit = appoint(orchestrator, "--pod", "eng", "--member", "wT:overflow");
  assert.equal(overLimit.exitCode, 1);
  assert.match(overLimit.stderr, new RegExp(`maximum of ${MAX_ROSTER_SIZE}`));
});

test("pod appoint does not revive succession in a leaderless wedge and rejects done appointees", () => {
  const { orchestrator, tokens } = setup();
  const state = readCoordinationState();
  state.podMembers.find((member) => member.member === "wT:p1")!.diedAt = "2026-08-20T00:00:00.000Z";
  writeCoordinationState(state);

  json(appoint(orchestrator, "--pod", "eng", "--member", "wT:p3", "--role", "worker", "--no-succession"));
  json(runCli(["watch", "--once"]));
  assert.equal(readCoordinationState().pods[0]?.leader, "wT:p1");

  json(appoint(orchestrator, "--pod", "eng", "--leader", "wT:p2"));
  json(runCli(["session", "set", "--pane", "wT:p2", "--token", tokens["wT:p2"]!, "--state", "done"]));
  const done = appoint(orchestrator, "--pod", "eng", "--leader", "wT:p2");
  assert.equal(done.exitCode, 1);
  assert.match(done.stderr, /has reported done/);
});
