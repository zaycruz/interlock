// il-yhw: digest delivery is exactly-once under partial failure. The
// persisted digest record is the durable marker; the delivery file is an
// idempotently-keyed artifact that the inbox re-materializes, so a lost file
// never causes the next sweep to duplicate the digest.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  const directory = mkdtempSync(join(tmpdir(), "interlock-digest-delivery-test-"));
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

// One queued message to a busy pane, which digests when the pane goes idle.
function sendAndDigest(text: string): { messageId: number; digestFile: string; digestId: number } {
  json(authorized(["session", "set", "--pane", "wT:p2", "--state", "busy"], "wT:p2"));
  const sent = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p2", "--text", text], "wT:p1")).message;
  const idle = json(authorized(["session", "set", "--pane", "wT:p2", "--state", "idle"], "wT:p2"));
  assert.equal(idle.digests.length, 1);
  return { messageId: sent.id, digestFile: idle.digests[0].file, digestId: idle.digests[0].id };
}

test("a lost digest delivery file is not duplicated by the next sweep; the inbox repairs it", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p2"]);
  const { messageId, digestFile, digestId } = sendAndDigest("result one");
  assert.equal(existsSync(digestFile), true);

  // Simulate the partial failure: the pane's delivery file never landed even
  // though the digest record persisted.
  unlinkSync(digestFile);
  assert.equal(existsSync(digestFile), false);

  // The next sweep must not re-deliver: the persisted record suppresses it.
  const sweep = json(runCli(["watch", "--once"]));
  assert.equal(sweep.digested, 0);
  assert.equal(readCoordinationState().digests.filter((digest) => digest.messageIds.includes(messageId)).length, 1);

  // The inbox re-materializes the idempotently-keyed file and reports it.
  const inbox = json(authorized(["inbox", "--pane", "wT:p2", "--json"], "wT:p2"));
  assert.deepEqual(inbox.redelivered, [digestId]);
  assert.equal(existsSync(digestFile), true);

  // A second inbox read finds the file present and repairs nothing.
  const again = json(authorized(["inbox", "--pane", "wT:p2", "--json"], "wT:p2"));
  assert.deepEqual(again.redelivered, []);
  // Still exactly one digest covering the message, and later sweeps stay quiet.
  assert.equal(json(runCli(["watch", "--once"])).digested, 0);
  assert.equal(readCoordinationState().digests.filter((digest) => digest.messageIds.includes(messageId)).length, 1);
});

test("an intact digest delivery repairs nothing and later messages digest separately", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p2"]);
  const first = sendAndDigest("first result");
  const second = sendAndDigest("second result");

  // Both files intact: the inbox reports no repair.
  const inbox = json(authorized(["inbox", "--pane", "wT:p2", "--json"], "wT:p2"));
  assert.deepEqual(inbox.redelivered, []);
  assert.equal(inbox.digests.length, 2);

  // The two messages were covered by two distinct digests, not one duplicated.
  const state = readCoordinationState();
  assert.equal(state.digests.filter((digest) => digest.messageIds.includes(first.messageId)).length, 1);
  assert.equal(state.digests.filter((digest) => digest.messageIds.includes(second.messageId)).length, 1);
  assert.notEqual(first.digestId, second.digestId);
});
