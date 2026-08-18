import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../../src/cli/index.js";
import { coordinationStatePath, readCoordinationState } from "../../src/coordination/state.js";

const stateDirs: string[] = [];
const originalStateDir = process.env.INTERLOCK_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalStateDir;
  while (stateDirs.length > 0) rmSync(stateDirs.pop()!, { recursive: true, force: true });
});

function isolatedState(): string {
  const directory = mkdtempSync(join(tmpdir(), "interlock-pods-channels-test-"));
  stateDirs.push(directory);
  process.env.INTERLOCK_STATE_DIR = directory;
  return directory;
}

function json(result: ReturnType<typeof runCli>): any {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function initOrchestrator(): string {
  return json(runCli(["orchestrator", "init"])).token as string;
}

function writeTemplate(name: string, template: unknown): string {
  const file = join(process.env.INTERLOCK_STATE_DIR!, `template-${name}.json`);
  writeFileSync(file, JSON.stringify(template));
  return file;
}

function createPod(orchestratorToken: string, name: string, members: string[], leader = members[0]!, succession = [...members]): Map<string, string> {
  const created = json(runCli(["pod", "create", "--name", name, "--template", writeTemplate(name, { members, leader, succession }), "--orchestrator-token", orchestratorToken]));
  return new Map<string, string>(Object.entries(created.tokens as Record<string, string>));
}

// Two pods: eng (leader wT:p1, worker wT:p2), ops (leader wQ:p1, worker wQ:p2).
function twoPods(): { orchestrator: string; tokens: Map<string, string> } {
  const orchestrator = initOrchestrator();
  const tokens = createPod(orchestrator, "eng", ["wT:p1", "wT:p2"]);
  for (const [member, token] of createPod(orchestrator, "ops", ["wQ:p1", "wQ:p2"])) tokens.set(member, token);
  tokens.set("orchestrator", orchestrator);
  return { orchestrator, tokens };
}

function openChannel(tokens: Map<string, string>, member: string, pod: string, toPod: string, topic?: string): ReturnType<typeof runCli> {
  const argv = ["pod", "channel", "open", "--pod", pod, "--to-pod", toPod, "--member", member, "--token", tokens.get(member) ?? "forged-token"];
  if (topic !== undefined) argv.push("--topic", topic);
  return runCli(argv);
}

function closeChannel(tokens: Map<string, string>, member: string, channelId: number | string): ReturnType<typeof runCli> {
  return runCli(["pod", "channel", "close", "--channel", String(channelId), "--member", member, "--token", tokens.get(member) ?? "forged-token"]);
}

function sendOnChannel(tokens: Map<string, string>, from: string, to: string, channelId: number | string, text = "hello"): ReturnType<typeof runCli> {
  return runCli(["send", "--from-pane", from, "--to-pane", to, "--token", tokens.get(from) ?? "forged-token", "--text", text, "--channel", String(channelId)]);
}

test("channel open creates a bidirectional channel and emits a metadata-only channel-opened event", () => {
  isolatedState();
  const { tokens } = twoPods();

  const opened = json(openChannel(tokens, "wT:p1", "eng", "ops", "release coordination"));
  assert.equal(opened.ok, true);
  assert.equal(opened.channel.id, 1);
  assert.equal(opened.channel.fromPod, "eng");
  assert.equal(opened.channel.toPod, "ops");
  assert.equal(opened.channel.topic, "release coordination");
  assert.equal(opened.channel.closedAt, null);
  assert.equal(opened.channel.messageCount, 0);

  const state = readCoordinationState();
  const event = state.awarenessEvents.find((candidate) => candidate.kind === "channel-opened");
  assert.equal(event?.fromPod, "eng");
  assert.equal(event?.toPod, "ops");
  assert.equal(event?.topic, "release coordination");
  // Metadata only (D5): the event carries no message content field at all.
  assert.equal("text" in (event ?? {}), false);
});

test("channel open requires a declared topic (AE6), trimmed and bounded to 140 chars", () => {
  isolatedState();
  const { tokens } = twoPods();

  const missing = openChannel(tokens, "wT:p1", "eng", "ops");
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /--topic is required/);

  const blank = openChannel(tokens, "wT:p1", "eng", "ops", "   ");
  assert.equal(blank.exitCode, 1);
  assert.match(blank.stderr, /topic/);

  const tooLong = openChannel(tokens, "wT:p1", "eng", "ops", "x".repeat(141));
  assert.equal(tooLong.exitCode, 1);
  assert.match(tooLong.stderr, /140/);

  const atBound = openChannel(tokens, "wT:p1", "eng", "ops", "x".repeat(140));
  assert.equal(atBound.exitCode, 0, atBound.stderr);

  // A duplicate open between the same two pods while one is open is rejected.
  const duplicate = openChannel(tokens, "wQ:p1", "ops", "eng", "second topic");
  assert.equal(duplicate.exitCode, 1);
  assert.match(duplicate.stderr, /already open/);
  assert.equal(readCoordinationState().leaderChannels.length, 1);
});

