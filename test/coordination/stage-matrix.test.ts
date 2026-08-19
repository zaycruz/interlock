// il-2t8: task and message stages move along a transition matrix. Owners can
// no longer jump any stage to any stage, and the previously unreachable
// message stages (claimed, closed) are reachable through inbox claim/close.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../../src/cli/index.js";
import { readCoordinationState } from "../../src/coordination/state.js";

const stateDirs: string[] = [];
const originalStateDir = process.env.INTERLOCK_STATE_DIR;
const paneTokens = new Map<string, string>();

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalStateDir;
  paneTokens.clear();
  while (stateDirs.length > 0) rmSync(stateDirs.pop()!, { recursive: true, force: true });
});

function isolatedState(): string {
  const directory = mkdtempSync(join(tmpdir(), "interlock-stage-matrix-test-"));
  stateDirs.push(directory);
  process.env.INTERLOCK_STATE_DIR = directory;
  return directory;
}

function json(result: ReturnType<typeof runCli>): any {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function registerPod(pod: string, members: string[]): void {
  const orchestrator = json(runCli(["orchestrator", "init"])).token as string;
  const template = join(process.env.INTERLOCK_STATE_DIR!, `template-${pod}.json`);
  writeFileSync(template, JSON.stringify({ members, leader: members[0], succession: [...members] }));
  const created = json(runCli(["pod", "create", "--name", pod, "--template", template, "--orchestrator-token", orchestrator]));
  for (const [member, token] of Object.entries(created.tokens as Record<string, string>)) paneTokens.set(member, token);
}

function authorized(argv: string[], pane: string): ReturnType<typeof runCli> {
  return runCli([...argv, "--token", paneTokens.get(pane)!]);
}

function addTask(id: string, pane = "wT:p1"): void {
  json(authorized(["task", "add", "--id", id, "--title", `Task ${id}`, "--value", "value", "--pane", pane], pane));
}

function taskStage(id: string, pane = "wT:p1"): string {
  return json(runCli(["task", "list", "--json"])).tasks.find((task: any) => task.id === id).stage;
}

test("task stage enforces the transition matrix: no reopening terminal tasks, no manufactured claims", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p2"]);
  addTask("T1");
  json(authorized(["task", "claim", "T1", "--pane", "wT:p1"], "wT:p1"));

  // Forward and recycle transitions are allowed.
  json(authorized(["task", "stage", "T1", "in-progress", "--pane", "wT:p1"], "wT:p1"));
  json(authorized(["task", "stage", "T1", "blocked", "--pane", "wT:p1"], "wT:p1"));
  json(authorized(["task", "stage", "T1", "in-progress", "--pane", "wT:p1"], "wT:p1"));
  assert.equal(taskStage("T1"), "in-progress");

  // A blocked/in-progress task cannot jump backwards into a bare claim.
  const toClaimed = authorized(["task", "stage", "T1", "claimed", "--pane", "wT:p1"], "wT:p1");
  assert.equal(toClaimed.exitCode, 1);
  assert.match(toClaimed.stderr, /cannot move from in-progress to claimed/);

  // Done is terminal except for close; it never reopens.
  json(authorized(["task", "stage", "T1", "done", "--pane", "wT:p1"], "wT:p1"));
  const reopen = authorized(["task", "stage", "T1", "open", "--pane", "wT:p1"], "wT:p1");
  assert.equal(reopen.exitCode, 1);
  assert.match(reopen.stderr, /cannot move from done to open/);
  json(authorized(["task", "stage", "T1", "closed", "--pane", "wT:p1"], "wT:p1"));
  const revive = authorized(["task", "stage", "T1", "done", "--pane", "wT:p1"], "wT:p1");
  assert.equal(revive.exitCode, 1);
  assert.match(revive.stderr, /cannot move from closed to done/);

  assert.equal(taskStage("T1"), "closed");
});

