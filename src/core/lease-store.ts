import Database from "better-sqlite3";

import {
  LeaseCollisionError,
  LeaseOwnershipError,
  WorkContractExistsError,
  WorkContractNotFoundError,
} from "./errors.js";
import { leaseDatabasePath } from "./git-common-directory.js";
import { normalizeLeasePaths } from "./paths.js";
import { inspectProcess } from "./process-identity.js";
import type {
  AcquireLeaseInput,
  HeartbeatState,
  LeaseCollision,
  LeaseOwner,
  LeaseState,
  LeaseStore,
  LeaseStoreOptions,
  ProcessIdentity,
  ProcessStatus,
  ReclaimedWorkContract,
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
}

interface PathLeaseRow {
  path: string;
}

interface CollisionRow extends WorkContractRow {
  path: string;
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
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs < 0) {
      throw new RangeError("staleAfterMs must be a non-negative finite number");
    }

    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.createSchema();
  }

  acquire(input: AcquireLeaseInput): LeaseState {
    validateAcquireInput(input);
    const paths = normalizeLeasePaths(input.paths);

    return this.database.transaction(() => {
      this.reconcileStaleSessionsInTransaction();

      const existing = this.contractRow(input.workContractId);
      if (existing !== undefined) {
        throw new WorkContractExistsError(input.workContractId);
      }

      const collisions = this.collisionsFor(paths);
      if (collisions.length > 0) {
        throw new LeaseCollisionError(collisions);
      }

      const now = this.clock();
      this.database.prepare(`
        INSERT INTO work_contracts (
          work_contract_id, actor, bead_id, process_id, process_started_at, acquired_at, heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.workContractId,
        input.owner.actor,
        input.owner.beadId,
        input.owner.process.pid,
        input.owner.process.startedAt,
        now,
        now,
      );

      const insertPath = this.database.prepare("INSERT INTO path_leases (path, work_contract_id) VALUES (?, ?)");
      for (const path of paths) {
        insertPath.run(path, input.workContractId);
      }

      return this.requiredLeaseState(input.workContractId);
    }).immediate();
  }

  heartbeat(input: WorkContractOwnerInput): LeaseState {
    validateOwnerInput(input);
    return this.database.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE work_contracts
        SET heartbeat_at = ?
        WHERE work_contract_id = ?
          AND actor = ?
          AND bead_id = ?
          AND process_id = ?
          AND process_started_at = ?
      `).run(
        this.clock(),
        input.workContractId,
        input.owner.actor,
        input.owner.beadId,
        input.owner.process.pid,
        input.owner.process.startedAt,
      );

      if (changed.changes === 0) {
        this.throwOwnershipOrNotFound(input);
      }
      return this.requiredLeaseState(input.workContractId);
    }).immediate();
  }

  release(input: WorkContractOwnerInput): LeaseState {
    validateOwnerInput(input);
    return this.database.transaction(() => {
      const lease = this.requiredLeaseState(input.workContractId);
      if (!sameOwner(lease.owner, input.owner)) {
        throw new LeaseOwnershipError(input.workContractId);
      }

      this.database.prepare("DELETE FROM work_contracts WHERE work_contract_id = ?").run(input.workContractId);
      return lease;
    }).immediate();
  }

  getWorkContract(workContractId: string): LeaseState | undefined {
    return this.database.transaction(() => {
      const contract = this.contractRow(workContractId);
      return contract === undefined ? undefined : this.leaseState(contract);
    }).deferred();
  }

  reconcileStaleSessions(): StaleSessionReconciliation {
    return this.database.transaction(() => this.reconcileStaleSessionsInTransaction()).immediate();
  }

  close(): void {
    this.database.close();
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS work_contracts (
        work_contract_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        bead_id TEXT NOT NULL,
        process_id INTEGER NOT NULL,
        process_started_at TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS path_leases (
        path TEXT PRIMARY KEY,
        work_contract_id TEXT NOT NULL REFERENCES work_contracts(work_contract_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS path_leases_work_contract_id
        ON path_leases(work_contract_id);
    `);
  }

  private reconcileStaleSessionsInTransaction(): StaleSessionReconciliation {
    const released: ReclaimedWorkContract[] = [];
    const retained: Array<RetainedWorkContract | UninspectedWorkContract> = [];
    const contracts = this.database.prepare("SELECT * FROM work_contracts ORDER BY work_contract_id").all() as WorkContractRow[];

    for (const contract of contracts) {
      const heartbeatState = this.heartbeatState(contract.heartbeat_at);
      if (heartbeatState === "fresh") {
        retained.push({
          workContractId: contract.work_contract_id,
          heartbeatState,
        });
        continue;
      }

      const processStatus = this.processInspector(processIdentity(contract));
      if (processStatus === "dead" || processStatus === "mismatched") {
        const paths = this.pathsFor(contract.work_contract_id);
        this.database.prepare("DELETE FROM work_contracts WHERE work_contract_id = ?").run(contract.work_contract_id);
        released.push({
          workContractId: contract.work_contract_id,
          paths,
          processStatus,
          heartbeatState,
        });
      } else {
        retained.push({
          workContractId: contract.work_contract_id,
          processStatus,
          heartbeatState,
        });
      }
    }

    return { released, retained };
  }

  private heartbeatState(heartbeatAt: number): HeartbeatState {
    return this.clock() - heartbeatAt > this.staleAfterMs ? "expired" : "fresh";
  }

  private collisionsFor(paths: string[]): LeaseCollision[] {
    const placeholders = paths.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT path_leases.path, work_contracts.*
      FROM path_leases
      JOIN work_contracts ON work_contracts.work_contract_id = path_leases.work_contract_id
      WHERE path_leases.path IN (${placeholders})
      ORDER BY path_leases.path
    `).all(...paths) as CollisionRow[];

    return rows.map((row) => ({
      path: row.path,
      workContractId: row.work_contract_id,
      actor: row.actor,
      beadId: row.bead_id,
    }));
  }

  private contractRow(workContractId: string): WorkContractRow | undefined {
    return this.database.prepare("SELECT * FROM work_contracts WHERE work_contract_id = ?").get(workContractId) as WorkContractRow | undefined;
  }

  private pathsFor(workContractId: string): string[] {
    return (this.database.prepare("SELECT path FROM path_leases WHERE work_contract_id = ? ORDER BY path").all(workContractId) as PathLeaseRow[])
      .map((row) => row.path);
  }

  private requiredLeaseState(workContractId: string): LeaseState {
    const contract = this.contractRow(workContractId);
    if (contract === undefined) {
      throw new WorkContractNotFoundError(workContractId);
    }
    return this.leaseState(contract);
  }

  private leaseState(contract: WorkContractRow): LeaseState {
    return {
      workContractId: contract.work_contract_id,
      owner: {
        actor: contract.actor,
        beadId: contract.bead_id,
        process: processIdentity(contract),
      },
      paths: this.pathsFor(contract.work_contract_id),
      acquiredAt: contract.acquired_at,
      heartbeatAt: contract.heartbeat_at,
    };
  }

  private throwOwnershipOrNotFound(input: WorkContractOwnerInput): never {
    if (this.contractRow(input.workContractId) === undefined) {
      throw new WorkContractNotFoundError(input.workContractId);
    }
    throw new LeaseOwnershipError(input.workContractId);
  }
}

export function openLeaseStore(repositoryPath: string, options?: LeaseStoreOptions): LeaseStore {
  return new SqliteLeaseStore(repositoryPath, options);
}

function processIdentity(row: WorkContractRow): ProcessIdentity {
  return { pid: row.process_id, startedAt: row.process_started_at };
}

function sameOwner(left: LeaseOwner, right: LeaseOwner): boolean {
  return left.actor === right.actor
    && left.beadId === right.beadId
    && left.process.pid === right.process.pid
    && left.process.startedAt === right.process.startedAt;
}

function validateAcquireInput(input: AcquireLeaseInput): void {
  validateWorkContractId(input.workContractId);
  validateOwner(input.owner);
}

function validateOwnerInput(input: WorkContractOwnerInput): void {
  validateWorkContractId(input.workContractId);
  validateOwner(input.owner);
}

function validateWorkContractId(workContractId: string): void {
  if (typeof workContractId !== "string" || workContractId.trim() === "") {
    throw new TypeError("workContractId must be a non-empty string");
  }
}

function validateOwner(owner: LeaseOwner): void {
  if (owner.actor.trim() === "" || owner.beadId.trim() === "" || owner.process.startedAt.trim() === "") {
    throw new TypeError("Lease owner fields must be non-empty strings");
  }
  if (!Number.isSafeInteger(owner.process.pid) || owner.process.pid <= 0) {
    throw new TypeError("Lease owner process pid must be a positive integer");
  }
}
