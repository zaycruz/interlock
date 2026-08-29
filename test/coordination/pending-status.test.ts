// U1: the engine keeps a count-only pending-status file per registered pane
// ($INTERLOCK_STATE_DIR/pending/<pane>.json) so any host can surface an
// "N pending" nudge without the agent asking. The file refreshes inside the
// coordination lock on every inbox change (send, claim, close) and the watch
// sweep repairs it. Content rule: counts and timestamps only — never message
// text, senders, or topics (R9-R13, R11/AE5).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../../src/cli/index.js";

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
  const directory = mkdtempSync(join(tmpdir(), "interlock-pending-status-test-"));
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

function pendingFile(pane: string): string {
  return join(process.env.INTERLOCK_STATE_DIR!, "pending", `${pane}.json`);
}

function readPending(pane: string): any {
  return JSON.parse(readFileSync(pendingFile(pane), "utf8"));
}

// AE1: a quiet arrival moves the recipient's count without any interrupt.
test("a quiet arrival refreshes the recipient's pending status and nothing else", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p4"]);
  const sent = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "branch is ready"], "wT:p1")).message;

  const record = readPending("wT:p4");
  assert.equal(record.version, 1);
  assert.equal(record.pane, "wT:p4");
  assert.equal(record.pending, 1);
  assert.equal(record.oldestPendingAt, sent.createdAt);
  assert.equal(typeof record.updatedAt, "string");
  // The send only touches the recipient's file; the sender's inbox did not change.
  assert.equal(existsSync(pendingFile("wT:p1")), false);
});

// AE2: claimed is not done — the recipient still owes the sender a close.
test("claiming keeps counting the message as pending", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p4"]);
  const sent = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "review please"], "wT:p1")).message;

  const claimed = json(authorized(["inbox", "claim", "--message", String(sent.id), "--pane", "wT:p4"], "wT:p4"));
  assert.equal(claimed.message.state, "claimed");

  const record = readPending("wT:p4");
  assert.equal(record.pending, 1);
  assert.equal(record.oldestPendingAt, sent.createdAt);
});

test("closing zeroes the count and the file is kept, not deleted", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p4"]);
  const sent = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "review please"], "wT:p1")).message;
  json(authorized(["inbox", "claim", "--message", String(sent.id), "--pane", "wT:p4"], "wT:p4"));

  json(authorized(["inbox", "close", "--message", String(sent.id), "--pane", "wT:p4"], "wT:p4"));

  const record = readPending("wT:p4");
  assert.equal(record.pending, 0);
  assert.equal(record.oldestPendingAt, null);
  assert.equal(existsSync(pendingFile("wT:p4")), true);
});

test("a reply hands the thread back: the replier's count drops, the original sender's rises", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p4"]);
  const sent = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "review please"], "wT:p1")).message;
  json(authorized(["inbox", "claim", "--message", String(sent.id), "--pane", "wT:p4"], "wT:p4"));

  json(authorized(["send", "--from-pane", "wT:p4", "--reply", String(sent.id), "--text", "shipped"], "wT:p4"));

  // The parent moved queued/claimed -> handled: no longer counted for wT:p4.
  assert.equal(readPending("wT:p4").pending, 0);
  // The reply is queued for wT:p1: the sender-side file now exists and counts 1.
  assert.equal(readPending("wT:p1").pending, 1);
});

// AE5: the nudge discloses counts and timestamps — never content, senders, or topics.
test("the record carries only counts and timestamps, never message content", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p4"]);
  json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "ZXCV-unique-body-MARKER"], "wT:p1"));

  const raw = readFileSync(pendingFile("wT:p4"), "utf8");
  assert.equal(raw.includes("ZXCV-unique-body-MARKER"), false);
  assert.equal(raw.includes("wT:p1"), false);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["oldestPendingAt", "pane", "pending", "updatedAt", "version"]);
});

test("the watch sweep repairs a lost file and covers every registered pane with zero counts", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p4", "wT:p9"]);
  json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "still waiting"], "wT:p1"));
  assert.equal(readPending("wT:p4").pending, 1);
  // wT:p9 never sends or receives; its file only ever comes from the sweep (R9).
  assert.equal(existsSync(pendingFile("wT:p9")), false);

  unlinkSync(pendingFile("wT:p4"));
  assert.equal(existsSync(pendingFile("wT:p4")), false);

  json(runCli(["watch", "--once"]));

  assert.equal(readPending("wT:p4").pending, 1, "sweep restored the correct count");
  assert.equal(readPending("wT:p9").pending, 0, "registered pane without mail gets a zero-count file");
  // The orchestrator is a deployment identity, not a pane; it never gets a file.
  assert.equal(existsSync(pendingFile("orchestrator")), false);
});

test("compact removes terminal messages and the pending count stays correct", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p4"]);
  const sent = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "one"], "wT:p1")).message;
  json(authorized(["send", "--from-pane", "wT:p4", "--reply", String(sent.id), "--text", "done"], "wT:p4"));
  assert.equal(readPending("wT:p4").pending, 0);
  assert.equal(readPending("wT:p1").pending, 1);

  // compact drops the handled parent (never counted) and keeps the queued reply.
  const compacted = json(runCli(["compact"]));
  assert.ok(compacted.removedMessages >= 1);
  assert.equal(readPending("wT:p4").pending, 0);
  assert.equal(readPending("wT:p1").pending, 1);

  // The next arrival still counts correctly after compaction.
  json(authorized(["send", "--from-pane", "wT:p4", "--to-pane", "wT:p1", "--text", "two"], "wT:p4"));
  assert.equal(readPending("wT:p1").pending, 2);
});
