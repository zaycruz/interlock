import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import Database from "better-sqlite3";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { BeadsClient } from "../../src/beads/index.js";
import { runCli } from "../../src/cli/index.js";
import type { InterlockMetadata } from "../../src/contracts/index.js";
import { DEFAULT_STALE_AFTER_MS, existingLeaseDatabasePath, openLeaseStore, type LeaseStore, type ProcessIdentity } from "../../src/core/index.js";
import { createTestRepository, type TestRepository } from "../helpers/git-repository.js";

const repositories: TestRepository[] = [];
const identity = { pid: 4242, startedAt: "test-session-start" };
const command = { pid: 5252, startedAt: "command-start" };
const baseIssue = {
  id: "il-1", title: "Test contract", status: "open", assignee: undefined as string | undefined,
  description: "Value: Keep parallel work safe.\n\nWork: Change one exact file.\n\nOut: Do not add remote services.",
  acceptanceCriteria: "Tests prove the lifecycle.", metadata: {} as Record<string, unknown>, metadataMalformed: false,
};

afterEach(() => { while (repositories.length > 0) repositories.pop()?.remove(); });
function repository(): TestRepository { const value = createTestRepository(); repositories.push(value); return value; }

class FakeBeads implements BeadsClient {
  issue = structuredClone(baseIssue);
  additionalIssues = new Map<string, typeof baseIssue>();
  calls: string[] = [];
  failClaim = false;
  failHeartbeat = false;
  heartbeatNoop = false;
  heartbeatPostReadFailure = false;
  failRecover = false;
  failClose = false;
  failCloseBeforeMutation = false;
  closeNoop = false;
  closePostReadFailure = false;
  failRead = false;
  applyRecoveryThenFail = false;
  recoverNoop = false;

  getIssue(id: string) { this.calls.push("get"); if (this.failRead) throw new Error("Beads read unavailable"); return structuredClone(this.additionalIssues.get(id) ?? this.issue); }
  dependencies() { return []; }
  dependents() { return []; }
  claim(_id: string, actor: string, metadata: InterlockMetadata) {
    this.calls.push("claim");
    if (this.failClaim) throw new Error("connection lost after claim request");
    this.issue.status = "in_progress"; this.issue.assignee = actor; this.issue.metadata = { ...this.issue.metadata, interlock: metadata };
  }
  heartbeat(_id: string, metadata: InterlockMetadata) {
    this.calls.push("heartbeat");
    if (this.failHeartbeat) throw new Error("metadata sync rejected");
    if (!this.heartbeatNoop) this.issue.metadata = { ...this.issue.metadata, interlock: metadata };
    if (this.heartbeatPostReadFailure) this.failRead = true;
  }
  close() {
    this.calls.push("close");
    if (this.failClose && this.failCloseBeforeMutation) throw new Error("connection lost before close request");
    if (!this.closeNoop) this.issue.status = "closed";
    if (this.closePostReadFailure) this.failRead = true;
    if (this.failClose) throw new Error("connection lost after close request");
  }
  recover(_id: string, marker: { eventId: number; contractId: string }) {
    this.calls.push("recover");
    if (this.failRecover) throw new Error("recovery update rejected");
    if (this.recoverNoop) return;
    this.issue.status = "open"; this.issue.assignee = undefined;
    const { interlock: _interlock, ...rest } = this.issue.metadata;
    this.issue.metadata = { ...rest, "interlock.recovery": marker };
    if (this.applyRecoveryThenFail) throw new Error("connection lost after recovery update");
  }
}

