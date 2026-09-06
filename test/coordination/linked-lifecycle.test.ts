import { once } from "node:events";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { runLinkedTask } from "../../src/application/linked-tasks.js";
import { readTaskContract, canonicalRepository } from "../../src/application/linked-contract.js";
import { runLeaseCommand } from "../../src/application/lease-commands.js";
import type { BeadsClient } from "../../src/beads/index.js";
import type { BeadsIssue, InterlockMetadata, InterlockRecoveryMarker } from "../../src/contracts/index.js";
import { currentProcessIdentity, processIdentityFor, openLeaseStore } from "../../src/core/index.js";
import { coordinationStatePath, readCoordinationState, registerMemberToken, withCoordinationLock } from "../../src/coordination/state.js";
import { taskCommand } from "../../src/coordination/task-commands.js";
import { createLinkedWorktree, createTestRepository, type TestRepository } from "../helpers/git-repository.js";

// These tests prove cross-store ownership and evidence behavior through public operations.
const repositories: TestRepository[] = [];
const original = process.env.INTERLOCK_STATE_DIR;
const pane = "worker-a";
const token = "worker-a-token-with-enough-entropy";
afterEach(() => { if (original === undefined) delete process.env.INTERLOCK_STATE_DIR; else process.env.INTERLOCK_STATE_DIR = original; while (repositories.length) repositories.pop()!.remove(); });

class Beads implements BeadsClient {
  issue: BeadsIssue = { id: "il-1", title: "Contract", description: "Value: Safe work\nWork: Change file", acceptanceCriteria: "check passes", status: "open", assignee: undefined, metadata: {}, metadataMalformed: false };
  failClaim = false; failClose = false; failRecover = false; closeCalls = 0; failReadOnce = false; failCloseBefore = false;
  getIssue() { if (this.failReadOnce) { this.failReadOnce = false; throw new Error("temporary read failure"); } return structuredClone(this.issue); }
  dependencies() { return []; }
  dependents() { return []; }
  claim(_id: string, actor: string, metadata: InterlockMetadata) {
    const saved = readCoordinationState().tasks[0]!.execution!;
    assert.equal(saved.contractId, metadata.contractId); assert.equal(saved.phase, "claim-pending");
    this.issue.status = "in_progress"; this.issue.assignee = actor; this.issue.metadata = { interlock: metadata };
    if (this.failClaim) throw new Error("lost claim response");
  }
  heartbeat(_id: string, metadata: InterlockMetadata) { this.issue.metadata = { interlock: metadata }; }
  close() { this.closeCalls += 1; if (this.failCloseBefore) throw new Error("close failed before mutation"); this.issue.status = "closed"; if (this.failClose) throw new Error("lost close response"); }
  recover(_id: string, marker: InterlockRecoveryMarker) { this.issue.status = "open"; this.issue.assignee = undefined; this.issue.metadata = { "interlock.recovery": marker }; if (this.failRecover) throw new Error("lost recovery response"); }
}

function fixture(command = [process.execPath, "-e", "process.exit(0)"]) {
  const repo = createTestRepository(); repositories.push(repo);
  process.env.INTERLOCK_STATE_DIR = join(repo.path, "state");
  const beads = new Beads();
  const linked = readTaskContract(repo.path, { beadId: beads.issue.id, paths: ["owned.txt"], checks: [{ criterion: "check passes", command }] }, beads);
  withCoordinationLock((state) => {
    registerMemberToken(state, pane, token); registerMemberToken(state, "worker-b", "worker-b-token-with-enough-entropy");
    state.tasks.push({ id: "task-1", ...linked, workspace: repo.path, creator: pane, ownerPane: null, claimer: null, blocker: null,
      stage: "open", createdAt: new Date().toISOString(), lastProgressAt: new Date().toISOString(), revision: 1 });
  });
  const dependencies = { beads, openLeaseStore: (path: string) => openLeaseStore(path, { processInspector: () => "alive" }) };
  const request = { id: "task-1", pane, token, sessionPid: process.pid };
  return { repo, beads, dependencies, request };
}
const result = { summary: "Implemented and verified", artifacts: ["owned.txt"] };
function current() { return readCoordinationState().tasks[0]!; }
function cli(args: string[]) { return taskCommand([...args, "--pane", pane, "--token", token]); }

