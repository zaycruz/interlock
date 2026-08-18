import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../../src/cli/index.js";
import { coordinationStatePath } from "../../src/coordination/index.js";

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
  const directory = mkdtempSync(join(tmpdir(), "interlock-coordination-test-"));
  stateDirs.push(directory);
  process.env.INTERLOCK_STATE_DIR = directory;
  return directory;
}

function json(result: ReturnType<typeof runCli>): any {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function token(pane: string): string { return "token-" + pane.replace(/[^A-Za-z0-9]/g, "-") + "-secret"; }
function register(pane: string): void {
  const value = token(pane);
  paneTokens.set(pane, value);
  json(runCli(["session", "register", "--pane", pane, "--token", value]));
}
function authorized(argv: string[], pane: string): ReturnType<typeof runCli> {
  return runCli([...argv, "--token", paneTokens.get(pane) ?? token(pane)]);
}

test("tasks preserve business value and reject the second atomic claimant", () => {
  isolatedState();
  register("wT:p1"); register("wT:p4");
  json(authorized(["task", "add", "--id", "W380", "--title", "Unify interlock", "--value", "Prevent collisions and deliver work", "--pane", "wT:p1"], "wT:p1"));
  const first = json(authorized(["task", "claim", "W380", "--pane", "wT:p1"], "wT:p1"));
  assert.equal(first.task.claimer, "wT:p1");

  const conflict = authorized(["task", "claim", "W380", "--pane", "wT:p4"], "wT:p4");
  assert.equal(conflict.exitCode, 1);
  assert.match(conflict.stderr, /claim_conflict/);
  assert.match(conflict.stderr, /wT:p1/);

  const listed = json(runCli(["task", "list", "--json"]));
  assert.equal(listed.tasks[0].businessValue, "Prevent collisions and deliver work");
  assert.equal(listed.tasks[0].revision, 2);
});

test("busy panes receive a durable digest on idle exactly once", () => {
  isolatedState();
  register("wT:p1"); register("wT:p2");
  json(authorized(["session", "set", "--pane", "wT:p2", "--state", "busy"], "wT:p2"));
  const sent = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "claim result is ready"], "wT:p1"));
  assert.equal(sent.digests.length, 0);
  assert.equal(json(runCli(["watch", "--once"])).digested, 0);

  const idle = json(authorized(["session", "set", "--pane", "wT:p2", "--state", "idle"], "wT:p2"));
  assert.equal(idle.digests.length, 1);
  assert.equal(idle.digests[0].messageIds[0], sent.message.id);
  assert.equal(json(runCli(["watch", "--once"])).digested, 0);

  const inbox = json(authorized(["inbox", "--pane", "wT:p2", "--json"], "wT:p2"));
  assert.equal(inbox.messages[0].text, "claim result is ready");
  assert.equal(inbox.digests.length, 1);
  assert.equal(existsSync(inbox.digests[0].file), true);

  json(authorized(["session", "set", "--pane", "wT:p1", "--state", "idle"], "wT:p1"));
  const reply = json(authorized(["send", "--from-pane", "wT:p2", "--to-pane", "wT:p1", "--reply", String(sent.message.id), "--text", "Review complete"], "wT:p2"));
  assert.equal(reply.message.replyTo, sent.message.id);
  assert.equal(reply.message.toPane, "wT:p1");
});

test("done transition triggers delivery after a busy pane becomes done", () => {
  isolatedState();
  register("wT:p1"); register("wT:p4");
  json(authorized(["session", "set", "--pane", "wT:p4", "--state", "busy"], "wT:p4"));
  const sent = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "done transition notice"], "wT:p1"));
  json(authorized(["task", "add", "--id", "T1", "--title", "Close task", "--value", "Make completion visible", "--pane", "wT:p1"], "wT:p1"));
  json(authorized(["task", "claim", "T1", "--pane", "wT:p1"], "wT:p1"));
  assert.equal(json(authorized(["task", "stage", "T1", "done", "--pane", "wT:p1"], "wT:p1")).digests.length, 0);
  const done = json(authorized(["session", "set", "--pane", "wT:p4", "--state", "done"], "wT:p4"));
  assert.equal(done.digests.length, 1);
  assert.deepEqual(done.digests[0].messageIds, [sent.message.id]);
  assert.equal(json(runCli(["watch", "--once"])).digested, 0);
});