function dependencies(beads: FakeBeads = new FakeBeads()) {
  return {
    beads,
    processIdentityFor: (pid: number) => { assert.equal(pid, identity.pid); return identity; },
    lifecycleProcessor: () => command,
  };
}
function claim(path: string, beads: FakeBeads, extra: object = {}): ReturnType<typeof runCli> {
  return runCli(["claim", "il-1", "--actor", "agent-a", "--session-pid", String(identity.pid), "--path", "src/owned.ts", "--repo", path], { ...dependencies(beads), ...extra });
}
function metadata(beads: FakeBeads): InterlockMetadata { return beads.issue.metadata.interlock as InterlockMetadata; }
function owner() { return { actor: "agent-a", beadId: "il-1", process: identity }; }
function activeIssueFor(beads: FakeBeads, contractId: string, heartbeatAt = 100): void {
  beads.issue.status = "in_progress"; beads.issue.assignee = "agent-a";
  beads.issue.metadata = { interlock: { contractId, actor: "agent-a", session: identity, paths: ["src/owned.ts"], leaseHealth: { status: "fresh", heartbeatAt } } };
}
function completingContract(path: string, beads: FakeBeads): { store: LeaseStore; contractId: string } {
  const store = openLeaseStore(path, { processInspector: () => "alive" });
  store.acquire({ workContractId: "completion-contract", owner: owner(), paths: ["src/owned.ts"] });
  store.markRemoteAttempted({ workContractId: "completion-contract", owner: owner() });
  store.confirmRemote({ workContractId: "completion-contract", owner: owner() });
  const event = store.beginCompletion({ workContractId: "completion-contract", owner: owner() });
  activeIssueFor(beads, "completion-contract", event.heartbeatAt); beads.issue.status = "closed";
  return { store, contractId: "completion-contract" };
}
function recoveryEvent(path: string, beads: FakeBeads): { store: LeaseStore; eventId: number; contractId: string; heartbeatAt: number } {
  const store = openLeaseStore(path, { processInspector: () => "alive" });
  store.acquire({ workContractId: "recovery-contract", owner: owner(), paths: ["src/owned.ts"] });
  store.markRemoteAttempted({ workContractId: "recovery-contract", owner: owner() });
  store.confirmRemote({ workContractId: "recovery-contract", owner: owner() });
  const event = store.releaseForRecovery({ workContractId: "recovery-contract", owner: owner(), reason: "handoff" });
  activeIssueFor(beads, event.workContractId, event.heartbeatAt);
  return { store, eventId: event.id, contractId: event.workContractId, heartbeatAt: event.heartbeatAt };
}

test("status is read-only when no local database exists", () => {
  const repo = repository(); const beads = new FakeBeads();
  assert.equal(existsSync(existingLeaseDatabasePath(repo.path)), false);
  assert.equal(runCli(["status", "il-1", "--repo", repo.path], dependencies(beads)).exitCode, 0);
  assert.equal(existsSync(existingLeaseDatabasePath(repo.path)), false);
});

test("claim creates an attempted local contract then confirms the exact active Beads contract", () => {
  const repo = repository(); const beads = new FakeBeads();
  assert.equal(claim(repo.path, beads).exitCode, 0);
  const local = openLeaseStore(repo.path).getWorkContract(metadata(beads).contractId);
  assert.equal(local?.remoteAttempted, true); assert.equal(local?.remoteConfirmed, true);
  assert.equal(beads.issue.status, "in_progress"); assert.equal(beads.issue.assignee, "agent-a");
});

test("claim rejects a --session-pid outside the caller's own ancestry", () => {
  const repo = repository(); const beads = new FakeBeads();
  const result = runCli(["claim", "il-1", "--actor", "agent-a", "--session-pid", "1", "--path", "src/owned.ts", "--repo", repo.path],
    { beads, lifecycleProcessor: () => command });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--session-pid 1 is not the calling process or an ancestor of it/);
  assert.deepEqual(beads.calls, ["get"]);
  const store = openLeaseStore(repo.path); assert.equal(store.getWorkContractByBeadId("il-1"), undefined); store.close();
});

test("claim accepts the caller's own pid and an ancestor pid as --session-pid", () => {
  for (const pid of [process.pid, process.ppid]) {
    const repo = repository(); const beads = new FakeBeads();
    const result = runCli(["claim", "il-1", "--actor", "agent-a", "--session-pid", String(pid), "--path", "src/owned.ts", "--repo", repo.path],
      { beads, lifecycleProcessor: () => command });
    assert.equal(result.exitCode, 0, `pid ${pid}`);
    assert.equal(metadata(beads).session.pid, pid);
  }
});

test("claim still rejects a missing or invalid --session-pid at parse time", () => {
  const repo = repository(); const beads = new FakeBeads();
  for (const argv of [
    ["claim", "il-1", "--actor", "agent-a", "--path", "src/owned.ts", "--repo", repo.path],
    ["claim", "il-1", "--actor", "agent-a", "--session-pid", "abc", "--path", "src/owned.ts", "--repo", repo.path],
  ]) {
    const result = runCli(argv, { beads, lifecycleProcessor: () => command });
    assert.equal(result.exitCode, 1); assert.match(result.stderr, /--session-pid must be a positive integer/);
    assert.deepEqual(beads.calls, []);
  }
});