test("linked claim reserves exact identity before Beads, captures immutable scope, and completes with observed evidence", () => {
  const { dependencies, request, beads, repo } = fixture();
  const task = runLinkedTask({ ...request, operation: "claim" }, dependencies);
  assert.equal(task.execution!.phase, "active"); assert.deepEqual(task.execution!.process, currentProcessIdentity());
  assert.equal(task.execution!.acceptance, beads.issue.acceptanceCriteria);
  assert.throws(() => runLinkedTask({ ...request, operation: "claim" }, dependencies), /claim_conflict/);
  assert.throws(() => cli(["stage", "task-1", "done"]), /cannot bypass/);
  assert.throws(() => runLeaseCommand({ name: "complete", beadId: "il-1", repositoryPath: repo.path }, dependencies), /authenticated task commands/);
  assert.throws(() => runLeaseCommand({ name: "complete", beadId: "il-1", repositoryPath: repo.path }, { ...dependencies, linkedAuthority: { pane, token } }), /requires a result/);
  const done = runLinkedTask({ ...request, operation: "complete", result }, dependencies);
  assert.equal(done.stage, "done"); assert.equal(done.execution!.phase, "done");
  assert.equal(done.execution!.verification![0]!.source, "interlock-executed"); assert.equal(done.execution!.verification![0]!.passed, true);
  assert.equal(done.execution!.result!.source, "agent-declared"); assert.equal(beads.closeCalls, 1);
  const store = openLeaseStore(repo.path); assert.equal(store.getWorkContractByBeadId("il-1"), undefined); store.close();
});

test("failed verification preserves ownership and captures the actual failed result", () => {
  const { dependencies, request, beads } = fixture([process.execPath, "-e", "process.exit(7)"]);
  runLinkedTask({ ...request, operation: "claim" }, dependencies);
  assert.throws(() => runLinkedTask({ ...request, operation: "complete", result }, dependencies), /verification failed/);
  assert.equal(current().execution!.verification![0]!.exitCode, 7); assert.equal(current().execution!.phase, "active"); assert.equal(beads.closeCalls, 0);
});

test("changed acceptance and staged paths outside scope block completion", () => {
  const { dependencies, request, beads, repo } = fixture(); runLinkedTask({ ...request, operation: "claim" }, dependencies);
  beads.issue.acceptanceCriteria = "new criterion";
  assert.throws(() => runLinkedTask({ ...request, operation: "complete", result }, dependencies), /acceptance changed/);
  beads.issue.acceptanceCriteria = "check passes";
  writeFileSync(join(repo.path, "outside.txt"), "outside"); execFileSync("git", ["-C", repo.path, "add", "outside.txt"]);
  assert.throws(() => runLinkedTask({ ...request, operation: "complete", result }, dependencies), /outside this work contract/);
  assert.equal(beads.closeCalls, 0);
});

test("lost claim and close responses retain exact intents and reconcile without duplicate close", () => {
  const { dependencies, request, beads } = fixture(); beads.failClaim = true;
  assert.throws(() => runLinkedTask({ ...request, operation: "claim" }, dependencies), /ambiguous/);
  const contractId = current().execution!.contractId;
  assert.equal(current().execution!.phase, "claim-pending");
  beads.failClaim = false;
  runLinkedTask({ ...request, operation: "resolve" }, dependencies);
  assert.equal(current().execution!.contractId, contractId); assert.equal(current().execution!.phase, "active");
  beads.failClose = true;
  assert.throws(() => runLinkedTask({ ...request, operation: "complete", result }, dependencies), /pending/);
  assert.equal(current().execution!.phase, "completion-pending");
  beads.failClose = false; runLinkedTask({ ...request, operation: "resolve" }, dependencies);
  assert.equal(current().execution!.phase, "done"); assert.equal(beads.closeCalls, 1);
});

