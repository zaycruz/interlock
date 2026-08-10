export type ProcessStatus = "alive" | "dead" | "mismatched" | "unknown";

export interface ProcessIdentity {
  pid: number;
  startedAt: string;
}

export interface LeaseOwner {
  actor: string;
  beadId: string;
  process: ProcessIdentity;
}

export interface LeaseState {
  workContractId: string;
  owner: LeaseOwner;
  paths: string[];
  acquiredAt: number;
  heartbeatAt: number;
}

export interface AcquireLeaseInput {
  workContractId: string;
  owner: LeaseOwner;
  paths: string[];
}

export interface WorkContractOwnerInput {
  workContractId: string;
  owner: LeaseOwner;
}

export interface LeaseCollision {
  path: string;
  workContractId: string;
  actor: string;
  beadId: string;
}

export type HeartbeatState = "fresh" | "expired";

export interface ReclaimedWorkContract {
  workContractId: string;
  paths: string[];
  processStatus: "dead" | "mismatched";
  heartbeatState: HeartbeatState;
}

export interface RetainedWorkContract {
  workContractId: string;
  processStatus: "alive" | "unknown";
  heartbeatState: HeartbeatState;
}

export interface StaleSessionReconciliation {
  released: ReclaimedWorkContract[];
  retained: RetainedWorkContract[];
}

export type ProcessInspector = (process: ProcessIdentity) => ProcessStatus;

export interface LeaseStoreOptions {
  clock?: () => number;
  processInspector?: ProcessInspector;
  staleAfterMs?: number;
}

export interface LeaseStore {
  readonly databasePath: string;
  acquire(input: AcquireLeaseInput): LeaseState;
  heartbeat(input: WorkContractOwnerInput): LeaseState;
  release(input: WorkContractOwnerInput): LeaseState;
  getWorkContract(workContractId: string): LeaseState | undefined;
  reconcileStaleSessions(): StaleSessionReconciliation;
  close(): void;
}