test("claim rejects observed active, assigned, raw-interlock, and invalid-contract issues before local lease acquisition", () => {
  for (const setup of [
    (beads: FakeBeads) => { activeIssueFor(beads, "existing-contract"); },
    (beads: FakeBeads) => { beads.issue.assignee = "other"; },
    (beads: FakeBeads) => { beads.issue.metadata = { interlock: "malformed" }; },
    (beads: FakeBeads) => { beads.issue.description = "Work: missing value"; },
  ]) {
    const repo = repository(); const beads = new FakeBeads(); setup(beads);
    const result = claim(repo.path, beads);
    assert.equal(result.exitCode, 1); assert.equal(beads.calls.includes("claim"), false); assert.deepEqual(beads.calls, ["get"]);
    const store = openLeaseStore(repo.path); assert.equal(store.getWorkContractByBeadId("il-1"), undefined); store.close();
  }
});

test("malformed top-level Beads metadata blocks lifecycle mutations and status labels it malformed", () => {
  const rejectRepo = repository(); const rejectBeads = new FakeBeads();
  rejectBeads.issue.metadataMalformed = true;
  (rejectBeads.issue as { metadata: Record<string, unknown> | undefined }).metadata = undefined;
  const rejected = claim(rejectRepo.path, rejectBeads);
  assert.equal(rejected.exitCode, 1); assert.deepEqual(rejectBeads.calls, ["get"]);
  const rejectedStore = openLeaseStore(rejectRepo.path); assert.equal(rejectedStore.getWorkContractByBeadId("il-1"), undefined); rejectedStore.close();
  const rejectedStatus = runCli(["status", "il-1", "--repo", rejectRepo.path], dependencies(rejectBeads));
  assert.equal(rejectedStatus.exitCode, 0); assert.match(rejectedStatus.stdout, /drift \(Beads metadata is malformed\)/);

  const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
  const contractId = metadata(beads).contractId;
  beads.issue.metadataMalformed = true;
  (beads.issue as { metadata: Record<string, unknown> | undefined }).metadata = undefined;
  const before = openLeaseStore(repo.path).getWorkContract(contractId);
  for (const commandName of ["heartbeat", "complete", "release"] as const) {
    beads.calls = [];
    const args = commandName === "release" ? [commandName, "il-1", "--reason", "handoff", "--repo", repo.path] : [commandName, "il-1", "--repo", repo.path];
    assert.equal(runCli(args, dependencies(beads)).exitCode, 1);
    const after = openLeaseStore(repo.path).getWorkContract(contractId);
    assert.deepEqual(after, before);
    assert.equal(beads.calls.includes(commandName === "heartbeat" ? "heartbeat" : commandName === "complete" ? "close" : "recover"), false);
  }
});

test("status renders a matching heartbeat-expired lease as expired", () => {
  const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
  const staleHeartbeatAt = Date.now() - DEFAULT_STALE_AFTER_MS - 1;
  const contractId = metadata(beads).contractId;
  const database = new Database(existingLeaseDatabasePath(repo.path));
  database.prepare("UPDATE work_contracts SET acquired_at = ?, heartbeat_at = ? WHERE work_contract_id = ?").run(staleHeartbeatAt, staleHeartbeatAt, contractId);
  database.close();
  beads.issue.metadata.interlock = { ...metadata(beads), leaseHealth: { status: "fresh", heartbeatAt: staleHeartbeatAt } };
  const result = runCli(["status", "il-1", "--repo", repo.path], dependencies(beads));
  assert.equal(result.exitCode, 0); assert.match(result.stdout, new RegExp(`Lease health: expired \\(heartbeat ${new Date(staleHeartbeatAt).toISOString()}\\)`));
});

test("plain status reads leases through the read-only reader and the injected clock", () => {
  const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
  const heartbeatAt = metadata(beads).leaseHealth.heartbeatAt;
  const result = runCli(["status", "il-1", "--repo", repo.path], {
    ...dependencies(beads),
    clock: () => heartbeatAt + DEFAULT_STALE_AFTER_MS + 1,
    openLeaseStore: () => { throw new Error("plain status must not open the read-write store"); },
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, new RegExp(`Lease health: expired \\(heartbeat ${new Date(heartbeatAt).toISOString()}\\)`));
});

test("an ambiguous Beads claim retains the attempted unconfirmed paths and reconcile never reads Beads for it", () => {
  const repo = repository(); const beads = new FakeBeads(); beads.failClaim = true;
  const result = claim(repo.path, beads);
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /outcome is ambiguous/);
  const store = openLeaseStore(repo.path);
  assert.throws(() => store.acquire({ workContractId: "replacement", owner: { actor: "other", beadId: "il-other", process: { pid: 99, startedAt: "other" } }, paths: ["src/owned.ts"] }));
  store.close();
  beads.calls = [];
  const reconcile = runCli(["reconcile", "--repo", repo.path], dependencies(beads));
  assert.equal(reconcile.exitCode, 0); assert.deepEqual(beads.calls, []);
});

