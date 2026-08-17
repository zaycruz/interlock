import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterEach, test } from "node:test";

import type { BeadsClient } from "../../src/beads/index.js";
import { runCli } from "../../src/cli/index.js";
import type { BeadsIssue, InterlockMetadata } from "../../src/contracts/index.js";
import { DEFAULT_STALE_AFTER_MS, existingLeaseDatabasePath, openLeaseStore, type LeaseReader, type LeaseState, type LeaseStore } from "../../src/core/index.js";
import { createTestRepository, type TestRepository } from "../helpers/git-repository.js";

const repositories: TestRepository[] = [];
const process = { pid: 4242, startedAt: "snapshot-session" };

afterEach(() => { while (repositories.length > 0) repositories.pop()?.remove(); });

function repository(): TestRepository {
  const value = createTestRepository();
  repositories.push(value);
  return value;
}

function issue(overrides: Partial<BeadsIssue> = {}): BeadsIssue {
  return {
    id: "il-snapshot",
    title: "Snapshot issue",
    description: "Value: Keep work visible.\n\nWork: Read one issue.",
    acceptanceCriteria: "The snapshot is stable.",
    status: "open",
    assignee: undefined,
    metadata: {},
    metadataMalformed: false,
    ...overrides,
  };
}

function metadata(contractId = "contract-snapshot", heartbeatAt = 100): InterlockMetadata {
  return {
    contractId,
    actor: "agent-a",
    session: process,
    paths: ["src/owned.ts"],
    leaseHealth: { status: "fresh", heartbeatAt },
  };
}

function lease(overrides: Partial<LeaseState> = {}): LeaseState {
  return {
    workContractId: "contract-snapshot",
    owner: { actor: "agent-a", beadId: "il-snapshot", process },
    paths: ["src/owned.ts"],
    acquiredAt: 100,
    heartbeatAt: 100,
    remoteAttempted: true,
    remoteConfirmed: true,
    completing: false,
    ...overrides,
  };
}

class FakeBeads implements BeadsClient {
  constructor(readonly value: BeadsIssue) {}
  getIssue(): BeadsIssue { return structuredClone(this.value); }
  dependencies(): never[] { throw new Error("snapshot must not read relationships"); }
  dependents(): never[] { throw new Error("snapshot must not read relationships"); }
  claim(): void { throw new Error("snapshot must not mutate Beads"); }
  heartbeat(): void { throw new Error("snapshot must not mutate Beads"); }
  close(): void { throw new Error("snapshot must not mutate Beads"); }
  recover(): void { throw new Error("snapshot must not mutate Beads"); }
}

class BoardBeads implements BeadsClient {
  readonly reads: string[] = [];

  constructor(private readonly issues: Map<string, BeadsIssue>) {}

  getIssue(id: string): BeadsIssue {
    this.reads.push(id);
    const value = this.issues.get(id);
    if (value === undefined) throw new Error(`missing issue ${id}`);
    return structuredClone(value);
  }

  dependencies(): never[] { throw new Error("board must not read relationships"); }
  dependents(): never[] { throw new Error("board must not read relationships"); }
  claim(): void { throw new Error("board must not mutate Beads"); }
  heartbeat(): void { throw new Error("board must not mutate Beads"); }
  close(): void { throw new Error("board must not mutate Beads"); }
  recover(): void { throw new Error("board must not mutate Beads"); }
}

function reader(value: LeaseState | undefined): LeaseReader {
  return {
    databasePath: "read-only-test",
    listWorkContracts: () => value === undefined ? [] : [value],
    getWorkContractByBeadId: () => value,
    close: () => undefined,
  };
}

