import Database from "better-sqlite3";

import {
  LegacyLeaseDatabaseError,
  LeaseCollisionError,
  LeaseOwnershipError,
  LifecycleLockError,
  WorkContractExistsError,
  WorkContractNotFoundError,
} from "./errors.js";
import { leaseDatabasePath } from "./git-common-directory.js";
import { normalizeLeasePaths } from "./paths.js";
import { inspectProcess } from "./process-identity.js";
import type {
  AcquireLeaseInput,
  CompletingWorkContract,
  CompletionEvent,
  HeartbeatState,
  LeaseCollision,
  LeaseOwner,
  LeaseState,
  LeaseStore,
  LeaseStoreOptions,
  ProcessIdentity,
  ProcessStatus,
  RecoveryCause,
  RecoveryEvent,
  ReleaseForRecoveryInput,
  RetainedWorkContract,
  StaleSessionReconciliation,
  UninspectedWorkContract,
  WorkContractOwnerInput,
} from "./types.js";

interface WorkContractRow {
  work_contract_id: string;
  actor: string;
  bead_id: string;
  process_id: number;
  process_started_at: string;
  acquired_at: number;
  heartbeat_at: number;
  remote_attempted: number;
  remote_confirmed: number;
  completing: number;
}

interface PathLeaseRow { path: string; work_contract_id: string; }
interface CollisionRow { path: string; work_contract_id: string; actor: string; bead_id: string; }
interface EventRow extends Omit<WorkContractRow, "acquired_at" | "heartbeat_at" | "remote_attempted" | "remote_confirmed" | "completing"> {
  id: number;
  paths_json: string;
  heartbeat_at: number;
  created_at: number;
}
interface RecoveryEventRow extends EventRow { cause: RecoveryCause; reason: string | null; }
interface LifecycleLockRow { process_id: number; process_started_at: string; }

export const DEFAULT_STALE_AFTER_MS = 30_000;

const CREATE_SCHEMA_SQL = `
  CREATE TABLE work_contracts (
    work_contract_id TEXT PRIMARY KEY CHECK (length(trim(work_contract_id)) > 0),
    actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
    bead_id TEXT NOT NULL UNIQUE CHECK (length(trim(bead_id)) > 0),
    process_id INTEGER NOT NULL CHECK (process_id > 0),
    process_started_at TEXT NOT NULL CHECK (length(trim(process_started_at)) > 0),
    acquired_at INTEGER NOT NULL CHECK (acquired_at >= 0),
    heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= acquired_at),
    remote_attempted INTEGER NOT NULL DEFAULT 0 CHECK (remote_attempted IN (0, 1)),
    remote_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (remote_confirmed IN (0, 1)),
    completing INTEGER NOT NULL DEFAULT 0 CHECK (completing IN (0, 1)),
    CHECK (remote_confirmed <= remote_attempted),
    CHECK (completing <= remote_confirmed)
  );
  CREATE TABLE path_leases (
    path TEXT PRIMARY KEY,
    work_contract_id TEXT NOT NULL REFERENCES work_contracts(work_contract_id) ON DELETE CASCADE
  );
  CREATE INDEX path_leases_work_contract_id ON path_leases(work_contract_id);
  CREATE TABLE recovery_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
    work_contract_id TEXT NOT NULL UNIQUE CHECK (length(trim(work_contract_id)) > 0),
    actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
    bead_id TEXT NOT NULL CHECK (length(trim(bead_id)) > 0),
    process_id INTEGER NOT NULL CHECK (process_id > 0),
    process_started_at TEXT NOT NULL CHECK (length(trim(process_started_at)) > 0),
    paths_json TEXT NOT NULL CHECK (json_valid(paths_json)),
    heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= 0),
    cause TEXT NOT NULL CHECK (cause IN ('explicit-release', 'stale-session-dead', 'stale-session-mismatched')),
    reason TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    CHECK (reason IS NULL OR length(trim(reason)) > 0)
  );
  CREATE TABLE completion_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
    work_contract_id TEXT NOT NULL UNIQUE CHECK (length(trim(work_contract_id)) > 0),
    actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
    bead_id TEXT NOT NULL CHECK (length(trim(bead_id)) > 0),
    process_id INTEGER NOT NULL CHECK (process_id > 0),
    process_started_at TEXT NOT NULL CHECK (length(trim(process_started_at)) > 0),
    paths_json TEXT NOT NULL CHECK (json_valid(paths_json)),
    heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  );
  CREATE TABLE lifecycle_locks (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    process_id INTEGER NOT NULL CHECK (process_id > 0),
    process_started_at TEXT NOT NULL CHECK (length(trim(process_started_at)) > 0)
  );
`;