function ambiguousClaim(path: string, beads: FakeBeads): void {
  beads.failClaim = true;
  const result = claim(path, beads);
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /outcome is ambiguous/);
  beads.failClaim = false; beads.calls = [];
}

test("resolve clears the attempted contract when Beads shows the claim did not land", () => {
  const repo = repository(); const beads = new FakeBeads(); ambiguousClaim(repo.path, beads);
  const result = runCli(["resolve", "il-1", "--repo", repo.path], dependencies(beads));
  assert.equal(result.exitCode, 0); assert.match(result.stdout, /did not land/);
  const store = openLeaseStore(repo.path); assert.equal(store.getWorkContractByBeadId("il-1"), undefined); store.close();
  assert.equal(claim(repo.path, beads).exitCode, 0);
});

test("resolve confirms the attempted contract when Beads shows the claim landed", () => {
  const repo = repository(); const beads = new FakeBeads(); ambiguousClaim(repo.path, beads);
  const store = openLeaseStore(repo.path); const lease = store.getWorkContractByBeadId("il-1"); store.close();
  assert.ok(lease !== undefined);
  activeIssueFor(beads, lease.workContractId, lease.heartbeatAt);
  const result = runCli(["resolve", "il-1", "--repo", repo.path], dependencies(beads));
  assert.equal(result.exitCode, 0); assert.match(result.stdout, /landed/);
  const confirmed = openLeaseStore(repo.path); assert.equal(confirmed.getWorkContract(lease.workContractId)?.remoteConfirmed, true); confirmed.close();
  assert.equal(runCli(["heartbeat", "il-1", "--repo", repo.path], dependencies(beads)).exitCode, 0);
});

test("resolve refuses with the manual step when Beads state is unverifiable", () => {
  const repo = repository(); const beads = new FakeBeads(); ambiguousClaim(repo.path, beads);
  beads.failRead = true;
  const result = runCli(["resolve", "il-1", "--repo", repo.path], dependencies(beads));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /bd show il-1/); assert.match(result.stderr, /remains reserved/);
  const store = openLeaseStore(repo.path);
  const lease = store.getWorkContractByBeadId("il-1");
  assert.equal(lease?.remoteAttempted, true); assert.equal(lease?.remoteConfirmed, false);
  store.close();
});

test("resolve refuses an unexpected remote state and a confirmed contract", () => {
  const repo = repository(); const beads = new FakeBeads(); ambiguousClaim(repo.path, beads);
  beads.issue.assignee = "other-agent"; beads.issue.status = "in_progress";
  const unexpected = runCli(["resolve", "il-1", "--repo", repo.path], dependencies(beads));
  assert.equal(unexpected.exitCode, 1); assert.match(unexpected.stderr, /Manual step: run `bd show il-1`/);
  const store = openLeaseStore(repo.path); assert.ok(store.getWorkContractByBeadId("il-1") !== undefined); store.close();
  const healthy = repository(); const healthyBeads = new FakeBeads();
  assert.equal(claim(healthy.path, healthyBeads).exitCode, 0);
  const confirmed = runCli(["resolve", "il-1", "--repo", healthy.path], dependencies(healthyBeads));
  assert.equal(confirmed.exitCode, 1); assert.match(confirmed.stderr, /already remotely confirmed/);
});

test("the lifecycle lock blocks a mutating command before any Beads read when owner inspection is unknown", () => {
  const repo = repository();
  const holder = openLeaseStore(repo.path, { processInspector: () => "alive" }); holder.acquireLifecycleLock({ pid: 88, startedAt: "holder" }); holder.close();
  const beads = new FakeBeads();
  const result = claim(repo.path, beads, {
    openLeaseStore: (path: string) => openLeaseStore(path, { processInspector: () => "unknown" }),
  });
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /database lock/); assert.deepEqual(beads.calls, []);
});

test("heartbeat rejects a Beads mismatch before local mutation and retains a renewed local lease on sync failure", () => {
  const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
  const contractId = metadata(beads).contractId; const before = openLeaseStore(repo.path).getWorkContract(contractId)?.heartbeatAt;
  beads.issue.assignee = "other"; beads.calls = [];
  assert.equal(runCli(["heartbeat", "il-1", "--repo", repo.path], dependencies(beads)).exitCode, 1);
  assert.equal(openLeaseStore(repo.path).getWorkContract(contractId)?.heartbeatAt, before);
  beads.issue.assignee = "agent-a"; beads.failHeartbeat = true;
  assert.match(runCli(["heartbeat", "il-1", "--repo", repo.path], dependencies(beads)).stderr, /Local heartbeat succeeded/);
});