test("release convergence retains checkpoint and history for the next owner", () => {
  const { dependencies, request, beads } = fixture(); runLinkedTask({ ...request, operation: "claim" }, dependencies);
  cli(["checkpoint", "task-1", "--text", "continue from parser"]);
  beads.failRecover = true;
  assert.throws(() => runLinkedTask({ ...request, operation: "release", reason: "handoff" }, dependencies), /pending/);
  assert.equal(current().execution!.phase, "release-pending");
  beads.failRecover = false; runLinkedTask({ ...request, operation: "resolve" }, dependencies);
  assert.equal(current().stage, "open"); assert.equal(current().checkpoint, "continue from parser");
  runLinkedTask({ ...request, operation: "claim" }, dependencies);
  assert.equal(current().executionHistory!.length, 1); assert.equal(current().executionHistory![0]!.phase, "released");
});

test("live process recovery and unauthorized mutation are refused", () => {
  const { dependencies, request } = fixture(); runLinkedTask({ ...request, operation: "claim" }, dependencies);
  assert.throws(() => runLinkedTask({ ...request, operation: "recover" }, dependencies), /death is not verified/);
  assert.throws(() => runLinkedTask({ ...request, pane: "worker-b", token: "worker-b-token-with-enough-entropy", operation: "release", reason: "steal" }, dependencies), /only the task owner/);
});

test("canonical identity spans worktrees and duplicate persisted links refuse load", () => {
  const { repo } = fixture(); const worktree = createLinkedWorktree(repo); repositories.push(worktree);
  assert.equal(canonicalRepository(repo.path), canonicalRepository(worktree.path));
  withCoordinationLock((state) => { state.tasks.push({ ...state.tasks[0]!, id: "duplicate" }); });
  assert.throws(() => readCoordinationState(), /duplicate canonical/);
});

test("version-2 upgrade preserves queued messages and tasks; resume does not write state", () => {
  fixture(); const path = coordinationStatePath(); const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.version = 2; delete raw.tasks[0].contract;
  raw.messages = [{ id: 1, threadId: 1, replyTo: null, fromPane: pane, toPane: "worker-b", workspace: null, text: "keep", state: "queued", claimer: null, createdAt: new Date().toISOString() }];
  writeFileSync(path, JSON.stringify(raw)); const before = readFileSync(path, "utf8");
  const upgraded = readCoordinationState(); assert.equal(upgraded.version, 3); assert.equal(upgraded.messages[0]!.text, "keep");
  cli(["resume"]); assert.equal(readFileSync(path, "utf8"), before);
  withCoordinationLock(() => undefined); assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 3);
});

test("task corrections require the current revision and withdrawal preserves history", () => {
  fixture();
  withCoordinationLock((state) => { delete state.tasks[0]!.contract; });
  assert.throws(() => cli(["update", "task-1", "--revision", "9", "--title", "wrong"]), /revision conflict/);
  cli(["update", "task-1", "--revision", "1", "--title", "corrected"]);
  assert.equal(current().title, "corrected"); assert.equal(current().revision, 2);
  cli(["withdraw", "task-1", "--revision", "2", "--reason", "obsolete"]);
  assert.equal(current().stage, "closed"); assert.equal(current().withdrawalReason, "obsolete");
  assert.throws(() => cli(["claim", "task-1"]), /claim_conflict/);
});

test("expected contract guard prevents release of a replacement execution", () => {
  const { dependencies, request } = fixture(); runLinkedTask({ ...request, operation: "claim" }, dependencies);
  const first = current().execution!.contractId;
  runLinkedTask({ ...request, operation: "release", reason: "retry" }, dependencies);
  runLinkedTask({ ...request, operation: "claim" }, dependencies);
  assert.throws(() => runLinkedTask({ ...request, operation: "release", reason: "stale caller", expectedContractId: first }, dependencies), /expected execution contract changed/);
  assert.equal(current().execution!.phase, "active");
});