function snapshot(
  repo: TestRepository,
  value: BeadsIssue,
  local: LeaseState | undefined,
  clock = () => 100,
  openLeaseReader: (path: string) => LeaseReader = () => reader(local),
): Record<string, unknown> {
  if (local !== undefined) openLeaseStore(repo.path).close();
  const result = runCli(["status", "il-snapshot", "--json", "--repo", repo.path], {
    beads: new FakeBeads(value),
    openLeaseReader,
    clock,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function activeIssue(contract = metadata()): BeadsIssue {
  return issue({ status: "in_progress", assignee: "agent-a", metadata: { interlock: contract } });
}

function confirmedContract(store: LeaseStore, workContractId: string, beadId: string, actor: string, pid: number): void {
  const owner = { actor, beadId, process: { pid, startedAt: `${actor}-start` } };
  store.acquire({ workContractId, owner, paths: [`src/${actor}.ts`] });
  store.markRemoteAttempted({ workContractId, owner });
  store.confirmRemote({ workContractId, owner });
}

test("JSON status returns the exact bounded fields and distinguishes claimed from unclaimed work", () => {
  const repo = repository();
  const unclaimed = snapshot(repo, issue(), undefined);
  assert.deepEqual(Object.keys(unclaimed), [
    "id", "title", "claimed", "owner", "agent", "workspace", "stage", "blocker", "lastProgressAt", "stale", "terminal", "source", "revision",
  ]);
  assert.equal(unclaimed.claimed, false);
  assert.equal(unclaimed.owner, null);
  assert.equal(unclaimed.agent, null);
  assert.equal(unclaimed.blocker, null);
  assert.equal(unclaimed.workspace, repo.path);
  assert.equal(unclaimed.source, "beads");
  assert.equal(unclaimed.revision, null);

  const assigned = snapshot(repo, issue({ assignee: "manual-agent" }), undefined);
  assert.equal(assigned.claimed, true);
  assert.equal(assigned.owner, "manual-agent");
  assert.equal(assigned.agent, null);
});

test("closed Beads work is terminal and not claimed", () => {
  const result = snapshot(repository(), activeIssue(), undefined);
  assert.equal(result.claimed, true);

  const closed = snapshot(repository(), issue({ status: "closed", assignee: "agent-a", metadata: { interlock: metadata() } }), undefined);
  assert.equal(closed.claimed, false);
  assert.equal(closed.terminal, true);
  assert.equal(closed.stage, "closed");
  assert.equal(closed.owner, "agent-a");
  assert.equal(closed.stale, false);
  assert.equal(closed.blocker, null);
});

test("JSON status exposes local-only, remote-only, and drift diagnostics without changing claim state", () => {
  const localRepo = repository();
  const local = snapshot(localRepo, issue(), lease());
  assert.equal(local.claimed, false);
  assert.equal(local.agent, "agent-a");
  assert.equal(local.blocker, "local-only contract; Beads metadata is absent");

  const remote = snapshot(repository(), activeIssue(), undefined);
  assert.equal(remote.claimed, true);
  assert.equal(remote.blocker, "remote-only active contract");
  assert.equal(remote.agent, "agent-a");

  const drift = snapshot(repository(), activeIssue(), lease({ heartbeatAt: 101 }));
  assert.equal(drift.claimed, true);
  assert.equal(drift.blocker, "local/Beads heartbeat metadata mismatch");
  assert.equal(drift.lastProgressAt, new Date(101).toISOString());
});

test("stale uses the existing strict threshold and injected clock", () => {
  const value = snapshot(repository(), activeIssue(), undefined, () => 100 + DEFAULT_STALE_AFTER_MS);
  assert.equal(value.stale, false);
  const stale = snapshot(repository(), activeIssue(), undefined, () => 100 + DEFAULT_STALE_AFTER_MS + 1);
  assert.equal(stale.stale, true);
  assert.equal(stale.lastProgressAt, new Date(100).toISOString());
});

test("malformed Interlock metadata is reported as a blocker but does not become an agent", () => {
  const value = snapshot(repository(), issue({ status: "in_progress", assignee: "agent-a", metadata: { interlock: "malformed" } }), undefined);
  assert.equal(value.claimed, true);
  assert.equal(value.owner, "agent-a");
  assert.equal(value.agent, null);
  assert.equal(value.blocker, "Beads metadata is malformed");
  assert.equal(value.lastProgressAt, null);
});

test("JSON status does not create a lease database when it is absent", () => {
  const repo = repository();
  const databasePath = existingLeaseDatabasePath(repo.path);
  assert.equal(existsSync(databasePath), false);
  const value = snapshot(repo, issue(), undefined, () => 100, () => { throw new Error("reader must not open an absent database"); });
  assert.equal(value.claimed, false);
  assert.equal(existsSync(databasePath), false);
});

test("all JSON status lists local contracts in deterministic order with the bounded field shape", () => {
  const repo = repository();
  const store = openLeaseStore(repo.path, { clock: () => 100 });
  confirmedContract(store, "contract-z", "bead-z", "agent-z", 810);
  confirmedContract(store, "contract-a", "bead-a", "agent-a", 811);
  store.close();

  const beads = new BoardBeads(new Map([
    ["bead-z", issue({ id: "bead-z", title: "Z issue", status: "in_progress", assignee: "agent-z", metadata: { interlock: metadata("contract-z") } })],
    ["bead-a", issue({ id: "bead-a", title: "A issue", status: "in_progress", assignee: "agent-a", metadata: { interlock: metadata("contract-a") } })],
  ]));
  const result = runCli(["status", "--all", "--json", "--repo", repo.path], { beads, clock: () => 100 });
  assert.equal(result.exitCode, 0, result.stderr);
  const board = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  assert.deepEqual(board.map((item) => item.id), ["bead-a", "bead-z"]);
  assert.deepEqual(Object.keys(board[0] ?? {}), [
    "id", "title", "claimed", "owner", "agent", "workspace", "stage", "blocker", "lastProgressAt", "stale", "terminal", "source", "revision",
  ]);
  assert.deepEqual(beads.reads, ["bead-a", "bead-z"]);
});

test("all JSON status returns an empty array without creating the local database", () => {
  const repo = repository();
  const databasePath = existingLeaseDatabasePath(repo.path);
  const beads = new BoardBeads(new Map());
  const result = runCli(["status", "--all", "--json", "--repo", repo.path], { beads });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
  assert.deepEqual(beads.reads, []);
  assert.equal(existsSync(databasePath), false);
});

test("all status requires JSON and does not accept a Beads issue ID", () => {
  const repo = repository();
  const beads = new BoardBeads(new Map());
  const withoutJson = runCli(["status", "--all", "--repo", repo.path], { beads });
  assert.equal(withoutJson.exitCode, 1);
  const withId = runCli(["status", "bead-a", "--all", "--json", "--repo", repo.path], { beads });
  assert.equal(withId.exitCode, 1);
  assert.deepEqual(beads.reads, []);
});