test("an open task cannot be staged at all before it is claimed (owner-only mutation)", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p2"]);
  addTask("T2");

  // Task mutation is owner-only (pre-existing contract): an unclaimed task
  // has no owner, so the matrix never even sees the request.
  const unowned = authorized(["task", "stage", "T2", "done", "--pane", "wT:p1"], "wT:p1");
  assert.equal(unowned.exitCode, 1);
  assert.match(unowned.stderr, /owned by nobody/);

  // Once claimed, only the claimer may move it; another pane's request dies
  // at the ownership check before the matrix is consulted.
  json(authorized(["task", "claim", "T2", "--pane", "wT:p1"], "wT:p1"));
  const notOwner = authorized(["task", "stage", "T2", "open", "--pane", "wT:p2"], "wT:p2");
  assert.equal(notOwner.exitCode, 1);
  assert.match(notOwner.stderr, /owned by wT:p1/, notOwner.stderr);
  assert.equal(taskStage("T2"), "claimed");
});

test("a claimed task can be released back to open and reclaimed through the matrix", () => {
  isolatedState();
  registerPod("eng", ["wT:p1"]);
  addTask("T3");
  json(authorized(["task", "claim", "T3", "--pane", "wT:p1"], "wT:p1"));
  json(authorized(["task", "stage", "T3", "open", "--pane", "wT:p1"], "wT:p1"));
  assert.equal(taskStage("T3"), "open");
});

test("inbox claim and inbox close make the claimed and closed message stages reachable", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p2"]);
  json(authorized(["session", "set", "--pane", "wT:p2", "--state", "busy"], "wT:p2"));
  const sent = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "please review"], "wT:p1")).message;
  assert.equal(sent.state, "queued");

  // Only the addressed pane can move its own mail.
  const wrongPane = authorized(["inbox", "claim", "--message", String(sent.id), "--pane", "wT:p1"], "wT:p1");
  assert.equal(wrongPane.exitCode, 1);
  assert.match(wrongPane.stderr, /not addressed to wT:p1/);

  // Queued -> claimed is now reachable, and the default inbox lists it.
  const claimed = json(authorized(["inbox", "claim", "--message", String(sent.id), "--pane", "wT:p2"], "wT:p2")).message;
  assert.equal(claimed.state, "claimed");
  const inbox = json(authorized(["inbox", "--pane", "wT:p2", "--json"], "wT:p2"));
  assert.equal(inbox.messages.some((message: any) => message.id === sent.id && message.state === "claimed"), true);

  // A queued message cannot skip the claim straight to closed: closing is
  // digest-invisible, so queued -> closed would hide undelivered mail.
  const second = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "and this"], "wT:p1")).message;
  const skip = authorized(["inbox", "close", "--message", String(second.id), "--pane", "wT:p2"], "wT:p2");
  assert.equal(skip.exitCode, 1);
  assert.match(skip.stderr, /cannot move from queued to closed/, skip.stderr);

  // Claimed -> closed is reachable; closed is terminal and drops off the
  // default inbox view.
  json(authorized(["inbox", "close", "--message", String(sent.id), "--pane", "wT:p2"], "wT:p2"));
  const reopen = authorized(["inbox", "claim", "--message", String(sent.id), "--pane", "wT:p2"], "wT:p2");
  assert.equal(reopen.exitCode, 1);
  assert.match(reopen.stderr, /cannot move from closed to claimed/);
  const after = json(authorized(["inbox", "--pane", "wT:p2", "--json"], "wT:p2"));
  assert.equal(after.messages.some((message: any) => message.id === sent.id), false);

  const persisted = readCoordinationState();
  assert.equal(persisted.messages.find((message) => message.id === sent.id)!.state, "closed");
});

test("a reply still hands the thread back through the matrix (queued/claimed -> handled)", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p2"]);
  json(authorized(["session", "set", "--pane", "wT:p1", "--state", "busy"], "wT:p1"));
  const first = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "question"], "wT:p1")).message;
  json(authorized(["inbox", "claim", "--message", String(first.id), "--pane", "wT:p2"], "wT:p2"));

  json(authorized(["send", "--from-pane", "wT:p2", "--reply", String(first.id), "--text", "answer"], "wT:p2"));
  assert.equal(readCoordinationState().messages.find((message) => message.id === first.id)!.state, "handled");

  // Handled -> closed is reachable so the recipient can retire the thread.
  json(authorized(["inbox", "close", "--message", String(first.id), "--pane", "wT:p2"], "wT:p2"));
});
