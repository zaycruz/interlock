import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import Database from "better-sqlite3";
import { afterEach, test } from "node:test";

import {
  LegacyLeaseDatabaseError,
  LeaseCollisionError,
  LeaseOwnershipError,
  LeasePathError,
  LifecycleLockError,
  leaseDatabasePath,
  openLeaseStore,
  type LeaseStore,
  type ProcessInspector,
} from "../../src/core/index.js";
import { createLinkedWorktree, createTestRepository, type TestRepository } from "../helpers/git-repository.js";

const repositories: TestRepository[] = [];
const owner = { actor: "pi-lease-core", beadId: "il-4xl.1", process: { pid: 101, startedAt: "process-101" } };
const otherOwner = { actor: "pi-other", beadId: "il-4xl.2", process: { pid: 202, startedAt: "process-202" } };
const commandA = { pid: 301, startedAt: "command-a" };
const commandB = { pid: 302, startedAt: "command-b" };

afterEach(() => { while (repositories.length > 0) repositories.pop()?.remove(); });
function repository(): TestRepository { const value = createTestRepository(); repositories.push(value); return value; }
function store(path: string, now = () => 100, inspect: ProcessInspector = () => "alive"): LeaseStore {
  return openLeaseStore(path, { clock: now, staleAfterMs: 50, processInspector: inspect });
}
function confirmed(leases: LeaseStore, workContractId = "contract-1", leaseOwner = owner, paths = ["src/owned.ts"]): void {
  leases.acquire({ workContractId, owner: leaseOwner, paths });
  leases.markRemoteAttempted({ workContractId, owner: leaseOwner });
  leases.confirmRemote({ workContractId, owner: leaseOwner });
}

test("acquires exact normalized paths in the shared Git common directory and reports collision owner details", () => {
  const repo = repository(); const leases = store(repo.path);
  const lease = leases.acquire({ workContractId: "contract-1", owner, paths: ["src//owned.ts"] });
  assert.deepEqual(lease.paths, ["src/owned.ts"]);
  assert.equal(lease.remoteAttempted, false);
  const linked = createLinkedWorktree(repo); repositories.push(linked);
  const linkedLeases = store(linked.path);
  assert.equal(linkedLeases.databasePath, leases.databasePath);
  assert.throws(() => linkedLeases.acquire({ workContractId: "contract-2", owner: otherOwner, paths: ["SRC/OWNED.TS"] }), (error: unknown) => {
    assert.ok(error instanceof LeaseCollisionError);
    assert.deepEqual(error.collisions, [{ path: "src/owned.ts", workContractId: "contract-1", actor: owner.actor, beadId: owner.beadId }]);
    return true;
  });
  linkedLeases.close(); leases.close();
});

test("rejects Windows, absolute, traversal, trailing, glob, duplicate, NFC, and Greek-sigma aliases", () => {
  const repo = repository(); const leases = store(repo.path);
  for (const paths of [
    ["C:\\repo\\file.ts"], ["\\\\server\\share\\file.ts"], ["/tmp/file.ts"], ["src/../file.ts"], ["src/"], ["src\\"],
    ["src/*.ts"], ["src//a.ts", "src/a.ts"], ["src/café.ts", "src/cafe\u0301.ts"], ["src/σ.ts", "src/ς.ts"],
  ]) assert.throws(() => leases.acquire({ workContractId: crypto.randomUUID(), owner, paths }), LeasePathError);
  leases.close();
});

test("requires an attempted remote claim before confirmation and confirmation before heartbeat", () => {
  const repo = repository(); const leases = store(repo.path);
  leases.acquire({ workContractId: "contract-1", owner, paths: ["src/owned.ts"] });
  assert.throws(() => leases.confirmRemote({ workContractId: "contract-1", owner }), /no recorded remote claim attempt/);
  leases.markRemoteAttempted({ workContractId: "contract-1", owner });
  assert.throws(() => leases.heartbeat({ workContractId: "contract-1", owner }), /not remotely confirmed/);
  assert.equal(leases.confirmRemote({ workContractId: "contract-1", owner }).remoteConfirmed, true);
  assert.equal(leases.heartbeat({ workContractId: "contract-1", owner }).remoteConfirmed, true);
  leases.close();
});