test("dashboard is a read-only live view containing business value and digest health", () => {
  isolatedState();
  register("wT:p1");
  json(authorized(["task", "add", "--id", "T2", "--title", "Read-only board", "--value", "Keep humans aware without controls", "--pane", "wT:p1"], "wT:p1"));
  const before = readFileSync(coordinationStatePath(), "utf8");
  const view = json(runCli(["dashboard", "--once", "--json"]));
  const after = readFileSync(coordinationStatePath(), "utf8");
  assert.equal(after, before);
  assert.equal(view.product, "interlock");
  assert.equal(view.readOnly, true);
  assert.equal(view.tasks[0].businessValue, "Keep humans aware without controls");
  assert.equal(view.watcher.digestDeliveries, 0);
});

test("pane tokens bind session, sender, inbox, and reply identity", () => {
  isolatedState();
  register("wT:p1"); register("wT:p2"); register("evil:p9");
  json(authorized(["session", "set", "--pane", "wT:p2", "--state", "busy"], "wT:p2"));
  const sent = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "private work"], "wT:p1"));

  const forgedSession = authorized(["session", "set", "--pane", "wT:p2", "--state", "idle"], "evil:p9");
  assert.equal(forgedSession.exitCode, 1);
  assert.match(forgedSession.stderr, /does not authenticate/);
  const forgedSender = authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "forged"], "evil:p9");
  assert.equal(forgedSender.exitCode, 1);
  assert.match(forgedSender.stderr, /does not authenticate/);
  const forgedReply = authorized(["send", "--from-pane", "evil:p9", "--reply", String(sent.message.id), "--text", "hide"], "evil:p9");
  assert.equal(forgedReply.exitCode, 1);
  assert.match(forgedReply.stderr, /not the addressed pane/);

  const inbox = json(authorized(["inbox", "--pane", "wT:p2", "--json"], "wT:p2"));
  assert.equal(inbox.messages[0].state, "queued");
});

test("pane and task identifiers reject traversal before any state or file write", () => {
  const directory = isolatedState();
  const invalidPane = runCli(["session", "register", "--pane", "../../tmp/il-escape", "--token", "valid-token"]);
  assert.equal(invalidPane.exitCode, 1);
  assert.match(invalidPane.stderr, /must match/);

  register("wT:p1");
  const invalidTask = authorized(["task", "add", "--id", "../escape", "--title", "bad", "--value", "bad", "--pane", "wT:p1"], "wT:p1");
  assert.equal(invalidTask.exitCode, 1);
  assert.match(invalidTask.stderr, /must match/);
  assert.equal(readFileSync(coordinationStatePath(), "utf8").includes("escape"), false);
  assert.equal(directory.includes("interlock-coordination-test-"), true);
});

test("done claimer can be explicitly reaped and returned to open", () => {
  isolatedState();
  register("wT:p1"); register("wT:p2");
  json(authorized(["task", "add", "--id", "REAP1", "--title", "Recover claim", "--value", "Dead work must not wedge the queue", "--pane", "wT:p1"], "wT:p1"));
  json(authorized(["task", "claim", "REAP1", "--pane", "wT:p1"], "wT:p1"));
  json(authorized(["session", "set", "--pane", "wT:p1", "--state", "busy"], "wT:p1"));
  const guarded = authorized(["task", "reap", "REAP1", "--pane", "wT:p2", "--dead-claimer", "wT:p1"], "wT:p2");
  assert.equal(guarded.exitCode, 1);
  assert.match(guarded.stderr, /must be done before reap/);
  json(authorized(["session", "set", "--pane", "wT:p1", "--state", "done"], "wT:p1"));
  const reaped = json(authorized(["task", "reap", "REAP1", "--pane", "wT:p2", "--dead-claimer", "wT:p1"], "wT:p2"));
  assert.equal(reaped.task.stage, "open");
  assert.equal(reaped.task.claimer, null);
  assert.equal(reaped.task.reapReason, "session-done");
});

