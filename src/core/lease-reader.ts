import Database from "better-sqlite3";

import { existingLeaseDatabasePath } from "./git-common-directory.js";
import { normalizeLeasePaths } from "./paths.js";
import type { LeaseOwner, LeaseReader, LeaseState } from "./types.js";

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

export class SqliteLeaseReader implements LeaseReader {
  readonly databasePath: string;
  private readonly database: Database.Database;

  constructor(repositoryPath: string) {
    this.databasePath = existingLeaseDatabasePath(repositoryPath);
    this.database = new Database(this.databasePath, { readonly: true, fileMustExist: true });
    this.database.pragma("query_only = ON");
  }

  listWorkContracts(): LeaseState[] {
    const contracts = this.database.prepare("SELECT * FROM work_contracts ORDER BY work_contract_id").all() as WorkContractRow[];
    return contracts.map((contract) => this.leaseState(contract));
  }

  getWorkContractByBeadId(beadId: string): LeaseState | undefined {
    if (typeof beadId !== "string" || beadId.trim() === "") throw new TypeError("beadId must be a non-empty string");
    const contract = this.database.prepare("SELECT * FROM work_contracts WHERE bead_id = ?").get(beadId) as WorkContractRow | undefined;
    return contract === undefined ? undefined : this.leaseState(contract);
  }

  close(): void { this.database.close(); }

  private leaseState(contract: WorkContractRow): LeaseState {
    validateWorkContractRow(contract);
    const paths = (this.database.prepare("SELECT path, work_contract_id FROM path_leases WHERE work_contract_id = ? ORDER BY path")
      .all(contract.work_contract_id) as PathLeaseRow[]).map((row) => row.path);
    return {
      workContractId: contract.work_contract_id,
      owner: ownerFromRow(contract),
      paths: validateNormalizedPaths(paths, `Work contract ${contract.work_contract_id}`),
      acquiredAt: contract.acquired_at,
      heartbeatAt: contract.heartbeat_at,
      remoteAttempted: contract.remote_attempted === 1,
      remoteConfirmed: contract.remote_confirmed === 1,
      completing: contract.completing === 1,
    };
  }
}

export function openLeaseReader(repositoryPath: string): LeaseReader { return new SqliteLeaseReader(repositoryPath); }

function ownerFromRow(row: Pick<WorkContractRow, "work_contract_id" | "actor" | "bead_id" | "process_id" | "process_started_at">): LeaseOwner {
  if (typeof row.actor !== "string" || row.actor.trim() === "" || typeof row.bead_id !== "string" || row.bead_id.trim() === ""
    || !Number.isSafeInteger(row.process_id) || row.process_id <= 0 || typeof row.process_started_at !== "string" || row.process_started_at.trim() === "") {
    throw new Error(`Work contract ${row.work_contract_id} has invalid owner identity`);
  }
  return { actor: row.actor, beadId: row.bead_id, process: { pid: row.process_id, startedAt: row.process_started_at } };
}

function validateWorkContractRow(row: WorkContractRow): void {
  if (typeof row.work_contract_id !== "string" || row.work_contract_id.trim() === "") throw new Error("Work contract has invalid ID");
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

function validateNormalizedPaths(paths: string[], label: string): string[] {
  if (paths.length === 0) throw new Error(`${label} has no persisted paths`);
  if (!paths.every((path) => typeof path === "string")) throw new Error(`${label} has invalid paths`);
  let normalized: string[];
  try { normalized = normalizeLeasePaths(paths); } catch (error) { throw new Error(`${label} has invalid paths: ${message(error)}`); }
  if (paths.length !== normalized.length || paths.some((path, index) => path !== normalized[index])) {
    throw new Error(`${label} paths are not normalized`);
  }
  return normalized;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