test("enforces owner-bound heartbeat and releases every owned path", () => {
  const repo = repository(); const leases = store(repo.path);
  confirmed(leases, "contract-1", owner, ["src/a.ts", "src/b.ts"]);
  assert.throws(() => leases.heartbeat({ workContractId: "contract-1", owner: otherOwner }), LeaseOwnershipError);
  leases.release({ workContractId: "contract-1", owner });
  assert.doesNotThrow(() => leases.acquire({ workContractId: "replacement", owner: otherOwner, paths: ["src/a.ts", "src/b.ts"] }));
  leases.close();
});

test("pending recovery event paths collide with direct acquisition until acknowledgement", () => {
  const repo = repository(); const leases = store(repo.path);
  confirmed(leases);
  const event = leases.releaseForRecovery({ workContractId: "contract-1", owner, reason: "handoff" });
  assert.equal(event.heartbeatAt, 100);
  assert.throws(() => leases.acquire({ workContractId: "replacement", owner: otherOwner, paths: ["src/owned.ts"] }), (error: unknown) => {
    assert.ok(error instanceof LeaseCollisionError);
    assert.deepEqual(error.collisions, [{ path: "src/owned.ts", workContractId: "contract-1", actor: owner.actor, beadId: owner.beadId }]);
    return true;
  });
  leases.acknowledgeRecovery(event.id);
  assert.doesNotThrow(() => leases.acquire({ workContractId: "replacement", owner: otherOwner, paths: ["src/owned.ts"] }));
  leases.close();
});

test("never inspects a fresh contract", () => {
  const repo = repository(); let inspections = 0;
  const leases = store(repo.path, () => 100, () => { inspections += 1; return "dead"; });
  confirmed(leases);
  const result = leases.reconcileStaleSessions();
  assert.equal(inspections, 0);
  assert.deepEqual(result.retained, [{ workContractId: "contract-1", heartbeatState: "fresh" }]);
  leases.close();
});

test("releases only stale never-attempted unconfirmed contracts", () => {
  const repo = repository(); let now = 100;
  const leases = store(repo.path, () => now, () => "dead");
  leases.acquire({ workContractId: "never-attempted", owner, paths: ["src/never.ts"] });
  leases.acquire({ workContractId: "attempted", owner: otherOwner, paths: ["src/attempted.ts"] });
  leases.markRemoteAttempted({ workContractId: "attempted", owner: otherOwner });
  now = 200;
  const result = leases.reconcileStaleSessions();
  assert.deepEqual(result.releasedUnconfirmed, ["never-attempted"]);
  assert.equal(leases.getWorkContract("never-attempted"), undefined);
  assert.equal(leases.getWorkContract("attempted")?.remoteAttempted, true);
  assert.equal(result.recoveryEvents.length, 0);
  leases.close();
});

test("creates stale recovery events only for confirmed dead and mismatched contracts", () => {
  for (const status of ["dead", "mismatched"] as const) {
    const repo = repository(); let now = 100;
    const leases = store(repo.path, () => now, () => status);
    confirmed(leases, `contract-${status}`); now = 200;
    const result = leases.reconcileStaleSessions();
    assert.equal(result.recoveryEvents[0]?.cause, `stale-session-${status}`);
    assert.equal(leases.getWorkContract(`contract-${status}`), undefined);
    leases.close();
  }
});

test("retains expired alive, ambiguous, and unknown contracts", () => {
  for (const status of ["alive", "ambiguous", "unknown"] as const) {
    const repo = repository(); let now = 100;
    const leases = store(repo.path, () => now, () => status);
    confirmed(leases, `contract-${status}`); now = 200;
    const result = leases.reconcileStaleSessions();
    assert.deepEqual(result.retained, [{ workContractId: `contract-${status}`, processStatus: status, heartbeatState: "expired" }]);
    assert.notEqual(leases.getWorkContract(`contract-${status}`), undefined);
    leases.close();
  }
});

test("does not convert completing work into stale recovery", () => {
  const repo = repository(); let now = 100;
  const leases = store(repo.path, () => now, () => "dead");
  confirmed(leases);
  leases.beginCompletion({ workContractId: "contract-1", owner }); now = 200;
  const result = leases.reconcileStaleSessions();
  assert.deepEqual(result.recoveryEvents, []);
  assert.equal(result.completionEvents.length, 1);
  assert.deepEqual(result.retained, [{ workContractId: "contract-1", state: "completing" }]);
  leases.close();
});

test("creates and atomically acknowledges a durable completion event", () => {
  const repo = repository(); const leases = store(repo.path);
  confirmed(leases);
  const event = leases.beginCompletion({ workContractId: "contract-1", owner });
  assert.equal(event.heartbeatAt, 100);
  assert.equal(leases.getWorkContract("contract-1")?.completing, true);
  leases.acknowledgeCompletion(event.id);
  assert.equal(leases.getWorkContract("contract-1"), undefined);
  assert.deepEqual(leases.completionEvents(), []);
  leases.close();
});