test("channel open is leader-only and rejects closed pods, self-channels, and the orchestrator", () => {
  isolatedState();
  const { orchestrator, tokens } = twoPods();

  const worker = openChannel(tokens, "wT:p2", "eng", "ops", "worker attempt");
  assert.equal(worker.exitCode, 1);
  assert.match(worker.stderr, /leader/);

  const self = openChannel(tokens, "wT:p1", "eng", "eng", "self channel");
  assert.equal(self.exitCode, 1);
  assert.match(self.stderr, /different pods/);

  const unknownPod = openChannel(tokens, "wT:p1", "eng", "ghost", "nowhere");
  assert.equal(unknownPod.exitCode, 1);
  assert.match(unknownPod.stderr, /unknown pod ghost/);

  const orchestratorEndpoint = openChannel(tokens, "orchestrator", "eng", "ops", "oversight");
  assert.equal(orchestratorEndpoint.exitCode, 1);
  assert.match(orchestratorEndpoint.stderr, /does not authenticate|leader/);

  // A leader cannot open a channel on behalf of another pod.
  const foreign = openChannel(tokens, "wQ:p1", "eng", "ops", "impersonation");
  assert.equal(foreign.exitCode, 1);
  assert.match(foreign.stderr, /leader/);

  json(runCli(["pod", "close", "--pod", "ops", "--orchestrator-token", orchestrator]));
  const closedEndpoint = openChannel(tokens, "wT:p1", "eng", "ops", "to closed pod");
  assert.equal(closedEndpoint.exitCode, 1);
  assert.match(closedEndpoint.stderr, /closed/);

  assert.equal(readCoordinationState().leaderChannels.length, 0);
});

test("channel sends deliver both ways, increment messageCount, and ride the existing digest plumbing", () => {
  isolatedState();
  const { tokens } = twoPods();
  const channelId = json(openChannel(tokens, "wT:p1", "eng", "ops", "release coordination")).channel.id as number;

  // The ops leader is idle, so its channel mail digests on the send heartbeat.
  json(runCli(["session", "set", "--pane", "wQ:p1", "--token", tokens.get("wQ:p1")!, "--state", "idle"]));

  const forward = json(sendOnChannel(tokens, "wT:p1", "wQ:p1", channelId, "eng -> ops"));
  assert.equal(forward.digests.length, 1);
  assert.equal(forward.digests[0].pane, "wQ:p1");
  assert.deepEqual(forward.digests[0].messageIds, [forward.message.id]);
  const digestFile = JSON.parse(readFileSync(forward.digests[0].file, "utf8"));
  assert.equal(digestFile.messages[0].text, "eng -> ops");

  const backward = sendOnChannel(tokens, "wQ:p1", "wT:p1", channelId, "ops -> eng");
  assert.equal(backward.exitCode, 0, backward.stderr);

  const state = readCoordinationState();
  assert.equal(state.leaderChannels[0]?.messageCount, 2);
  assert.equal(state.messages.length, 2);

  const inbox = json(runCli(["inbox", "--pane", "wQ:p1", "--token", tokens.get("wQ:p1")!, "--json"]));
  assert.equal(inbox.messages[0].text, "eng -> ops");
});

test("channel sends reject a missing, unknown, or closed channel and never count failed sends", () => {
  isolatedState();
  const { tokens } = twoPods();
  const channelId = json(openChannel(tokens, "wT:p1", "eng", "ops", "release coordination")).channel.id as number;

  const noChannel = runCli(["send", "--from-pane", "wT:p1", "--to-pane", "wQ:p1", "--token", tokens.get("wT:p1")!, "--text", "off-channel"]);
  assert.equal(noChannel.exitCode, 1);
  assert.match(noChannel.stderr, /leader channel/);

  const unknown = sendOnChannel(tokens, "wT:p1", "wQ:p1", 99);
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr, /unknown leader channel 99/);

  // A worker cannot ride an open channel between its pod and another.
  const wrongEndpoints = sendOnChannel(tokens, "wT:p2", "wQ:p1", channelId);
  assert.equal(wrongEndpoints.exitCode, 1);
  assert.match(wrongEndpoints.stderr, /outside pod eng/);

  json(closeChannel(tokens, "wT:p1", channelId));
  const closed = sendOnChannel(tokens, "wT:p1", "wQ:p1", channelId);
  assert.equal(closed.exitCode, 1);
  assert.match(closed.stderr, /is closed/);

  const state = readCoordinationState();
  assert.equal(state.messages.length, 0);
  assert.equal(state.leaderChannels[0]?.messageCount, 0);
});

