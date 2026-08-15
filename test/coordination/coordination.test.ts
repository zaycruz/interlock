import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../../src/cli/index.js";
import { coordinationStatePath } from "../../src/coordination/index.js";

const stateDirs: string[] = [];
const originalStateDir = process.env.INTERLOCK_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalStateDir;
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

test("tasks preserve business value and reject the second atomic claimant", () => {
  isolatedState();
  json(runCli(["task", "add", "--id", "W380", "--title", "Unify interlock", "--value", "Prevent collisions and deliver work"]));
  const first = json(runCli(["task", "claim", "W380", "--pane", "wT:p1"]));
  assert.equal(first.task.claimer, "wT:p1");

  const conflict = runCli(["task", "claim", "W380", "--pane", "wT:p4"]);
  assert.equal(conflict.exitCode, 1);
  assert.match(conflict.stderr, /claim_conflict/);
  assert.match(conflict.stderr, /wT:p1/);

  const listed = json(runCli(["task", "list", "--json"]));
  assert.equal(listed.tasks[0].businessValue, "Prevent collisions and deliver work");
  assert.equal(listed.tasks[0].revision, 2);
});

test("busy panes receive a durable digest on idle exactly once", () => {
  isolatedState();
  json(runCli(["session", "set", "--pane", "wT:p2", "--state", "busy"]));
  const sent = json(runCli(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "claim result is ready"]));
  assert.equal(sent.digests.length, 0);
  assert.equal(json(runCli(["watch", "--once"])).digested, 0);

  const idle = json(runCli(["session", "set", "--pane", "wT:p2", "--state", "idle"]));
  assert.equal(idle.digests.length, 1);
  assert.equal(idle.digests[0].messageIds[0], sent.message.id);
  assert.equal(json(runCli(["watch", "--once"])).digested, 0);

  const inbox = json(runCli(["inbox", "--pane", "wT:p2", "--json"]));
  assert.equal(inbox.messages[0].text, "claim result is ready");
  assert.equal(inbox.digests.length, 1);
  assert.equal(existsSync(inbox.digests[0].file), true);

  json(runCli(["session", "set", "--pane", "wT:p1", "--state", "idle"]));
  const reply = json(runCli(["send", "--from-pane", "wT:p2", "--to-pane", "wT:p1", "--reply", String(sent.message.id), "--text", "Review complete"]));
  assert.equal(reply.message.replyTo, sent.message.id);
  assert.equal(reply.message.toPane, "wT:p1");
});

test("done transition triggers delivery after a busy pane becomes done", () => {
  isolatedState();
  json(runCli(["session", "set", "--pane", "wT:p4", "--state", "busy"]));
  const sent = json(runCli(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "done transition notice"]));
  json(runCli(["task", "add", "--id", "T1", "--title", "Close task", "--value", "Make completion visible"]));
  json(runCli(["task", "claim", "T1", "--pane", "wT:p1"]));
  assert.equal(json(runCli(["task", "stage", "T1", "done", "--pane", "wT:p1"])).digests.length, 0);
  const done = json(runCli(["session", "set", "--pane", "wT:p4", "--state", "done"]));
  assert.equal(done.digests.length, 1);
  assert.deepEqual(done.digests[0].messageIds, [sent.message.id]);
  assert.equal(json(runCli(["watch", "--once"])).digested, 0);
});

test("dashboard is a read-only live view containing business value and digest health", () => {
  isolatedState();
  json(runCli(["task", "add", "--id", "T2", "--title", "Read-only board", "--value", "Keep humans aware without controls"]));
  const before = readFileSync(coordinationStatePath(), "utf8");
  const view = json(runCli(["dashboard", "--once", "--json"]));
  const after = readFileSync(coordinationStatePath(), "utf8");
  assert.equal(after, before);
  assert.equal(view.product, "interlock");
  assert.equal(view.readOnly, true);
  assert.equal(view.tasks[0].businessValue, "Keep humans aware without controls");
  assert.equal(view.watcher.digestDeliveries, 0);
});