test("completion acknowledgement rejects an event heartbeat that differs from its completing lease", () => {
  const repo = repository(); const leases = store(repo.path);
  confirmed(leases);
  const event = leases.beginCompletion({ workContractId: "contract-1", owner });
  const database = new Database(leases.databasePath);
  database.prepare("UPDATE completion_events SET heartbeat_at = ? WHERE id = ?").run(event.heartbeatAt + 1, event.id);
  database.close();
  assert.throws(() => leases.acknowledgeCompletion(event.id), /does not match its completing local contract/);
  leases.close();
});

test("serializes lifecycle commands and only reclaims dead or mismatched owners", () => {
  const repo = repository();
  const leases = store(repo.path, () => 100, (process) => process.pid === commandA.pid ? "alive" : "dead");
  leases.acquireLifecycleLock(commandA);
  assert.throws(() => leases.acquireLifecycleLock(commandB), LifecycleLockError);
  leases.releaseLifecycleLock(commandA);
  leases.acquireLifecycleLock(commandA);
  leases.close();

  for (const status of ["dead", "mismatched"] as const) {
    const reclaim = store(repo.path, () => 100, (process) => process.pid === commandA.pid ? status : "unknown");
    reclaim.acquireLifecycleLock(commandB);
    reclaim.releaseLifecycleLock(commandB);
    reclaim.close();
    if (status === "dead") {
      const reset = store(repo.path, () => 100, () => "alive"); reset.acquireLifecycleLock(commandA); reset.close();
    }
  }
});

test("blocks lifecycle-lock takeover when inspection is unknown", () => {
  const repo = repository();
  const first = store(repo.path, () => 100, () => "alive"); first.acquireLifecycleLock(commandA); first.close();
  const second = store(repo.path, () => 100, () => "unknown");
  assert.throws(() => second.acquireLifecycleLock(commandB), LifecycleLockError);
  second.close();
});

test("rejects a pre-existing legacy lease schema without migration", () => {
  const repo = repository();
  const database = new Database(leaseDatabasePath(repo.path));
  database.exec("CREATE TABLE work_contracts (work_contract_id TEXT PRIMARY KEY)");
  database.close();
  assert.throws(() => openLeaseStore(repo.path), (error: unknown) => {
    assert.ok(error instanceof LegacyLeaseDatabaseError);
    assert.match(error.message, /Finish or clear all old leases deliberately/);
    return true;
  });
});

test("rejects the prior event schema without a heartbeat expectation", () => {
  const repo = repository(); const leases = store(repo.path); const databasePath = leases.databasePath; leases.close();
  const database = new Database(databasePath);
  database.exec(`DROP TABLE completion_events;
    CREATE TABLE completion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
      work_contract_id TEXT NOT NULL UNIQUE CHECK (length(trim(work_contract_id)) > 0),
      actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
      bead_id TEXT NOT NULL CHECK (length(trim(bead_id)) > 0),
      process_id INTEGER NOT NULL CHECK (process_id > 0),
      process_started_at TEXT NOT NULL CHECK (length(trim(process_started_at)) > 0),
      paths_json TEXT NOT NULL CHECK (json_valid(paths_json)),
      created_at INTEGER NOT NULL CHECK (created_at >= 0)
    );`);
  database.close();
  assert.throws(() => openLeaseStore(repo.path), LegacyLeaseDatabaseError);
});