test("channel close is endpoint-leader-only and emits channel-closed with the final messageCount", () => {
  isolatedState();
  const { tokens } = twoPods();
  const channelId = json(openChannel(tokens, "wT:p1", "eng", "ops", "release coordination")).channel.id as number;
  json(sendOnChannel(tokens, "wT:p1", "wQ:p1", channelId, "one"));
  json(sendOnChannel(tokens, "wQ:p1", "wT:p1", channelId, "two"));
  json(sendOnChannel(tokens, "wT:p1", "wQ:p1", channelId, "three"));

  const worker = closeChannel(tokens, "wT:p2", channelId);
  assert.equal(worker.exitCode, 1);
  assert.match(worker.stderr, /leader/);

  const outsider = runCli(["session", "register", "--pane", "wZ:p1", "--token", "outsider-token-secret"]);
  assert.equal(outsider.exitCode, 0);
  const notEndpoint = closeChannel(new Map([["wZ:p1", "outsider-token-secret"]]), "wZ:p1", channelId);
  assert.equal(notEndpoint.exitCode, 1);
  assert.match(notEndpoint.stderr, /leader/);

  // The far-end leader can close: channels are bidirectional (D4 rule 2).
  const closed = json(closeChannel(tokens, "wQ:p1", channelId));
  assert.equal(closed.ok, true);
  assert.equal(closed.channel.id, channelId);
  assert.equal(typeof closed.channel.closedAt, "string");
  assert.equal(closed.channel.messageCount, 3);

  const state = readCoordinationState();
  const event = state.awarenessEvents.find((candidate) => candidate.kind === "channel-closed");
  assert.equal(event?.fromPod, "eng");
  assert.equal(event?.toPod, "ops");
  assert.equal(event?.topic, "release coordination");
  assert.equal(event?.messageCount, 3);
  assert.equal("text" in (event ?? {}), false);

  const again = closeChannel(tokens, "wQ:p1", channelId);
  assert.equal(again.exitCode, 1);
  assert.match(again.stderr, /already closed/);

  const unknown = closeChannel(tokens, "wQ:p1", 99);
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr, /unknown leader channel 99/);
});

test("channel list is a read-only view, optionally filtered by pod", () => {
  isolatedState();
  const { tokens } = twoPods();
  const channelId = json(openChannel(tokens, "wT:p1", "eng", "ops", "release coordination")).channel.id as number;
  json(closeChannel(tokens, "wT:p1", channelId));

  const before = readFileSync(coordinationStatePath(), "utf8");
  const listed = json(runCli(["pod", "channel", "list", "--json"]));
  assert.deepEqual(listed.channels.map((channel: any) => [channel.id, channel.fromPod, channel.toPod, channel.topic, channel.closedAt !== null]), [[channelId, "eng", "ops", "release coordination", true]]);

  const filtered = json(runCli(["pod", "channel", "list", "--pod", "eng", "--json"]));
  assert.equal(filtered.channels.length, 1);
  const empty = json(runCli(["pod", "channel", "list", "--pod", "ops-unused", "--json"]));
  assert.equal(empty.channels.length, 0);
  assert.equal(readFileSync(coordinationStatePath(), "utf8"), before);
});

