import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { runCli } from "../../src/cli/index.js";
import { coordinationStatePath } from "../../src/coordination/index.js";

const original = process.env.INTERLOCK_STATE_DIR;
let directory: string;
let tokens: Record<string, string>;
function json(args: string[], pane?: string) {
  const result = runCli(pane ? [...args, "--token", tokens[pane]!] : args);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function setup() {
  directory = mkdtempSync(join(tmpdir(), "interlock-retry-"));
  process.env.INTERLOCK_STATE_DIR = directory;
  const token = json(["orchestrator", "init"]).token;
  const template = join(directory, "pod.json");
  writeFileSync(template, JSON.stringify({ members: ["one", "two", "three"], leader: "one", succession: ["one", "two", "three"] }));
  tokens = json(["pod", "create", "--name", "team", "--template", template, "--orchestrator-token", token]).tokens;
  json(["task", "add", "--id", "task1", "--title", "Work", "--value", "Value", "--pane", "one"], "one");
}
afterEach(() => {
  if (original === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = original;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test("lost-response reply retry survives compaction without duplicate effects", () => {
  setup();
  const first = json(["send", "--from-pane", "one", "--to-pane", "two", "--task", "task1", "--text", "Question"], "one").message;
  const args = ["send", "--from-pane", "two", "--reply", String(first.id), "--text", "Answer", "--request-id", "answer1"];
  const reply = json(args, "two").message;
  assert.equal(reply.taskId, "task1");
  json(["inbox", "claim", "--message", String(reply.id), "--pane", "one"], "one");
  json(["inbox", "close", "--message", String(reply.id), "--pane", "one"], "one");
  json(["compact"]);
  const retried = json(args, "two");
  assert.equal(retried.message.id, reply.id);
  assert.equal(retried.message.state, "closed");
  assert.equal(retried.deduplicated, true);
  const state = JSON.parse(readFileSync(coordinationStatePath(), "utf8"));
  assert.equal(state.messages.length, 2);
  assert.equal(state.nextMessageId, reply.id + 1);
  assert.equal(json(["inbox", "--pane", "one", "--task", "task1", "--json"], "one").messages.length, 1);
  assert.equal(json(["inbox", "--pane", "three", "--thread", String(first.id), "--json"], "three").messages.length, 0);
});

test("request keys reject changed payload and require authentication", () => {
  setup();
  const args = ["send", "--from-pane", "one", "--to-pane", "two", "--text", "Original", "--request-id", "key"];
  json(args, "one");
  const conflict = runCli([...args, "--text", "Changed", "--token", tokens.one!]);
  assert.equal(conflict.exitCode, 1);
  assert.match(conflict.stderr, /request.*conflict/i);
  assert.equal(runCli([...args, "--token", "wrong"]).exitCode, 1);
  assert.equal(json(["send", "--from-pane", "two", "--to-pane", "one", "--text", "Other", "--request-id", "key"], "two").deduplicated, false);
});

test("task association rejects missing tasks and conflicting replies", () => {
  setup();
  const args = ["send", "--from-pane", "one", "--to-pane", "two", "--text", "Question"];
  assert.equal(runCli([...args, "--task", "missing", "--token", tokens.one!]).exitCode, 1);
  const first = json([...args, "--task", "task1"], "one").message;
  assert.equal(runCli(["send", "--from-pane", "two", "--reply", String(first.id), "--task", "different", "--text", "Answer", "--token", tokens.two!]).exitCode, 1);
});

test("inbox summary bounds pointers and does not write state or repair digest files", () => {
  setup();
  json(["session", "set", "--pane", "two", "--state", "idle"], "two");
  for (let i = 0; i < 22; i++) json(["send", "--from-pane", "one", "--to-pane", "two", "--text", `Message ${i}`], "one");
  const path = coordinationStatePath();
  const before = readFileSync(path, "utf8");
  const missingDigest = JSON.parse(before).digests[0].file;
  rmSync(missingDigest);
  const summary = json(["inbox", "summary", "--pane", "two"], "two");
  assert.deepEqual(summary.pending, { queued: 22, claimed: 0, total: 22 });
  assert.equal(summary.digests.length, 20);
  assert.equal(summary.digestTotal, 22);
  assert.equal(summary.digestsTruncated, true);
  assert.equal(summary.messages, undefined);
  assert.equal(existsSync(missingDigest), false);
  assert.equal(runCli(["inbox", "summary", "--pane", "two", "--token", "wrong"]).exitCode, 1);
  assert.equal(readFileSync(path, "utf8"), before);
});


test("channel retry retains its receipt after channel close without recounting", () => {
  setup();
  const orchestrator = json(["orchestrator", "init", "--rotate"]).token;
  const template = join(directory, "other.json");
  writeFileSync(template, JSON.stringify({ members: ["four"], leader: "four", succession: ["four"] }));
  json(["pod", "create", "--name", "other", "--template", template, "--orchestrator-token", orchestrator]);
  const channel = json(["pod", "channel", "open", "--pod", "team", "--to-pod", "other", "--member", "one", "--topic", "Work"], "one").channel;
  const args = ["send", "--from-pane", "one", "--to-pane", "four", "--text", "Result", "--channel", String(channel.id), "--request-id", "channel1"];
  const first = json(args, "one");
  json(["pod", "channel", "close", "--channel", String(channel.id), "--member", "one"], "one");
  const retry = json(args, "one");
  assert.equal(retry.message.id, first.message.id);
  assert.deepEqual(retry.digests, []);
  const state = JSON.parse(readFileSync(coordinationStatePath(), "utf8"));
  assert.equal(state.leaderChannels[0].messageCount, 1);
  for (const changed of [["--to-pane", "two"], ["--channel", "999"], ["--workspace", "different"], ["--task", "task1"]]) {
    const result = runCli([...args, ...changed, "--token", tokens.one!]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /request_id_conflict/);
  }
});

test("unlinked reply receipts retain ancestors across compaction", () => {
  setup();
  const first = json(["send", "--from-pane", "one", "--to-pane", "two", "--text", "Question"], "one").message;
  const args = ["send", "--from-pane", "two", "--reply", String(first.id), "--text", "Answer", "--request-id", "unlinked"];
  const reply = json(args, "two").message;
  json(["send", "--from-pane", "one", "--reply", String(reply.id), "--text", "Thanks"], "one");
  json(["compact"]);
  assert.equal(json(args, "two").message.id, reply.id);
  assert.equal(JSON.parse(readFileSync(coordinationStatePath(), "utf8")).messages.length, 3);
});
