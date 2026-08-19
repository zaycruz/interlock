// OQ3: scale limits enforced at pod create time — a deployment caps the
// number of pods (open or closed) and each pod's roster size, with refusal
// errors that name the limit.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../../src/cli/index.js";
import { MAX_PODS_PER_DEPLOYMENT, MAX_ROSTER_SIZE } from "../../src/coordination/index.js";
import { readCoordinationState } from "../../src/coordination/state.js";

const stateDirs: string[] = [];
const originalStateDir = process.env.INTERLOCK_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalStateDir;
  while (stateDirs.length > 0) rmSync(stateDirs.pop()!, { recursive: true, force: true });
});

function isolatedState(): string {
  const directory = mkdtempSync(join(tmpdir(), "interlock-pods-scale-test-"));
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

function tryCreatePod(orchestrator: string, name: string, members: string[]): ReturnType<typeof runCli> {
  const template = join(process.env.INTERLOCK_STATE_DIR!, `template-${name}.json`);
  writeFileSync(template, JSON.stringify({ members, leader: members[0]!, succession: [...members] }));
  return runCli(["pod", "create", "--name", name, "--template", template, "--orchestrator-token", orchestrator]);
}

function members(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

test("pod create refuses a roster larger than MAX_ROSTER_SIZE", () => {
  assert.equal(MAX_ROSTER_SIZE, 16);
  isolatedState();
  const orchestrator = initOrchestrator();

  const over = tryCreatePod(orchestrator, "eng", members("wT:p", MAX_ROSTER_SIZE + 1));
  assert.equal(over.exitCode, 1);
  assert.match(over.stderr, new RegExp(`exceeds the maximum of ${MAX_ROSTER_SIZE}`));

  // At the limit is allowed, and the failed attempt left no partial state.
  json(tryCreatePod(orchestrator, "eng", members("wT:p", MAX_ROSTER_SIZE)));
  const state = readCoordinationState();
  assert.equal(state.pods.length, 1);
  assert.equal(state.podMembers.length, MAX_ROSTER_SIZE);
});

test("pod create refuses beyond MAX_PODS_PER_DEPLOYMENT, counting closed pods", () => {
  assert.equal(MAX_PODS_PER_DEPLOYMENT, 64);
  isolatedState();
  const orchestrator = initOrchestrator();

  for (let index = 0; index < MAX_PODS_PER_DEPLOYMENT; index += 1) {
    json(tryCreatePod(orchestrator, `pod-${index}`, [`w${index}:p1`]));
  }
  // Closing a pod does not free a slot: its roster persists as history and
  // its name is never reusable, so it still consumes the budget.
  json(runCli(["pod", "close", "--pod", "pod-0", "--orchestrator-token", orchestrator]));

  const over = tryCreatePod(orchestrator, "one-too-many", ["wX:p1"]);
  assert.equal(over.exitCode, 1);
  assert.match(over.stderr, new RegExp(`maximum of ${MAX_PODS_PER_DEPLOYMENT} pods`));

  const state = readCoordinationState();
  assert.equal(state.pods.length, MAX_PODS_PER_DEPLOYMENT);
  assert.equal(state.pods.some((pod) => pod.name === "one-too-many"), false);
  assert.equal(state.podMembers.some((member) => member.member === "wX:p1"), false);
});
