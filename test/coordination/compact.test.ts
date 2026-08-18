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
  const directory = mkdtempSync(join(tmpdir(), "interlock-compact-test-"));
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

function readState(): any { return JSON.parse(readFileSync(coordinationStatePath(), "utf8")); }
function editState(mutate: (state: any) => void): void {
  const state = readState();
  mutate(state);
  writeFileSync(coordinationStatePath(), JSON.stringify(state, null, 2));
}

test("compact removes terminal messages and digests and preserves in-flight state", () => {
  isolatedState();
  register("wT:p1"); register("wT:p2");
  json(authorized(["session", "set", "--pane", "wT:p2", "--state", "busy"], "wT:p2"));
  const m1 = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "first"], "wT:p1")).message;
  json(authorized(["session", "set", "--pane", "wT:p1", "--state", "idle"], "wT:p1"));
  const m2 = json(authorized(["send", "--from-pane", "wT:p2", "--reply", String(m1.id), "--text", "second"], "wT:p2")).message;
  const m3 = json(authorized(["send", "--from-pane", "wT:p1", "--reply", String(m2.id), "--text", "third"], "wT:p1")).message;
  json(authorized(["session", "set", "--pane", "wT:p2", "--state", "idle"], "wT:p2"));
  const m4 = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "fourth"], "wT:p1")).message;
  // "closed" is not reachable through the CLI; edit the state to cover both terminal stages.
  editState((state) => { state.messages.find((message: any) => message.id === m1.id).state = "closed"; });

  const before = readState();
  assert.equal(before.messages.length, 4);
  assert.equal(before.digests.length, 3);
  const droppedDigestFile = before.digests[0].file;
  const keptDigestFiles = [before.digests[1].file, before.digests[2].file];
  assert.equal(existsSync(droppedDigestFile), true);

  const compacted = json(runCli(["compact"]));
  assert.equal(compacted.removedMessages, 2);
  assert.equal(compacted.removedDigests, 1);

  const after = readState();
  assert.deepEqual(after.messages.map((message: any) => message.id), [m3.id, m4.id]);
  assert.deepEqual(after.digests.map((digest: any) => digest.id), [before.digests[1].id, before.digests[2].id]);
  assert.equal(existsSync(droppedDigestFile), false);
  for (const file of keptDigestFiles) assert.equal(existsSync(file), true);
  assert.equal(after.nextMessageId, before.nextMessageId);
  assert.equal(after.nextDigestId, before.nextDigestId);
});

test("compact preserves id-counter floors so a post-compact send is not dedupe-suppressed", () => {
  isolatedState();
  register("wT:p1"); register("wT:p2");
  const m1 = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "one"], "wT:p1")).message;
  const m2 = json(authorized(["send", "--from-pane", "wT:p2", "--reply", String(m1.id), "--text", "two"], "wT:p2")).message;
  const m3 = json(authorized(["send", "--from-pane", "wT:p1", "--reply", String(m2.id), "--text", "three"], "wT:p1")).message;
  editState((state) => { state.messages.find((message: any) => message.id === m3.id).state = "handled"; });

  const compacted = json(runCli(["compact"]));
  assert.equal(compacted.removedMessages, 3);
  assert.equal(readState().messages.length, 0);
  assert.equal(readState().digests.length, 0);
  assert.equal(readState().nextMessageId, 4);

  json(authorized(["session", "set", "--pane", "wT:p2", "--state", "idle"], "wT:p2"));
  const sent = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "after compact"], "wT:p1"));
  assert.equal(sent.message.id, 4);
  assert.equal(sent.digests.length, 1);
  assert.deepEqual(sent.digests[0].messageIds, [4]);
});

test("compact on empty or healthy state is a no-op", () => {
  isolatedState();
  const empty = json(runCli(["compact"]));
  assert.equal(empty.removedMessages, 0);
  assert.equal(empty.removedDigests, 0);

  register("wT:p1"); register("wT:p2");
  json(authorized(["session", "set", "--pane", "wT:p2", "--state", "idle"], "wT:p2"));
  json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", "in flight"], "wT:p1"));
  const before = readFileSync(coordinationStatePath(), "utf8");
  const healthy = json(runCli(["compact"]));
  assert.equal(healthy.removedMessages, 0);
  assert.equal(healthy.removedDigests, 0);
  assert.equal(readFileSync(coordinationStatePath(), "utf8"), before);
});
