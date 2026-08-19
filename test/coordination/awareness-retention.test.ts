// OQ2: the awareness feed is capped at the most recent
// AWARENESS_FEED_MAX_EVENTS events, enforced on every event write so the
// persisted state file can never outgrow the bound.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../../src/cli/index.js";
import { AWARENESS_FEED_MAX_EVENTS } from "../../src/coordination/index.js";
import { readCoordinationState } from "../../src/coordination/state.js";

const stateDirs: string[] = [];
const originalStateDir = process.env.INTERLOCK_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalStateDir;
  while (stateDirs.length > 0) rmSync(stateDirs.pop()!, { recursive: true, force: true });
});

function isolatedState(): string {
  const directory = mkdtempSync(join(tmpdir(), "interlock-awareness-retention-test-"));
  stateDirs.push(directory);
  process.env.INTERLOCK_STATE_DIR = directory;
  return directory;
}

function json(result: ReturnType<typeof runCli>): any {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function twoPods(): { orchestrator: string; tokens: Map<string, string> } {
  const orchestrator = json(runCli(["orchestrator", "init"])).token as string;
  const tokens = new Map<string, string>();
  for (const [name, members] of [["eng", ["wT:p1", "wT:p2"]], ["ops", ["wQ:p1", "wQ:p2"]]] as const) {
    const template = join(process.env.INTERLOCK_STATE_DIR!, `template-${name}.json`);
    writeFileSync(template, JSON.stringify({ members, leader: members[0], succession: [...members] }));
    const created = json(runCli(["pod", "create", "--name", name, "--template", template, "--orchestrator-token", orchestrator]));
    for (const [member, token] of Object.entries(created.tokens as Record<string, string>)) tokens.set(member, token);
  }
  return { orchestrator, tokens };
}

function openChannel(tokens: Map<string, string>, topic: string): number {
  return json(runCli(["pod", "channel", "open", "--pod", "eng", "--to-pod", "ops", "--member", "wT:p1", "--token", tokens.get("wT:p1")!, "--topic", topic])).channel.id as number;
}

function closeChannel(tokens: Map<string, string>, id: number): void {
  json(runCli(["pod", "channel", "close", "--channel", String(id), "--member", "wT:p1", "--token", tokens.get("wT:p1")!]));
}

test("awareness feed is capped at AWARENESS_FEED_MAX_EVENTS on write", () => {
  assert.equal(AWARENESS_FEED_MAX_EVENTS, 1000);
  isolatedState();
  const { tokens } = twoPods();

  // Each open/close churn pair appends two events; overflow the cap.
  const churn = Math.ceil((AWARENESS_FEED_MAX_EVENTS + 20) / 2);
  for (let index = 0; index < churn; index += 1) {
    closeChannel(tokens, openChannel(tokens, `churn ${index}`));
  }

  const state = readCoordinationState();
  assert.equal(state.awarenessEvents.length, AWARENESS_FEED_MAX_EVENTS);
  // The retained events are the most recent: ids form the highest contiguous
  // run, and the counter floor keeps climbing so ids are never reused.
  const ids = state.awarenessEvents.map((event) => event.id);
  assert.deepEqual(ids, Array.from({ length: AWARENESS_FEED_MAX_EVENTS }, (_, offset) => ids[0]! + offset));
  assert.equal(ids[ids.length - 1]! + 1, state.nextAwarenessEventId);
  // The earliest events (pod-created) have aged out; the newest are the churn.
  assert.equal(state.awarenessEvents.some((event) => event.kind === "pod-created"), false);
  assert.equal(state.awarenessEvents[ids.length - 1]!.kind, "channel-closed");

  // The feed stays readable through the public view.
  const feed = json(runCli(["pod", "awareness", "--json"]));
  assert.equal(feed.events.length, AWARENESS_FEED_MAX_EVENTS);
});

test("awareness feed under the cap keeps every event in append order", () => {
  isolatedState();
  const { tokens } = twoPods();
  closeChannel(tokens, openChannel(tokens, "one and only"));

  const state = readCoordinationState();
  const kinds = state.awarenessEvents.map((event) => event.kind);
  assert.deepEqual(kinds, ["pod-created", "pod-created", "channel-opened", "channel-closed"]);
});
