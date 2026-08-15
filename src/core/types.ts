export type ProcessStatus = "alive" | "dead" | "mismatched" | "ambiguous" | "unknown";

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
  remoteAttempted: boolean;
  remoteConfirmed: boolean;
  completing: boolean;
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

export interface ReleaseForRecoveryInput extends WorkContractOwnerInput {
  reason: string;
}

export interface LeaseCollision {
  path: string;
  workContractId: string;
  actor: string;
  beadId: string;
}

export type HeartbeatState = "fresh" | "expired";
export type RecoveryCause = "explicit-release" | "stale-session-dead" | "stale-session-mismatched";

export interface RecoveryEvent {
  id: number;
  workContractId: string;
  owner: LeaseOwner;
  paths: string[];
  heartbeatAt: number;
  cause: RecoveryCause;
  reason: string | undefined;
  createdAt: number;
}

export interface CompletionEvent {
  id: number;
  workContractId: string;
  owner: LeaseOwner;
  paths: string[];
  heartbeatAt: number;
  createdAt: number;
}

export interface RetainedWorkContract {
  workContractId: string;
  processStatus: ProcessStatus;
  heartbeatState: "expired";
}

export interface UninspectedWorkContract {
  workContractId: string;
  heartbeatState: "fresh";
}

export interface CompletingWorkContract {
  workContractId: string;
  state: "completing";
}

export interface StaleSessionReconciliation {
  recoveryEvents: RecoveryEvent[];
  completionEvents: CompletionEvent[];
  retained: Array<RetainedWorkContract | UninspectedWorkContract | CompletingWorkContract>;
  releasedUnconfirmed: string[];
}

export type ProcessInspector = (process: ProcessIdentity) => ProcessStatus;

export interface LeaseStoreOptions {
  clock?: () => number;
  processInspector?: ProcessInspector;
  staleAfterMs?: number;
}

export interface LeaseReader {
  readonly databasePath: string;
  listWorkContracts(): LeaseState[];
  getWorkContractByBeadId(beadId: string): LeaseState | undefined;
  close(): void;
}

export interface LeaseStore extends LeaseReader {
  readonly databasePath: string;
  acquireLifecycleLock(processor: ProcessIdentity): void;
  releaseLifecycleLock(processor: ProcessIdentity): void;
  acquire(input: AcquireLeaseInput): LeaseState;
  markRemoteAttempted(input: WorkContractOwnerInput): LeaseState;
  confirmRemote(input: WorkContractOwnerInput): LeaseState;
  heartbeat(input: WorkContractOwnerInput): LeaseState;
  release(input: WorkContractOwnerInput): LeaseState;
  releaseForRecovery(input: ReleaseForRecoveryInput): RecoveryEvent;
  beginCompletion(input: WorkContractOwnerInput): CompletionEvent;
  acknowledgeCompletion(eventId: number): void;
  acknowledgeRecovery(eventId: number): void;
  recoveryEvents(): RecoveryEvent[];
  completionEvents(): CompletionEvent[];
  getWorkContract(workContractId: string): LeaseState | undefined;
  getWorkContractByBeadId(beadId: string): LeaseState | undefined;
  reconcileStaleSessions(): StaleSessionReconciliation;
  hasPendingLifecycleWork(): boolean;
  close(): void;
}