test("stale-but-busy live claimer is never reapable on staleness alone", () => {
  isolatedState();
  register("wT:p1"); register("wT:p2");
  json(authorized(["task", "add", "--id", "REAP2", "--title", "Live quiet work", "--value", "Live work must not be displaced", "--pane", "wT:p1"], "wT:p1"));
  json(authorized(["task", "claim", "REAP2", "--pane", "wT:p1"], "wT:p1"));
  json(authorized(["session", "set", "--pane", "wT:p1", "--state", "busy"], "wT:p1"));

  // Simulate a live agent that stayed quiet past the 15-minute stale threshold.
  const state = JSON.parse(readFileSync(coordinationStatePath(), "utf8"));
  state.sessions[0].lastSeenAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  writeFileSync(coordinationStatePath(), JSON.stringify(state, null, 2));

  const reaped = authorized(["task", "reap", "REAP2", "--pane", "wT:p2", "--dead-claimer", "wT:p1"], "wT:p2");
  assert.equal(reaped.exitCode, 1);
  assert.match(reaped.stderr, /must be done before reap/);

  const listed = json(runCli(["task", "list", "--json"]));
  assert.equal(listed.tasks[0].claimer, "wT:p1");
  assert.equal(listed.tasks[0].stage, "claimed");
});

test("stale idle claimer is not reapable on staleness alone", () => {
  isolatedState();
  register("wT:p1"); register("wT:p2");
  json(authorized(["task", "add", "--id", "REAP3", "--title", "Idle live work", "--value", "Idle is not dead", "--pane", "wT:p1"], "wT:p1"));
  json(authorized(["task", "claim", "REAP3", "--pane", "wT:p1"], "wT:p1"));
  json(authorized(["session", "set", "--pane", "wT:p1", "--state", "idle"], "wT:p1"));

  const state = JSON.parse(readFileSync(coordinationStatePath(), "utf8"));
  state.sessions[0].lastSeenAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  writeFileSync(coordinationStatePath(), JSON.stringify(state, null, 2));

  const reaped = authorized(["task", "reap", "REAP3", "--pane", "wT:p2", "--dead-claimer", "wT:p1"], "wT:p2");
  assert.equal(reaped.exitCode, 1);
  assert.match(reaped.stderr, /must be done before reap/);
});

test("operator pane cannot reap its own claim", () => {
  isolatedState();
  register("wT:p1");
  json(authorized(["task", "add", "--id", "REAP4", "--title", "Self reap", "--value", "Operator must differ from claimer", "--pane", "wT:p1"], "wT:p1"));
  json(authorized(["task", "claim", "REAP4", "--pane", "wT:p1"], "wT:p1"));
  json(authorized(["session", "set", "--pane", "wT:p1", "--state", "done"], "wT:p1"));
  const selfReap = authorized(["task", "reap", "REAP4", "--pane", "wT:p1", "--dead-claimer", "wT:p1"], "wT:p1");
  assert.equal(selfReap.exitCode, 1);
  assert.match(selfReap.stderr, /cannot reap itself/);
});

test("a message sent after counter recovery is not suppressed by digest dedupe", () => {
  isolatedState();
  register("wT:p1"); register("wT:p2");
  json(authorized(["session", "set", "--pane", "wT:p2", "--state", "busy"], "wT:p2"));
  const first = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "first notice"], "wT:p1"));
  const idle = json(authorized(["session", "set", "--pane", "wT:p2", "--state", "idle"], "wT:p2"));
  assert.deepEqual(idle.digests[0].messageIds, [first.message.id]);

  const corrupted = JSON.parse(readFileSync(coordinationStatePath(), "utf8"));
  corrupted.nextMessageId = 1;
  writeFileSync(coordinationStatePath(), JSON.stringify(corrupted, null, 2));

  const second = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "second notice"], "wT:p1"));
  assert.equal(second.message.id, first.message.id + 1);
  assert.equal(second.digests.length, 1);
  assert.deepEqual(second.digests[0].messageIds, [second.message.id]);
});