test("verified dead execution can be recovered by another member and retains the checkpoint", async () => {
  const { dependencies, request } = fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const identity = processIdentityFor(child.pid!);
  try {
    runLinkedTask({ ...request, operation: "claim", sessionPid: child.pid! }, { ...dependencies, processIdentityFor: () => identity });
    cli(["checkpoint", "task-1", "--text", "resume at check"]);
  } finally { child.kill("SIGKILL"); await once(child, "exit"); }
  const recovered = runLinkedTask({ ...request, pane: "worker-b", token: "worker-b-token-with-enough-entropy", operation: "recover" }, dependencies);
  assert.equal(recovered.stage, "open"); assert.equal(recovered.execution!.phase, "released"); assert.equal(recovered.checkpoint, "resume at check");
});


test("release intent resumes after preflight fails before the SQLite recovery event", () => {
  const { dependencies, request, beads } = fixture(); runLinkedTask({ ...request, operation: "claim" }, dependencies);
  beads.failReadOnce = true;
  assert.throws(() => runLinkedTask({ ...request, operation: "release", reason: "handoff" }, dependencies), /temporary read failure/);
  assert.equal(current().execution!.phase, "release-pending");
  runLinkedTask({ ...request, operation: "resolve" }, dependencies);
  assert.equal(current().execution!.phase, "released"); assert.equal(current().stage, "open");
});

test("completion intent resumes after failure before the SQLite completion event", () => {
  const { dependencies, request } = fixture(); runLinkedTask({ ...request, operation: "claim" }, dependencies);
  let failOnce = true;
  const injected = { ...dependencies, openLeaseStore: (path: string) => {
    const store = dependencies.openLeaseStore(path);
    const begin = store.beginCompletion.bind(store);
    store.beginCompletion = (input) => { if (failOnce) { failOnce = false; throw new Error("before completion event"); } return begin(input); };
    return store;
  } };
  assert.throws(() => runLinkedTask({ ...request, operation: "complete", result }, injected), /before completion event/);
  assert.equal(current().execution!.phase, "completion-pending");
  runLinkedTask({ ...request, operation: "resolve" }, dependencies);
  assert.equal(current().execution!.phase, "done");
});

test("implicit reconciliation during another claim cannot bypass changed linked acceptance", () => {
  const { dependencies, request, beads, repo } = fixture(); runLinkedTask({ ...request, operation: "claim" }, dependencies);
  beads.failCloseBefore = true;
  assert.throws(() => runLinkedTask({ ...request, operation: "complete", result }, dependencies), /pending/);
  beads.failCloseBefore = false; beads.issue.acceptanceCriteria = "changed acceptance";
  const other: BeadsClient = { ...beads, getIssue: (id) => id === "other" ? { ...beads.getIssue(), id, status: "open", assignee: undefined, metadata: {} } : beads.getIssue(),
    dependencies: () => [], dependents: () => [], claim: () => assert.fail("must not claim"), close: () => assert.fail("must not close"), recover: () => assert.fail("must not recover"), heartbeat: () => undefined };
  assert.throws(() => runLeaseCommand({ name: "claim", beadId: "other", actor: pane, sessionPid: process.pid, paths: ["other.txt"], repositoryPath: repo.path },
    { ...dependencies, beads: other, linkedAuthority: { pane, token } }), /acceptance changed/);
  assert.equal(beads.issue.status, "in_progress"); assert.equal(beads.closeCalls, 1);
});

test("active legacy contracts cannot be attached under a guessed execution identity", () => {
  const { dependencies, request, beads, repo } = fixture(); runLinkedTask({ ...request, operation: "claim" }, dependencies);
  assert.throws(() => readTaskContract(repo.path, { beadId: "il-1", paths: ["owned.txt"], checks: current().contract!.checks }, beads), /existing.*contract/);
});