test("heartbeat retains its renewed local lease when Beads writes a no-op or post-write verification cannot read", () => {
  for (const mode of ["noop", "read-failure"] as const) {
    const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
    const contractId = metadata(beads).contractId;
    if (mode === "noop") beads.heartbeatNoop = true;
    else beads.heartbeatPostReadFailure = true;
    const result = runCli(["heartbeat", "il-1", "--repo", repo.path], dependencies(beads));
    assert.equal(result.exitCode, 1); assert.match(result.stderr, /exact Beads verification failed/);
    const lease = openLeaseStore(repo.path).getWorkContract(contractId);
    assert.equal(lease?.remoteConfirmed, true);
  }
});

test("complete writes durable intent before close and a later exact-closed reconcile releases after local acknowledgement failure", () => {
  const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
  let failAcknowledge = true;
  const result = runCli(["complete", "il-1", "--repo", repo.path], {
    ...dependencies(beads),
    openLeaseStore: (path) => {
      const target = openLeaseStore(path);
      return new Proxy(target, { get(value, property) {
        if (property === "acknowledgeCompletion" && failAcknowledge) return () => { failAcknowledge = false; throw new Error("simulated local crash"); };
        const member = Reflect.get(value, property);
        return typeof member === "function" ? member.bind(value) : member;
      } }) as LeaseStore;
    },
  });
  assert.equal(result.exitCode, 1); assert.equal(beads.issue.status, "closed");
  const pending = openLeaseStore(repo.path); assert.equal(pending.completionEvents().length, 1); pending.close();
  assert.equal(runCli(["reconcile", "--repo", repo.path], dependencies(beads)).exitCode, 0);
  const verified = openLeaseStore(repo.path); assert.deepEqual(verified.completionEvents(), []); assert.equal(verified.getWorkContract(metadata(beads).contractId), undefined); verified.close();
});

test("completion recovery retains a mismatched active remote contract", () => {
  const repo = repository(); const beads = new FakeBeads(); const { store } = completingContract(repo.path, beads); store.close();
  beads.issue.status = "in_progress"; beads.issue.metadata.interlock = { ...metadata(beads), actor: "other" }; beads.calls = [];
  const result = runCli(["reconcile", "--repo", repo.path], dependencies(beads));
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /active or closed completion contract/);
  const pending = openLeaseStore(repo.path); assert.equal(pending.completionEvents().length, 1); pending.close();
});

test("completion recovery retains a closed contract with altered heartbeat metadata", () => {
  const repo = repository(); const beads = new FakeBeads(); const { store } = completingContract(repo.path, beads); store.close();
  const remote = metadata(beads); beads.issue.metadata.interlock = { ...remote, leaseHealth: { ...remote.leaseHealth, heartbeatAt: remote.leaseHealth.heartbeatAt + 1 } };
  const result = runCli(["reconcile", "--repo", repo.path], dependencies(beads));
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /active or closed completion contract/);
  const pending = openLeaseStore(repo.path); assert.equal(pending.completionEvents().length, 1); pending.close();
});

test("completion recovery retains an unreadable remote contract", () => {
  const repo = repository(); const beads = new FakeBeads(); const { store } = completingContract(repo.path, beads); store.close();
  beads.failRead = true;
  assert.equal(runCli(["reconcile", "--repo", repo.path], dependencies(beads)).exitCode, 1);
  const pending = openLeaseStore(repo.path); assert.equal(pending.completionEvents().length, 1); pending.close();
});

test("completion command leaves intent after an ambiguous close result", () => {
  const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
  beads.failClose = true;
  const result = runCli(["complete", "il-1", "--repo", repo.path], dependencies(beads));
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /Completion .* pending/);
  const pending = openLeaseStore(repo.path); assert.equal(pending.completionEvents().length, 1); pending.close();
});

test("pending completion event blocks subsequent claim and reconcile retries an exact active close", () => {
  const repo = repository(); const beads = new FakeBeads();
  beads.additionalIssues.set("il-2", { ...structuredClone(baseIssue), id: "il-2" });
  assert.equal(claim(repo.path, beads).exitCode, 0);
  beads.failClose = true;
  beads.failCloseBeforeMutation = true;
  const completion = runCli(["complete", "il-1", "--repo", repo.path], dependencies(beads));
  assert.equal(completion.exitCode, 1);
  assert.match(completion.stderr, /retry Beads close/);

  const blocked = runCli(["claim", "il-2", "--actor", "agent-b", "--session-pid", String(identity.pid), "--path", "src/other.ts", "--repo", repo.path], dependencies(beads));
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.stderr, /Lifecycle recovery remains pending/);
  assert.equal(beads.issue.status, "in_progress");

  beads.failClose = false; beads.calls = [];
  const reconciled = runCli(["reconcile", "--repo", repo.path], dependencies(beads));
  assert.equal(reconciled.exitCode, 0, reconciled.stderr);
  assert.equal(beads.calls.includes("close"), true);
  assert.equal(beads.issue.status, "closed");
  const store = openLeaseStore(repo.path);
  assert.deepEqual(store.completionEvents(), []);
  store.close();
});