test("rejects unknown and weakened same-column schema objects", () => {
  const unknownRepo = repository(); const unknownStore = store(unknownRepo.path); const unknownPath = unknownStore.databasePath; unknownStore.close();
  const unknownDatabase = new Database(unknownPath); unknownDatabase.exec("CREATE TABLE unexpected_state (value TEXT)"); unknownDatabase.close();
  assert.throws(() => openLeaseStore(unknownRepo.path), LegacyLeaseDatabaseError);

  const weakenedRepo = repository(); const weakenedStore = store(weakenedRepo.path); const weakenedPath = weakenedStore.databasePath; weakenedStore.close();
  const sourceDatabase = new Database(weakenedPath);
  const schema = sourceDatabase.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`).all() as Array<{ type: string; name: string; sql: string }>;
  sourceDatabase.close(); rmSync(weakenedPath);
  const weakenedDatabase = new Database(weakenedPath);
  for (const object of schema.filter((object) => object.type === "table")) {
    const sql = object.name === "work_contracts"
      ? object.sql.replace("CHECK (completing <= remote_confirmed)", "CHECK (1)")
      : object.sql;
    weakenedDatabase.exec(sql);
  }
  for (const object of schema.filter((object) => object.type === "index")) weakenedDatabase.exec(object.sql);
  assert.deepEqual((weakenedDatabase.prepare("PRAGMA table_info(work_contracts)").all() as Array<{ name: string }>).map((column) => column.name),
    ["work_contract_id", "actor", "bead_id", "process_id", "process_started_at", "acquired_at", "heartbeat_at", "remote_attempted", "remote_confirmed", "completing"]);
  weakenedDatabase.close();
  assert.throws(() => openLeaseStore(weakenedRepo.path), LegacyLeaseDatabaseError);
});

test("fails closed on malformed contract fields and non-normalized path collisions", () => {
  const malformedRepo = repository(); const malformedLeases = store(malformedRepo.path); confirmed(malformedLeases);
  const malformedDatabase = new Database(malformedLeases.databasePath); malformedDatabase.pragma("ignore_check_constraints = ON");
  malformedDatabase.prepare("UPDATE work_contracts SET process_id = 0 WHERE work_contract_id = 'contract-1'").run(); malformedDatabase.close();
  assert.throws(() => malformedLeases.getWorkContract("contract-1"), /identity is invalid/);
  malformedLeases.close();

  const pathRepo = repository(); const pathLeases = store(pathRepo.path);
  pathLeases.acquire({ workContractId: "path-contract", owner, paths: ["src/owned.ts"] });
  const pathDatabase = new Database(pathLeases.databasePath);
  pathDatabase.prepare("UPDATE path_leases SET path = 'src//owned.ts' WHERE work_contract_id = 'path-contract'").run(); pathDatabase.close();
  assert.throws(() => pathLeases.acquire({ workContractId: "replacement", owner: otherOwner, paths: ["src/owned.ts"] }), /not normalized/);
  pathLeases.close();
});

test("il-w0t: single-contract hot paths validate only the rows they touch", () => {
  const repo = repository(); const leases = store(repo.path);
  confirmed(leases, "healthy-1", owner, ["src/healthy.ts"]);
  confirmed(leases, "corrupt-2", otherOwner, ["src/other.ts"]);
  const database = new Database(leases.databasePath); database.pragma("ignore_check_constraints = ON");
  database.prepare("UPDATE work_contracts SET process_id = 0 WHERE work_contract_id = 'corrupt-2'").run(); database.close();

  // The healthy contract's heartbeat, release, and read paths no longer scan
  // — and no longer trip over — the unrelated corrupt contract.
  const renewed = leases.heartbeat({ workContractId: "healthy-1", owner });
  assert.equal(renewed.workContractId, "healthy-1");
  assert.equal(renewed.heartbeatAt, 100);
  leases.release({ workContractId: "healthy-1", owner });

  // The corrupt contract itself still fails closed on every path, including
  // the hot ones.
  assert.throws(() => leases.heartbeat({ workContractId: "corrupt-2", owner: otherOwner }), /identity is invalid/);
  assert.throws(() => leases.release({ workContractId: "corrupt-2", owner: otherOwner }), /identity is invalid/);

  // Whole-database and read-any operations keep the full sweep and still
  // fail closed on the corrupt contract.
  assert.throws(() => leases.listWorkContracts(), /identity is invalid/);
  assert.throws(() => leases.reconcileStaleSessions(), /identity is invalid/);
  assert.throws(() => leases.acquire({ workContractId: "contract-3", owner, paths: ["src/third.ts"] }), /identity is invalid/);
  assert.throws(() => leases.getWorkContract("corrupt-2"), /identity is invalid/);
  leases.close();
});

test("fails closed on corrupt persisted events", () => {
  const repo = repository(); const leases = store(repo.path);
  const db = new Database(leases.databasePath); db.pragma("ignore_check_constraints = ON");
  db.prepare(`INSERT INTO recovery_events (work_contract_id, actor, bead_id, process_id, process_started_at, paths_json, heartbeat_at, cause, created_at)
    VALUES ('corrupt', 'actor', 'il-corrupt', 1, 'start', '["src/owned.ts"]', -1, 'explicit-release', 1)`).run();
  db.close();
  assert.throws(() => leases.recoveryEvents(), /invalid heartbeat time/);
  leases.close();
});