test("different owners can resolve their own pending intents without taking each other's authority", () => {
  const { dependencies, request, beads, repo } = fixture();
  const second = new Beads(); second.issue.id = "il-2";
  second.claim = (_id, actor, metadata) => { second.issue.status = "in_progress"; second.issue.assignee = actor; second.issue.metadata = { interlock: metadata }; };
  const clients = (id: string) => id === "il-1" ? beads : second;
  const both: BeadsClient = {
    getIssue: (id) => clients(id).getIssue(), dependencies: () => [], dependents: () => [],
    claim: (id, actor, metadata) => clients(id).claim(id, actor, metadata), heartbeat: (id, metadata) => clients(id).heartbeat(id, metadata),
    close: (id) => clients(id).close(), recover: (id, marker) => clients(id).recover(id, marker),
  };
  const deps = { ...dependencies, beads: both };
  const linked = readTaskContract(repo.path, { beadId: "il-2", paths: ["second.txt"], checks: current().contract!.checks }, both);
  withCoordinationLock((state) => state.tasks.push({ ...state.tasks[0]!, ...linked, id: "task-2", creator: "worker-b" }));
  const other = { ...request, id: "task-2", pane: "worker-b", token: "worker-b-token-with-enough-entropy" };
  runLinkedTask({ ...request, operation: "claim" }, deps); runLinkedTask({ ...other, operation: "claim" }, deps);
  beads.failCloseBefore = true;
  assert.throws(() => runLinkedTask({ ...request, operation: "complete", result }, deps), /pending/);
  second.failRecover = true;
  assert.throws(() => runLinkedTask({ ...other, operation: "release", reason: "handoff" }, deps), /pending/);
  beads.failCloseBefore = false;
  runLinkedTask({ ...request, operation: "resolve" }, deps);
  assert.equal(current().execution!.phase, "done");
  assert.equal(readCoordinationState().tasks[1]!.execution!.phase, "release-pending");
  second.failRecover = false; runLinkedTask({ ...other, operation: "resolve" }, deps);
  assert.equal(readCoordinationState().tasks[1]!.execution!.phase, "released");
});


test("pre-lease reservation failure resolves without guessing a replacement contract", () => {
  const { dependencies, request } = fixture();
  assert.throws(() => runLinkedTask({ ...request, operation: "claim" }, { ...dependencies, openLeaseStore: () => { throw new Error("store unavailable"); } }), /store unavailable/);
  const id = current().execution!.contractId;
  assert.equal(current().execution!.phase, "claim-pending");
  runLinkedTask({ ...request, operation: "resolve" }, dependencies);
  assert.equal(current().execution!.contractId, id); assert.equal(current().execution!.phase, "released");
});

test("resolve converges an already-confirmed lease after a lost coordination acknowledgement", () => {
  const { dependencies, request } = fixture(); runLinkedTask({ ...request, operation: "claim" }, dependencies);
  const id = current().execution!.contractId;
  withCoordinationLock((state) => { state.tasks[0]!.execution!.phase = "claim-pending"; });
  runLinkedTask({ ...request, operation: "resolve" }, dependencies);
  assert.equal(current().execution!.contractId, id); assert.equal(current().execution!.phase, "active");
});


test("acceptance changed during a passing verification is rejected at completion preflight", () => {
  const { dependencies, request, beads, repo } = fixture([process.execPath, "-e", "require('node:fs').writeFileSync('checked', 'yes')"]);
  runLinkedTask({ ...request, operation: "claim" }, dependencies);
  const originalRead = beads.getIssue.bind(beads);
  beads.getIssue = () => {
    if (existsSync(join(repo.path, "checked"))) beads.issue.acceptanceCriteria = "changed during verification";
    return originalRead();
  };
  assert.throws(() => runLinkedTask({ ...request, operation: "complete", result }, dependencies), /acceptance changed during verification/);
  assert.equal(beads.closeCalls, 0); assert.equal(current().execution!.phase, "completion-pending");
});