type SchemaObject = { type: string; name: string; tableName: string; sql: string | null };
const EXPECTED_SCHEMA_SIGNATURE = canonicalSchemaSignature();

function canonicalSchemaSignature(): SchemaObject[] {
  const database = new Database(":memory:");
  try {
    database.exec(CREATE_SCHEMA_SQL);
    return schemaSignature(database);
  } finally {
    database.close();
  }
}

function schemaSignature(database: Database.Database): SchemaObject[] {
  return database.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as SchemaObject[];
}

export class SqliteLeaseStore implements LeaseStore {
  readonly databasePath: string;
  private readonly database: Database.Database;
  private readonly clock: () => number;
  private readonly processInspector: (identity: ProcessIdentity) => ProcessStatus;
  private readonly staleAfterMs: number;

  constructor(repositoryPath: string, options: LeaseStoreOptions = {}) {
    this.databasePath = leaseDatabasePath(repositoryPath);
    this.database = new Database(this.databasePath);
    this.clock = options.clock ?? Date.now;
    this.processInspector = options.processInspector ?? inspectProcess;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs < 0) throw new RangeError("staleAfterMs must be a non-negative finite number");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.initializeSchema();
    this.database.pragma("journal_mode = WAL");
  }

  acquireLifecycleLock(processor: ProcessIdentity): void {
    validateProcess(processor, "Lifecycle processor");
    this.database.transaction(() => {
      this.validatePersistedState();
      const row = this.database.prepare("SELECT process_id, process_started_at FROM lifecycle_locks WHERE singleton = 1").get() as LifecycleLockRow | undefined;
      if (row === undefined) {
        this.database.prepare("INSERT INTO lifecycle_locks (singleton, process_id, process_started_at) VALUES (1, ?, ?)").run(processor.pid, processor.startedAt);
        return;
      }
      const owner = processIdentity(row);
      validateProcess(owner, "Stored lifecycle processor");
      const status = this.processInspector(owner);
      if (status !== "dead" && status !== "mismatched") throw new LifecycleLockError(owner, status);
      this.database.prepare("UPDATE lifecycle_locks SET process_id = ?, process_started_at = ? WHERE singleton = 1").run(processor.pid, processor.startedAt);
    }).immediate();
  }

  releaseLifecycleLock(processor: ProcessIdentity): void {
    validateProcess(processor, "Lifecycle processor");
    this.database.transaction(() => {
      this.validatePersistedState();
      const changed = this.database.prepare("DELETE FROM lifecycle_locks WHERE singleton = 1 AND process_id = ? AND process_started_at = ?")
        .run(processor.pid, processor.startedAt);
      if (changed.changes !== 1) throw new Error("Lifecycle lock is not held by this command process");
    }).immediate();
  }

  acquire(input: AcquireLeaseInput): LeaseState {
    validateAcquireInput(input);
    const paths = normalizeLeasePaths(input.paths);
    return this.database.transaction(() => {
      this.validatePersistedState();
      if (this.contractRow(input.workContractId) !== undefined) throw new WorkContractExistsError(input.workContractId);
      const collisions = this.collisionsFor(paths);
      if (collisions.length > 0) throw new LeaseCollisionError(collisions);
      const now = this.clock();
      this.database.prepare(`INSERT INTO work_contracts (
        work_contract_id, actor, bead_id, process_id, process_started_at, acquired_at, heartbeat_at, remote_attempted, remote_confirmed, completing
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`).run(
        input.workContractId, input.owner.actor, input.owner.beadId, input.owner.process.pid, input.owner.process.startedAt, now, now,
      );
      const insertPath = this.database.prepare("INSERT INTO path_leases (path, work_contract_id) VALUES (?, ?)");
      for (const path of paths) insertPath.run(path, input.workContractId);
      return this.requiredLeaseState(input.workContractId);
    }).immediate();
  }

  markRemoteAttempted(input: WorkContractOwnerInput): LeaseState {
    validateOwnerInput(input);
    return this.database.transaction(() => {
      this.validateContractRows(input.workContractId);
      const lease = this.ownedLease(input);
      if (lease.remoteConfirmed) throw new Error(`Work contract ${input.workContractId} is already remotely confirmed`);
      this.database.prepare("UPDATE work_contracts SET remote_attempted = 1 WHERE work_contract_id = ?").run(input.workContractId);
      return this.requiredLeaseState(input.workContractId);
    }).immediate();
  }

  confirmRemote(input: WorkContractOwnerInput): LeaseState {
    validateOwnerInput(input);
    return this.database.transaction(() => {
      this.validateContractRows(input.workContractId);
      const lease = this.ownedLease(input);
      if (!lease.remoteAttempted) throw new Error(`Work contract ${input.workContractId} has no recorded remote claim attempt`);
      this.database.prepare("UPDATE work_contracts SET remote_confirmed = 1 WHERE work_contract_id = ?").run(input.workContractId);
      return this.requiredLeaseState(input.workContractId);
    }).immediate();
  }

  heartbeat(input: WorkContractOwnerInput): LeaseState {
    validateOwnerInput(input);
    return this.database.transaction(() => {
      this.validateContractRows(input.workContractId);
      const lease = this.ownedConfirmedLease(input);
      if (lease.completing) throw new Error(`Work contract ${input.workContractId} is completing`);
      this.database.prepare("UPDATE work_contracts SET heartbeat_at = ? WHERE work_contract_id = ?").run(this.clock(), input.workContractId);
      return this.requiredLeaseState(input.workContractId);
    }).immediate();
  }

  release(input: WorkContractOwnerInput): LeaseState {
    validateOwnerInput(input);
    return this.database.transaction(() => {
      this.validateContractRows(input.workContractId);
      const lease = this.ownedLease(input);
      this.database.prepare("DELETE FROM work_contracts WHERE work_contract_id = ?").run(input.workContractId);
      return lease;
    }).immediate();
  }

  releaseForRecovery(input: ReleaseForRecoveryInput): RecoveryEvent {
    validateOwnerInput(input);
    if (typeof input.reason !== "string" || input.reason.trim() === "") throw new TypeError("Recovery reason must be a non-empty string");
    return this.database.transaction(() => {
      this.validateContractRows(input.workContractId);
      const lease = this.ownedConfirmedLease(input);
      if (lease.completing) throw new Error(`Work contract ${input.workContractId} is completing`);
      const event = this.insertRecoveryEvent(lease, "explicit-release", input.reason);
      this.database.prepare("DELETE FROM work_contracts WHERE work_contract_id = ?").run(input.workContractId);
      return event;
    }).immediate();
  }

  beginCompletion(input: WorkContractOwnerInput): CompletionEvent {
    validateOwnerInput(input);
    return this.database.transaction(() => {
      this.validateContractRows(input.workContractId);
      const lease = this.ownedConfirmedLease(input);
      if (lease.completing) throw new Error(`Work contract ${input.workContractId} is already completing`);
      this.database.prepare("UPDATE work_contracts SET completing = 1 WHERE work_contract_id = ?").run(input.workContractId);
      const result = this.database.prepare(`INSERT INTO completion_events (
        work_contract_id, actor, bead_id, process_id, process_started_at, paths_json, heartbeat_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(lease.workContractId, lease.owner.actor, lease.owner.beadId, lease.owner.process.pid, lease.owner.process.startedAt,
          JSON.stringify(lease.paths), lease.heartbeatAt, this.clock());
      return this.requiredCompletionEvent(Number(result.lastInsertRowid));
    }).immediate();
  }

  acknowledgeCompletion(eventId: number): void {
    validateEventId(eventId, "Completion event");
    this.database.transaction(() => {
      this.validatePersistedState();
      const event = this.requiredCompletionEvent(eventId);
      const lease = this.requiredLeaseState(event.workContractId);
      if (!lease.completing || !sameOwner(lease.owner, event.owner) || !samePaths(lease.paths, event.paths) || lease.heartbeatAt !== event.heartbeatAt) {
        throw new Error(`Completion event ${eventId} does not match its completing local contract`);
      }
      this.database.prepare("DELETE FROM work_contracts WHERE work_contract_id = ?").run(event.workContractId);
      this.database.prepare("DELETE FROM completion_events WHERE id = ?").run(eventId);
    }).immediate();
  }

  acknowledgeRecovery(eventId: number): void {
    validateEventId(eventId, "Recovery event");
    this.database.transaction(() => {
      this.validatePersistedState();
      const changed = this.database.prepare("DELETE FROM recovery_events WHERE id = ?").run(eventId);
      if (changed.changes !== 1) throw new Error(`Recovery event ${eventId} does not exist`);
    }).immediate();
  }

  recoveryEvents(): RecoveryEvent[] {
    return this.database.transaction(() => { this.validatePersistedState(); return this.recoveryRows(); }).deferred();
  }

  completionEvents(): CompletionEvent[] {
    return this.database.transaction(() => { this.validatePersistedState(); return this.completionRows(); }).deferred();
  }

  getWorkContract(workContractId: string): LeaseState | undefined {
    validateWorkContractId(workContractId);
    return this.database.transaction(() => {
      this.validatePersistedState();
      const contract = this.contractRow(workContractId);
      return contract === undefined ? undefined : this.leaseState(contract);
    }).deferred();
  }

  listWorkContracts(): LeaseState[] {
    return this.database.transaction(() => {
      this.validatePersistedState();
      return (this.database.prepare("SELECT * FROM work_contracts ORDER BY work_contract_id").all() as WorkContractRow[])
        .map((contract) => this.leaseState(contract));
    }).deferred();
  }

  getWorkContractByBeadId(beadId: string): LeaseState | undefined {
    if (typeof beadId !== "string" || beadId.trim() === "") throw new TypeError("beadId must be a non-empty string");
    return this.database.transaction(() => {
      this.validatePersistedState();
      const contract = this.database.prepare("SELECT * FROM work_contracts WHERE bead_id = ?").get(beadId) as WorkContractRow | undefined;
      return contract === undefined ? undefined : this.leaseState(contract);
    }).deferred();
  }

  reconcileStaleSessions(): StaleSessionReconciliation {
    return this.database.transaction(() => {
      this.validatePersistedState();
      return this.reconcileStaleSessionsInTransaction();
    }).immediate();
  }

  hasPendingLifecycleWork(): boolean {
    return this.database.transaction(() => {
      this.validatePersistedState();
      const pending = this.database.prepare("SELECT EXISTS(SELECT 1 FROM recovery_events) OR EXISTS(SELECT 1 FROM completion_events) AS pending").get() as { pending: number };
      return pending.pending === 1;
    }).deferred();
  }

  close(): void { this.database.close(); }

  private initializeSchema(): void {
    const actual = schemaSignature(this.database);
    if (actual.length === 0) {
      this.database.exec(CREATE_SCHEMA_SQL);
      return;
    }
    if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_SCHEMA_SIGNATURE)) {
      this.database.close();
      throw new LegacyLeaseDatabaseError(this.databasePath);
    }
  }

  private validatePersistedState(): void {
    const contracts = this.database.prepare("SELECT * FROM work_contracts ORDER BY work_contract_id").all() as WorkContractRow[];
    const paths = this.database.prepare("SELECT path, work_contract_id FROM path_leases ORDER BY path").all() as PathLeaseRow[];
    this.validateContractAndPathRows(contracts, paths);
    this.recoveryRows();
    this.completionRows();
  }

  // il-w0t: the full sweep above is retained for multi-contract operations
  // (acquire collisions, reconciliation, lock hand-over), but single-contract
  // hot paths — heartbeat, claim confirmation, completion — only ever touch
  // one contract, so they validate exactly the rows they read: the contract,
  // its own path leases, and the event tables' consistency as far as the
  // operation depends on it. A corrupt *other* contract no longer blocks a
  // healthy heartbeat, and the cost is O(rows touched), not O(database).
  private validateContractRows(workContractId: string): void {
    const contract = this.contractRow(workContractId);
    if (contract === undefined) throw new WorkContractNotFoundError(workContractId);
    this.validateContractAndPathRows([contract], this.pathRowsFor(workContractId));
  }

  private pathRowsFor(workContractId: string): PathLeaseRow[] {
    return this.database.prepare("SELECT path, work_contract_id FROM path_leases WHERE work_contract_id = ? ORDER BY path").all(workContractId) as PathLeaseRow[];
  }

  private validateContractAndPathRows(contracts: WorkContractRow[], paths: PathLeaseRow[]): void {
    const contractIds = new Set<string>();
    const pathCounts = new Map<string, number>();
    for (const contract of contracts) {
      validateWorkContractRow(contract);
      contractIds.add(contract.work_contract_id);
    }
    for (const path of paths) {
      validateWorkContractId(path.work_contract_id);
      if (!contractIds.has(path.work_contract_id)) throw new Error(`Path lease ${String(path.path)} references a missing work contract`);
      validateNormalizedPaths([path.path], `Path lease ${String(path.path)}`);
      pathCounts.set(path.work_contract_id, (pathCounts.get(path.work_contract_id) ?? 0) + 1);
    }
    for (const contract of contracts) {
      if ((pathCounts.get(contract.work_contract_id) ?? 0) === 0) {
        throw new Error(`Work contract ${contract.work_contract_id} has no persisted paths`);
      }
    }
  }

  private reconcileStaleSessionsInTransaction(): StaleSessionReconciliation {
    const retained: Array<RetainedWorkContract | UninspectedWorkContract | CompletingWorkContract> = [];
    const releasedUnconfirmed: string[] = [];
    const contracts = this.database.prepare("SELECT * FROM work_contracts ORDER BY work_contract_id").all() as WorkContractRow[];
    for (const contract of contracts) {
      if (contract.completing === 1) {
        retained.push({ workContractId: contract.work_contract_id, state: "completing" });
        continue;
      }
      const heartbeatState = this.heartbeatState(contract.heartbeat_at);
      if (heartbeatState === "fresh") {
        retained.push({ workContractId: contract.work_contract_id, heartbeatState });
        continue;
      }
      const processStatus = this.processInspector(processIdentity(contract));
      if (processStatus !== "dead" && processStatus !== "mismatched") {
        retained.push({ workContractId: contract.work_contract_id, processStatus, heartbeatState });
        continue;
      }
      if (contract.remote_confirmed === 1) {
        this.insertRecoveryEvent(this.leaseState(contract), processStatus === "dead" ? "stale-session-dead" : "stale-session-mismatched", undefined);
        this.database.prepare("DELETE FROM work_contracts WHERE work_contract_id = ?").run(contract.work_contract_id);
      } else if (contract.remote_attempted === 0) {
        releasedUnconfirmed.push(contract.work_contract_id);
        this.database.prepare("DELETE FROM work_contracts WHERE work_contract_id = ?").run(contract.work_contract_id);
      } else {
        retained.push({ workContractId: contract.work_contract_id, processStatus, heartbeatState });
      }
    }
    return { recoveryEvents: this.recoveryRows(), completionEvents: this.completionRows(), retained, releasedUnconfirmed };
  }

  private insertRecoveryEvent(lease: LeaseState, cause: RecoveryCause, reason: string | undefined): RecoveryEvent {
    if (!lease.remoteConfirmed) throw new Error(`Unconfirmed work contract ${lease.workContractId} cannot create recovery work`);
    const result = this.database.prepare(`INSERT INTO recovery_events (
      work_contract_id, actor, bead_id, process_id, process_started_at, paths_json, heartbeat_at, cause, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(lease.workContractId, lease.owner.actor, lease.owner.beadId, lease.owner.process.pid, lease.owner.process.startedAt,
        JSON.stringify(lease.paths), lease.heartbeatAt, cause, reason ?? null, this.clock());
    return this.requiredRecoveryEvent(Number(result.lastInsertRowid));
  }

  private recoveryRows(): RecoveryEvent[] {
    return (this.database.prepare("SELECT * FROM recovery_events ORDER BY id").all() as RecoveryEventRow[]).map((row) => this.recoveryEvent(row));
  }

  private completionRows(): CompletionEvent[] {
    return (this.database.prepare("SELECT * FROM completion_events ORDER BY id").all() as EventRow[]).map((row) => this.completionEvent(row));
  }

  private requiredRecoveryEvent(id: number): RecoveryEvent {
    const row = this.database.prepare("SELECT * FROM recovery_events WHERE id = ?").get(id) as RecoveryEventRow | undefined;
    if (row === undefined) throw new Error(`Recovery event ${id} does not exist`);
    return this.recoveryEvent(row);
  }

  private requiredCompletionEvent(id: number): CompletionEvent {
    const row = this.database.prepare("SELECT * FROM completion_events WHERE id = ?").get(id) as EventRow | undefined;
    if (row === undefined) throw new Error(`Completion event ${id} does not exist`);
    return this.completionEvent(row);
  }

  private recoveryEvent(row: RecoveryEventRow): RecoveryEvent {
    const base = this.event(row, "Recovery");
    if (!isRecoveryCause(row.cause)) throw new Error(`Recovery event ${row.id} has invalid cause`);
    if (row.reason !== null && typeof row.reason !== "string") throw new Error(`Recovery event ${row.id} has an invalid reason`);
    if (row.cause === "explicit-release" && (row.reason === null || row.reason.trim() === "")) throw new Error(`Recovery event ${row.id} has no release reason`);
    return { ...base, cause: row.cause, reason: row.reason ?? undefined };
  }

  private completionEvent(row: EventRow): CompletionEvent { return this.event(row, "Completion"); }

  private event(row: EventRow, label: string): Omit<CompletionEvent, "id" | "createdAt"> & Pick<CompletionEvent, "id" | "createdAt"> {
    validateEventId(row.id, `${label} event`);
    validateWorkContractId(row.work_contract_id);
    const owner = ownerFromRow(row);
    if (!Number.isSafeInteger(row.created_at) || row.created_at < 0) throw new Error(`${label} event ${row.id} has invalid creation time`);
    const paths = parseNormalizedPaths(row.paths_json, `${label} event ${row.id}`);
    if (!Number.isSafeInteger(row.heartbeat_at) || row.heartbeat_at < 0) throw new Error(`${label} event ${row.id} has invalid heartbeat time`);
    return { id: row.id, workContractId: row.work_contract_id, owner, paths, heartbeatAt: row.heartbeat_at, createdAt: row.created_at };
  }

  private heartbeatState(heartbeatAt: number): HeartbeatState { return this.clock() - heartbeatAt > this.staleAfterMs ? "expired" : "fresh"; }

  private collisionsFor(paths: string[]): LeaseCollision[] {
    const placeholders = paths.map(() => "?").join(", ");
    const rows = this.database.prepare(`SELECT path_leases.path, work_contracts.work_contract_id, work_contracts.actor, work_contracts.bead_id FROM path_leases
      JOIN work_contracts ON work_contracts.work_contract_id = path_leases.work_contract_id
      WHERE path_leases.path IN (${placeholders})
      UNION ALL
      SELECT recovery_paths.value AS path, recovery_events.work_contract_id, recovery_events.actor, recovery_events.bead_id FROM recovery_events
      JOIN json_each(recovery_events.paths_json) AS recovery_paths
      WHERE recovery_paths.value IN (${placeholders})
      ORDER BY path`).all(...paths, ...paths) as CollisionRow[];
    return rows.map((row) => ({ path: row.path, workContractId: row.work_contract_id, actor: row.actor, beadId: row.bead_id }));
  }

  private contractRow(workContractId: string): WorkContractRow | undefined {
    return this.database.prepare("SELECT * FROM work_contracts WHERE work_contract_id = ?").get(workContractId) as WorkContractRow | undefined;
  }

  private pathsFor(workContractId: string): string[] {
    const paths = (this.database.prepare("SELECT path, work_contract_id FROM path_leases WHERE work_contract_id = ? ORDER BY path").all(workContractId) as PathLeaseRow[])
      .map((row) => row.path);
    return validateNormalizedPaths(paths, `Work contract ${workContractId}`);
  }

  private requiredLeaseState(workContractId: string): LeaseState {
    const contract = this.contractRow(workContractId);
    if (contract === undefined) throw new WorkContractNotFoundError(workContractId);
    return this.leaseState(contract);
  }

  private ownedLease(input: WorkContractOwnerInput): LeaseState {
    const lease = this.requiredLeaseState(input.workContractId);
    if (!sameOwner(lease.owner, input.owner)) throw new LeaseOwnershipError(input.workContractId);
    return lease;
  }

  private ownedConfirmedLease(input: WorkContractOwnerInput): LeaseState {
    const lease = this.ownedLease(input);
    if (!lease.remoteConfirmed) throw new Error(`Work contract ${input.workContractId} is not remotely confirmed`);
    return lease;
  }

  private leaseState(contract: WorkContractRow): LeaseState {
    validateWorkContractRow(contract);
    return {
      workContractId: contract.work_contract_id,
      owner: ownerFromRow(contract),
      paths: this.pathsFor(contract.work_contract_id),
      acquiredAt: contract.acquired_at,
      heartbeatAt: contract.heartbeat_at,
      remoteAttempted: contract.remote_attempted === 1,
      remoteConfirmed: contract.remote_confirmed === 1,
      completing: contract.completing === 1,
    };
  }
}

export function openLeaseStore(repositoryPath: string, options?: LeaseStoreOptions): LeaseStore { return new SqliteLeaseStore(repositoryPath, options); }

function processIdentity(row: { process_id: number; process_started_at: string }): ProcessIdentity { return { pid: row.process_id, startedAt: row.process_started_at }; }
function ownerFromRow(row: { actor: string; bead_id: string; process_id: number; process_started_at: string }): LeaseOwner {
  const owner = { actor: row.actor, beadId: row.bead_id, process: processIdentity(row) };
  validateOwner(owner);
  return owner;
}
function sameOwner(left: LeaseOwner, right: LeaseOwner): boolean {
  return left.actor === right.actor && left.beadId === right.beadId && left.process.pid === right.process.pid && left.process.startedAt === right.process.startedAt;
}
function samePaths(left: string[], right: string[]): boolean { return left.length === right.length && left.every((path, index) => path === right[index]); }
function isRecoveryCause(value: string): value is RecoveryCause {
  return value === "explicit-release" || value === "stale-session-dead" || value === "stale-session-mismatched";
}
function parseNormalizedPaths(value: string, label: string): string[] {
  if (typeof value !== "string") throw new Error(`${label} has invalid paths JSON`);
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new Error(`${label} has invalid paths JSON`); }
  return validateNormalizedPaths(raw, label);
}
function validateNormalizedPaths(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw) || !raw.every((path) => typeof path === "string")) throw new Error(`${label} has invalid paths`);
  let paths: string[];
  try { paths = normalizeLeasePaths(raw); } catch (error) { throw new Error(`${label} has invalid paths: ${error instanceof Error ? error.message : String(error)}`); }
  if (!samePaths(raw, paths)) throw new Error(`${label} paths are not normalized`);
  return paths;
}
function validateWorkContractRow(row: WorkContractRow): void {
  validateWorkContractId(row.work_contract_id);
  ownerFromRow(row);
  if (!Number.isSafeInteger(row.acquired_at) || row.acquired_at < 0 || !Number.isSafeInteger(row.heartbeat_at) || row.heartbeat_at < row.acquired_at) {
    throw new Error(`Work contract ${row.work_contract_id} has invalid timestamps`);
  }
  validateFlag(row.remote_attempted, "remote-attempted", row.work_contract_id);
  validateFlag(row.remote_confirmed, "remote-confirmed", row.work_contract_id);
  validateFlag(row.completing, "completing", row.work_contract_id);
  if (row.remote_confirmed > row.remote_attempted || row.completing > row.remote_confirmed) {
    throw new Error(`Work contract ${row.work_contract_id} has inconsistent remote state`);
  }
}
function validateFlag(value: number, name: string, workContractId: string): void {
  if (value !== 0 && value !== 1) throw new Error(`Work contract ${workContractId} has invalid ${name} state`);
}
function validateAcquireInput(input: AcquireLeaseInput): void { validateWorkContractId(input.workContractId); validateOwner(input.owner); }
function validateOwnerInput(input: WorkContractOwnerInput): void { validateWorkContractId(input.workContractId); validateOwner(input.owner); }
function validateEventId(id: number, label: string): void { if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`${label} ID must be a positive integer`); }
function validateWorkContractId(workContractId: string): void {
  if (typeof workContractId !== "string" || workContractId.trim() === "") throw new TypeError("workContractId must be a non-empty string");
}
function validateOwner(owner: LeaseOwner): void {
  if (typeof owner.actor !== "string" || typeof owner.beadId !== "string" || owner.actor.trim() === "" || owner.beadId.trim() === "") {
    throw new TypeError("Lease owner fields must be non-empty strings");
  }
  validateProcess(owner.process, "Lease owner process");
}
function validateProcess(process: ProcessIdentity, label: string): void {
  if (!Number.isSafeInteger(process.pid) || process.pid <= 0 || typeof process.startedAt !== "string" || process.startedAt.trim() === "") {
    throw new TypeError(`${label} identity is invalid`);
  }
}