test("complete retains its durable event when Beads close is a no-op or post-close verification cannot read", () => {
  for (const mode of ["noop", "read-failure"] as const) {
    const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
    if (mode === "noop") beads.closeNoop = true;
    else beads.closePostReadFailure = true;
    const result = runCli(["complete", "il-1", "--repo", repo.path], dependencies(beads));
    assert.equal(result.exitCode, 1); assert.match(result.stderr, /exact closed-contract verification failed/);
    const pending = openLeaseStore(repo.path); assert.equal(pending.completionEvents().length, 1); pending.close();
  }
});

test("recovery acknowledges only the exact marker with no raw interlock key", () => {
  const repo = repository(); const beads = new FakeBeads(); const { store, eventId, contractId } = recoveryEvent(repo.path, beads); store.close();
  beads.issue.status = "open"; beads.issue.assignee = undefined;
  beads.issue.metadata = { interlock: "{malformed", "interlock.recovery": { eventId, contractId } }; beads.calls = [];
  const malformed = runCli(["reconcile", "--repo", repo.path], dependencies(beads));
  assert.equal(malformed.exitCode, 1); assert.equal(beads.calls.includes("recover"), false);
  const pending = openLeaseStore(repo.path); assert.equal(pending.recoveryEvents().length, 1); pending.close();
  beads.issue.metadata = { "interlock.recovery": { eventId: eventId + 1, contractId } }; beads.calls = [];
  assert.equal(runCli(["reconcile", "--repo", repo.path], dependencies(beads)).exitCode, 1);
  beads.issue.metadata = { "interlock.recovery": { eventId, contractId } }; beads.calls = [];
  assert.equal(runCli(["reconcile", "--repo", repo.path], dependencies(beads)).exitCode, 0);
  assert.equal(beads.calls.includes("recover"), false);
});

test("recovery retains its event and does not mutate Beads when active metadata has an altered heartbeat", () => {
  const repo = repository(); const beads = new FakeBeads(); const { store } = recoveryEvent(repo.path, beads); store.close();
  const remote = metadata(beads); beads.issue.metadata.interlock = { ...remote, leaseHealth: { ...remote.leaseHealth, heartbeatAt: remote.leaseHealth.heartbeatAt + 1 } }; beads.calls = [];
  const result = runCli(["reconcile", "--repo", repo.path], dependencies(beads));
  assert.equal(result.exitCode, 1); assert.equal(beads.calls.includes("recover"), false);
  const pending = openLeaseStore(repo.path); assert.equal(pending.recoveryEvents().length, 1); pending.close();
});

test("recovery retains its event when a successful recover call is a no-op", () => {
  const repo = repository(); const beads = new FakeBeads(); const { store } = recoveryEvent(repo.path, beads); store.close();
  beads.recoverNoop = true;
  const result = runCli(["reconcile", "--repo", repo.path], dependencies(beads));
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /did not produce the exact acknowledged state/);
  const pending = openLeaseStore(repo.path); assert.equal(pending.recoveryEvents().length, 1); pending.close();
  assert.equal(beads.calls.includes("recover"), true);
  beads.recoverNoop = false;
  assert.equal(runCli(["reconcile", "--repo", repo.path], dependencies(beads)).exitCode, 0);
  const acknowledged = openLeaseStore(repo.path); assert.deepEqual(acknowledged.recoveryEvents(), []); acknowledged.close();
});

test("recovery retries an ambiguous remote update by reading its durable marker", () => {
  const repo = repository(); const beads = new FakeBeads(); const { store } = recoveryEvent(repo.path, beads); store.close();
  beads.applyRecoveryThenFail = true;
  assert.equal(runCli(["reconcile", "--repo", repo.path], dependencies(beads)).exitCode, 1);
  beads.applyRecoveryThenFail = false; beads.calls = [];
  assert.equal(runCli(["reconcile", "--repo", repo.path], dependencies(beads)).exitCode, 0);
  assert.equal(beads.calls.includes("recover"), false);
});