test("linking refuses ambiguous local legacy claims even when Beads is still open", () => {
  const { dependencies, beads, repo } = fixture();
  const contract = current().contract!;
  withCoordinationLock((state) => { delete state.tasks[0]!.contract; });
  beads.claim = () => { throw new Error("before remote claim mutation"); };
  assert.throws(() => runLeaseCommand({ name: "claim", beadId: "il-1", actor: pane, sessionPid: process.pid, paths: ["owned.txt"], repositoryPath: repo.path }, dependencies), /ambiguous/);
  assert.equal(beads.issue.status, "open");
  assert.throws(() => readTaskContract(repo.path, { beadId: "il-1", paths: contract.paths, checks: contract.checks }, beads), /existing local contract/);
  runLeaseCommand({ name: "resolve", beadId: "il-1", repositoryPath: repo.path }, dependencies);
  assert.equal(readTaskContract(repo.path, { beadId: "il-1", paths: contract.paths, checks: contract.checks }, beads).contract.beadId, "il-1");
});

test("read-only attachment checks include pending recovery after the local lease is removed", () => {
  const { dependencies, request, beads, repo } = fixture(); runLinkedTask({ ...request, operation: "claim" }, dependencies);
  const contract = current().contract!; beads.failRecover = true;
  assert.throws(() => runLinkedTask({ ...request, operation: "release", reason: "handoff" }, dependencies), /pending/);
  assert.equal(beads.issue.status, "open");
  assert.throws(() => readTaskContract(repo.path, { beadId: "il-1", paths: contract.paths, checks: contract.checks }, beads), /existing local contract/);
});

test("release and recover after completion preserve terminal history and evidence exactly", () => {
  const { dependencies, request } = fixture(); runLinkedTask({ ...request, operation: "claim" }, dependencies);
  runLinkedTask({ ...request, operation: "complete", result }, dependencies);
  const before = readFileSync(coordinationStatePath(), "utf8");
  assert.throws(() => runLinkedTask({ ...request, operation: "release", reason: "late event" }, dependencies), /terminal/);
  assert.throws(() => runLinkedTask({ ...request, operation: "recover" }, dependencies), /terminal/);
  assert.equal(readFileSync(coordinationStatePath(), "utf8"), before);
});

test("coordination-only completion preserves submitted declarations without claiming executed verification", () => {
  fixture(); withCoordinationLock((state) => { delete state.tasks[0]!.contract; });
  cli(["claim", "task-1"]);
  assert.throws(() => cli(["complete", "task-1", "--result", JSON.stringify({ summary: "missing artifacts" })]));
  assert.equal(current().stage, "claimed");
  cli(["complete", "task-1", "--result", JSON.stringify(result)]);
  assert.deepEqual(current().result, { ...result, source: "agent-declared" });
  assert.equal(current().execution, undefined);
});


test("owner can release changed acceptance after passing checks but before any SQLite completion event", () => {
  const { dependencies, request, beads, repo } = fixture([process.execPath, "-e", "require('node:fs').writeFileSync('checked', 'yes')"]);
  runLinkedTask({ ...request, operation: "claim" }, dependencies);
  const originalRead = beads.getIssue.bind(beads);
  beads.getIssue = () => { if (existsSync(join(repo.path, "checked"))) beads.issue.acceptanceCriteria = "corrected acceptance"; return originalRead(); };
  assert.throws(() => runLinkedTask({ ...request, operation: "complete", result }, dependencies), /acceptance changed during verification/);
  const released = runLinkedTask({ ...request, operation: "release", reason: "recapture corrected acceptance" }, dependencies);
  assert.equal(released.execution!.phase, "released"); assert.equal(released.stage, "open"); assert.equal(beads.closeCalls, 0);
});


test("release converges a closed acknowledged completion after the final coordination save was lost", () => {
  const { dependencies, request } = fixture(); runLinkedTask({ ...request, operation: "claim" }, dependencies);
  runLinkedTask({ ...request, operation: "complete", result }, dependencies);
  withCoordinationLock((state) => { state.tasks[0]!.stage = "claimed"; state.tasks[0]!.execution!.phase = "completion-pending"; });
  const completed = runLinkedTask({ ...request, operation: "release", reason: "departing after lost response" }, dependencies);
  assert.equal(completed.execution!.phase, "done"); assert.equal(completed.stage, "done");
  assert.equal(completed.execution!.result!.summary, result.summary);
});
