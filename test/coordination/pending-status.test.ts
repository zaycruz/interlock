// U1: the engine keeps a count-only pending-status file per registered pane
// ($INTERLOCK_STATE_DIR/pending/<pane>.json) so any host can surface an
// "N pending" nudge without the agent asking. The file refreshes inside the
// coordination lock on every inbox change (send, claim, close) and the watch
// sweep repairs it. Content rule: counts and timestamps only — never message
// text, senders, or topics (R9-R13, R11/AE5).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  for (const key of Object.keys(orchestratorTokens)) delete orchestratorTokens[key];
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

// orchestrator init prints its token once; cache it per isolated state dir.
const orchestratorTokens: Record<string, string> = {};
function orchestratorToken(): string {
  const directory = process.env.INTERLOCK_STATE_DIR!;
  if (orchestratorTokens[directory] === undefined) orchestratorTokens[directory] = json(runCli(["orchestrator", "init"])).token as string;
  return orchestratorTokens[directory];
}

function registerPod(pod: string, members: string[]): void {
  const orchestrator = orchestratorToken();
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

function listPendingDir(): string[] {
  const dir = join(process.env.INTERLOCK_STATE_DIR!, "pending");
  return existsSync(dir) ? readdirSync(dir) : [];
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

// The nudge's aging signal: oldestPendingAt must be the OLDEST pending
// message and must advance when that message is closed. Every other test
// keeps at most one message pending, which cannot tell min from max.
test("oldestPendingAt tracks the oldest pending message and advances when it closes", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p4"]);
  const first = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "older"], "wT:p1")).message;
  // createdAt has millisecond resolution; force the second send into a later tick.
  while (Date.now() <= Date.parse(first.createdAt)) { /* spin */ }
  const second = json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "newer"], "wT:p1")).message;
  assert.notEqual(first.createdAt, second.createdAt, "timestamps must be distinguishable");

  assert.equal(readPending("wT:p4").pending, 2);
  assert.equal(readPending("wT:p4").oldestPendingAt, first.createdAt, "oldest wins, not newest");

  authorized(["inbox", "claim", "--message", String(first.id), "--pane", "wT:p4"], "wT:p4");
  authorized(["inbox", "close", "--message", String(first.id), "--pane", "wT:p4"], "wT:p4");
  assert.equal(readPending("wT:p4").pending, 1);
  assert.equal(readPending("wT:p4").oldestPendingAt, second.createdAt, "oldest advances to the survivor");

  // Sweep repair must preserve the same derivation.
  unlinkSync(pendingFile("wT:p4"));
  json(runCli(["watch", "--once"]));
  assert.equal(readPending("wT:p4").oldestPendingAt, second.createdAt, "repair recomputes, not restores");
});

// The orchestrator is a deployment identity, not a pane: even a legal
// leader reply routed back to it (toPane = parent.fromPane) must never
// materialize pending/orchestrator.json.
test("a reply routed back to the orchestrator never materializes its record", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p4"]);
  const orchestrator = orchestratorToken();
  const sent = json(runCli(["send", "--from-pane", "orchestrator", "--to-pane", "wT:p1", "--text", "directive", "--token", orchestrator])).message;
  authorized(["send", "--from-pane", "wT:p1", "--reply", String(sent.id), "--text", "ack"], "wT:p1");
  assert.equal(existsSync(pendingFile("orchestrator")), false, "the reply must not create an orchestrator record");
  json(runCli(["watch", "--once"]));
  assert.equal(existsSync(pendingFile("orchestrator")), false, "and the sweep must not invent one");
});

// A non-directory planted at the pending path must not permanently wedge
// watch and pod close (ENOTDIR/EEXIST previously bricked every later call).
test("a file planted at the pending path self-heals on the next sweep", () => {
  const directory = isolatedState();
  registerPod("eng", ["wT:p1"]);
  mkdirSync(join(directory, "pending"));
  json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p1", "--text", "seed"], "wT:p1"));
  rmSync(join(directory, "pending"), { recursive: true });
  writeFileSync(join(directory, "pending"), "planted");

  json(runCli(["watch", "--once"]));
  assert.equal(readPending("wT:p1").pending, 1, "the sweep removes the foreign file and restores the directory");
});

// A pane legally named with ".tmp." inside keeps its own record: the stale
// temp predicate is anchored to the `<x>.json.tmp.` shape, not any ".tmp.".
test("a pane named with .tmp. inside keeps its record across sweeps", () => {
  const directory = isolatedState();
  registerPod("eng", ["wT:p1", "run.tmp.2"]);
  json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "run.tmp.2", "--text", "dotted pane"], "wT:p1"));
  json(runCli(["watch", "--once"]));
  assert.equal(readPending("run.tmp.2").pending, 1);
  json(runCli(["watch", "--once"]));
  assert.equal(existsSync(pendingFile("run.tmp.2")), true, "sweeps never churn a registered pane's record");
  assert.equal(listPendingDir().some((entry) => entry.includes(".json.tmp.")), false, "real temp files still get GC'd");
});

// A closed pod's members keep their messages as history, so a leftover nudge
// file would advertise pending work for a pane that can never authenticate
// again. The sweep converges the directory, not just registered panes.
test("the sweep removes nudge files for panes that are no longer registered", () => {
  isolatedState();
  registerPod("eng", ["wT:p1", "wT:p4"]);
  registerPod("ops", ["wT:p9"]);
  json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "unread at close"], "wT:p1"));
  assert.equal(readPending("wT:p4").pending, 1);

  json(runCli(["pod", "close", "--pod", "eng", "--orchestrator-token", orchestratorToken()]));

  json(runCli(["watch", "--once"]));
  assert.equal(listPendingDir().includes("wT:p4.json"), false, "deregistered pane file removed");
  assert.equal(existsSync(pendingFile("wT:p1")), false, "deregistered sender has no file either");
  assert.equal(readPending("wT:p9").pending, 0, "registered panes still converge");
});

// The sweep must survive junk in pending/: a directory entry (rm on a
// directory throws EISDIR and would brick every watch), an entry whose name
// could never be a pane, and a tmp file left by a crash between write and
// rename. The engine is the only intended writer; tolerate anything else.
test("the sweep tolerates non-file entries, invalid names, and stale tmp files", () => {
  const directory = isolatedState();
  registerPod("eng", ["wT:p1"]);
  json(authorized(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p1", "--text", "loop"], "wT:p1"));

  const pendingDir = join(directory, "pending");
  mkdirSync(join(pendingDir, "evil.json"));
  writeFileSync(join(pendingDir, "not a pane.json"), "{}");
  writeFileSync(pendingFile("wT:p1") + ".tmp.999999", "{}");

  json(runCli(["watch", "--once"]));

  assert.equal(readPending("wT:p1").pending, 1, "watch still converges registered panes");
  const entries = listPendingDir();
  assert.ok(entries.includes("evil.json"), "the foreign directory survives untouched");
  assert.equal(entries.includes("not a pane.json"), false, "unparseable record removed");
  assert.equal(entries.some((entry) => entry.includes(".tmp.")), false, "stale tmp file removed");
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