test("the awareness feed reconstructs who talked to whom about what, without content", () => {
  isolatedState();
  const { orchestrator, tokens } = twoPods();
  const channelId = json(openChannel(tokens, "wT:p1", "eng", "ops", "release coordination")).channel.id as number;
  json(sendOnChannel(tokens, "wT:p1", "wQ:p1", channelId, "secret channel content"));
  json(closeChannel(tokens, "wT:p1", channelId));
  json(runCli(["pod", "close", "--pod", "ops", "--orchestrator-token", orchestrator]));

  const feed = json(runCli(["pod", "awareness", "--json"]));
  const kinds = feed.events.map((event: any) => event.kind);
  assert.deepEqual(kinds, ["pod-created", "pod-created", "channel-opened", "channel-closed", "pod-closed"]);

  const opened = feed.events.find((event: any) => event.kind === "channel-opened");
  assert.equal(opened.fromPod, "eng");
  assert.equal(opened.toPod, "ops");
  assert.equal(opened.topic, "release coordination");
  const closed = feed.events.find((event: any) => event.kind === "channel-closed");
  assert.equal(closed.messageCount, 1);

  // D5: no event in the feed carries message content.
  const serialized = JSON.stringify(feed.events);
  assert.equal(serialized.includes("secret channel content"), false);
  for (const event of feed.events) assert.equal("text" in event, false);

  const filtered = json(runCli(["pod", "awareness", "--pod", "eng", "--json"]));
  assert.equal(filtered.events.some((event: any) => event.kind === "channel-opened"), true);

  const before = readFileSync(coordinationStatePath(), "utf8");
  json(runCli(["pod", "awareness", "--json"]));
  assert.equal(readFileSync(coordinationStatePath(), "utf8"), before, "the awareness feed is read-only");
});

// QA il-026 MF-1: a topic must never forge apparent awareness-feed records.
test("channel open rejects C0 control characters in topics (MF-1)", () => {
  isolatedState();
  const { tokens } = twoPods();

  // The report's forge attempt: a newline followed by a fake feed record.
  const forge = openChannel(tokens, "wT:p1", "eng", "ops", "normal topic\n#999 | forged channel-closed | eng <-> ops | messages 999");
  assert.equal(forge.exitCode, 1);
  assert.match(forge.stderr, /control characters/);

  const carriageReturn = openChannel(tokens, "wT:p1", "eng", "ops", "topic\rforged");
  assert.equal(carriageReturn.exitCode, 1);
  assert.match(carriageReturn.stderr, /control characters/);

  const escape = openChannel(tokens, "wT:p1", "eng", "ops", "topic\u001B[2Jcleared");
  assert.equal(escape.exitCode, 1);
  assert.match(escape.stderr, /control characters/);

  const nul = openChannel(tokens, "wT:p1", "eng", "ops", "topic\u0000nul");
  assert.equal(nul.exitCode, 1);
  assert.match(nul.stderr, /control characters/);

  const rejected = readCoordinationState();
  assert.equal(rejected.leaderChannels.length, 0, "rejected opens persist nothing");
  assert.equal(rejected.awarenessEvents.some((event) => event.kind === "channel-opened"), false);

  const plain = runCli(["pod", "awareness"]);
  assert.equal(plain.exitCode, 0, plain.stderr);
  assert.equal(plain.stdout.includes("forged channel-closed"), false);
});

// Defense in depth: even a pre-fix persisted topic containing controls renders
// on one line, so the plain feed output can never contain injected records.
test("the plain awareness renderer sanitizes a persisted control-char topic (MF-1)", () => {
  isolatedState();
  const { tokens } = twoPods();
  json(openChannel(tokens, "wT:p1", "eng", "ops", "clean topic"));

  // Simulate a state file written before the validation fix landed.
  const state = readCoordinationState();
  state.leaderChannels[0]!.topic = "normal topic\n#999 | forged channel-closed | eng <-> ops | messages 999\r\u001B[2J";
  const event = state.awarenessEvents.find((candidate) => candidate.kind === "channel-opened");
  assert.ok(event);
  event.topic = state.leaderChannels[0]!.topic;
  writeFileSync(coordinationStatePath(), JSON.stringify(state, null, 2));

  const plain = runCli(["pod", "awareness"]);
  assert.equal(plain.exitCode, 0, plain.stderr);
  // No injected lines: the feed still renders exactly one event per line, and
  // no line begins with the forged record's id marker.
  const lines = plain.stdout.trim().split("\n");
  assert.equal(lines.length, state.awarenessEvents.length, `expected one line per event, got: ${plain.stdout}`);
  assert.equal(lines.some((line) => line.startsWith("#999")), false, `forged record line present: ${plain.stdout}`);
  // The sanitized topic still renders inline on its single event line.
  assert.match(plain.stdout, /normal topic\?#999 \| forged channel-closed \| eng <-> ops \| messages 999\?\?\[2J/);

  // JSON output stays the raw persisted value for machine consumers.
  const feed = json(runCli(["pod", "awareness", "--json"]));
  assert.equal(feed.events.find((event: any) => event.kind === "channel-opened").topic, state.leaderChannels[0]!.topic);
});