test("recovery retains newer manual contracts and preserves unrelated metadata on success", () => {
  const repo = repository(); const beads = new FakeBeads(); const { store, contractId, heartbeatAt } = recoveryEvent(repo.path, beads); store.close();
  activeIssueFor(beads, "newer-contract"); beads.calls = [];
  const mismatch = runCli(["reconcile", "--repo", repo.path], dependencies(beads));
  assert.equal(mismatch.exitCode, 1); assert.equal(beads.calls.includes("recover"), false);
  activeIssueFor(beads, contractId, heartbeatAt); beads.issue.metadata.custom = "preserve";
  assert.equal(runCli(["reconcile", "--repo", repo.path], dependencies(beads)).exitCode, 0);
  assert.equal(beads.issue.metadata.custom, "preserve"); assert.equal(beads.issue.status, "open");
});

test("release writes recovery intent before it clears the confirmed local lease", () => {
  const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
  const contractId = metadata(beads).contractId;
  const result = runCli(["release", "il-1", "--reason", "handoff", "--repo", repo.path], dependencies(beads));
  assert.equal(result.exitCode, 0); assert.equal(beads.issue.status, "open"); assert.equal(beads.issue.assignee, undefined);
  const store = openLeaseStore(repo.path); assert.deepEqual(store.recoveryEvents(), []); assert.equal(store.getWorkContract(contractId), undefined); store.close();
});

test("lifecycle preflight rejects local and Beads path drift without local mutation", () => {
  const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
  const contractId = metadata(beads).contractId;
  beads.issue.metadata.interlock = { ...metadata(beads), paths: ["src/drift.ts"] };
  const beforeStore = openLeaseStore(repo.path); const before = beforeStore.getWorkContract(contractId); beforeStore.close();
  for (const commandName of ["heartbeat", "complete", "release"] as const) {
    beads.calls = [];
    const args = commandName === "release"
      ? [commandName, "il-1", "--reason", "handoff", "--repo", repo.path]
      : [commandName, "il-1", "--repo", repo.path];
    const result = runCli(args, dependencies(beads));
    assert.equal(result.exitCode, 1); assert.match(result.stderr, /local\/Beads drift/);
    const afterStore = openLeaseStore(repo.path); const after = afterStore.getWorkContract(contractId); afterStore.close();
    assert.deepEqual(after, before);
    assert.equal(beads.calls.includes(commandName === "heartbeat" ? "heartbeat" : commandName === "complete" ? "close" : "recover"), false);
  }
});

test("lifecycle preflight rejects heartbeat metadata drift without local or Beads mutation", () => {
  const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
  const contractId = metadata(beads).contractId; const remote = metadata(beads);
  beads.issue.metadata.interlock = { ...remote, leaseHealth: { ...remote.leaseHealth, heartbeatAt: remote.leaseHealth.heartbeatAt + 1 } };
  const beforeStore = openLeaseStore(repo.path); const before = beforeStore.getWorkContract(contractId); beforeStore.close();
  const beforeIssue = structuredClone(beads.issue);
  for (const commandName of ["heartbeat", "complete", "release"] as const) {
    beads.calls = [];
    const args = commandName === "release" ? [commandName, "il-1", "--reason", "handoff", "--repo", repo.path] : [commandName, "il-1", "--repo", repo.path];
    const result = runCli(args, dependencies(beads));
    assert.equal(result.exitCode, 1); assert.match(result.stderr, /local\/Beads drift/);
    const afterStore = openLeaseStore(repo.path); assert.deepEqual(afterStore.getWorkContract(contractId), before); afterStore.close();
    assert.deepEqual(beads.issue, beforeIssue);
    assert.equal(beads.calls.includes(commandName === "heartbeat" ? "heartbeat" : commandName === "complete" ? "close" : "recover"), false);
  }
  const status = runCli(["status", "il-1", "--repo", repo.path], dependencies(beads));
  assert.equal(status.exitCode, 0); assert.match(status.stdout, /drift \(local\/Beads heartbeat metadata mismatch\)/);
});

test("status reports local-only, remote-only, and path-scope drift", () => {
  const localRepo = repository(); const localBeads = new FakeBeads(); assert.equal(claim(localRepo.path, localBeads).exitCode, 0);
  delete localBeads.issue.metadata.interlock;
  const local = runCli(["status", "il-1", "--repo", localRepo.path], dependencies(localBeads));
  assert.equal(local.exitCode, 0); assert.match(local.stdout, /drift \(local-only contract; Beads metadata is absent\)/);

  const remoteRepo = repository(); const remoteBeads = new FakeBeads(); activeIssueFor(remoteBeads, "remote-contract");
  const remote = runCli(["status", "il-1", "--repo", remoteRepo.path], dependencies(remoteBeads));
  assert.equal(remote.exitCode, 0); assert.match(remote.stdout, /drift \(remote-only active contract\)/);

  const scopeRepo = repository(); const scopeBeads = new FakeBeads(); assert.equal(claim(scopeRepo.path, scopeBeads).exitCode, 0);
  scopeBeads.issue.metadata.interlock = { ...metadata(scopeBeads), paths: ["src/drift.ts"] };
  const scope = runCli(["status", "il-1", "--repo", scopeRepo.path], dependencies(scopeBeads));
  assert.equal(scope.exitCode, 0); assert.match(scope.stdout, /drift \(local\/Beads scope or owner mismatch\)/);
});

test("status remains diagnostic for invalid contract text and every remote metadata state", () => {
  const repo = repository(); const beads = new FakeBeads();
  beads.issue.description = "Work: missing required value";
  beads.issue.acceptanceCriteria = "";
  for (const [name, setup, expected] of [
    ["absent", () => { beads.issue.metadata = {}; }, "Beads metadata is absent"],
    ["malformed", () => { beads.issue.metadata = { interlock: "{" }; }, "Beads metadata is malformed"],
    ["inactive", () => { activeIssueFor(beads, "remote-contract"); beads.issue.status = "open"; }, "remote contract is inactive (open)"],
    ["reassigned", () => { activeIssueFor(beads, "remote-contract"); beads.issue.assignee = "other"; }, "remote contract is reassigned (other)"],
  ] as const) {
    setup();
    const result = runCli(["status", "il-1", "--repo", repo.path], dependencies(beads));
    assert.equal(result.exitCode, 0, name); assert.match(result.stdout, /Contract diagnostic:/, name); assert.ok(result.stdout.includes(expected), name);
  }
});

test("heartbeat performs its Beads reads outside the lifecycle lock", () => {
  const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
  const events: string[] = [];
  const tracking = new Proxy(beads, {
    get(target, property, receiver) {
      if (property === "getIssue" || property === "heartbeat") {
        return (...args: unknown[]) => {
          events.push(property === "getIssue" ? "beads:read" : "beads:write");
          return Reflect.apply(Reflect.get(target, property), target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const result = runCli(["heartbeat", "il-1", "--repo", repo.path], {
    ...dependencies(tracking),
    openLeaseStore: (path: string) => {
      const target = openLeaseStore(path);
      return new Proxy(target, {
        get(value, property, receiver) {
          if (property === "acquireLifecycleLock" || property === "releaseLifecycleLock") {
            return (...args: unknown[]) => {
              events.push(property === "acquireLifecycleLock" ? "lock:acquire" : "lock:release");
              return Reflect.apply(Reflect.get(value, property), value, args);
            };
          }
          const member = Reflect.get(value, property, receiver);
          return typeof member === "function" ? member.bind(value) : member;
        },
      }) as LeaseStore;
    },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(events, ["beads:read", "lock:acquire", "beads:write", "lock:release", "beads:read"]);
});

test("a concurrent command can take the lifecycle lock while heartbeat waits on its Beads preflight read", () => {
  const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
  const originalGetIssue = beads.getIssue.bind(beads);
  let intercepted = false;
  let contention: string | undefined;
  beads.getIssue = (id: string) => {
    const issue = originalGetIssue(id);
    if (!intercepted) {
      intercepted = true;
      const contender = openLeaseStore(repo.path, { processInspector: () => "alive" });
      try {
        contender.acquireLifecycleLock({ pid: 99, startedAt: "contender" });
        contention = "acquired";
        contender.releaseLifecycleLock({ pid: 99, startedAt: "contender" });
      } catch { contention = "blocked"; } finally { contender.close(); }
    }
    return issue;
  };
  const result = runCli(["heartbeat", "il-1", "--repo", repo.path], {
    ...dependencies(beads),
    openLeaseStore: (path: string) => openLeaseStore(path, { processInspector: () => "alive" }),
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(contention, "acquired");
});

test("complete retains staged path scope checks", () => {
  const repo = repository(); const beads = new FakeBeads(); assert.equal(claim(repo.path, beads).exitCode, 0);
  writeFileSync(join(repo.path, "outside.ts"), "export {};\n"); execFileSync("git", ["-C", repo.path, "add", "outside.ts"]); beads.calls = [];
  const result = runCli(["complete", "il-1", "--repo", repo.path], dependencies(beads));
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /outside.ts/); assert.equal(beads.calls.includes("close"), false);
});
