export {
  LegacyLeaseDatabaseError,
  LeaseCollisionError,
  LeaseOwnershipError,
  LeasePathError,
  LifecycleLockError,
  UnsupportedPlatformError,
  WorkContractExistsError,
  WorkContractNotFoundError,
} from "./errors.js";
export { existingLeaseDatabasePath, leaseDatabasePath } from "./git-common-directory.js";
export { assertSupportedPlatform } from "./platform.js";
export { currentProcessIdentity, inspectProcess, processIdentityFor, sessionProcessIdentityFor } from "./process-identity.js";
export { DEFAULT_STALE_AFTER_MS, openLeaseStore, SqliteLeaseStore } from "./lease-store.js";
export { openLeaseReader, SqliteLeaseReader } from "./lease-reader.js";
export { normalizeLeasePaths } from "./paths.js";
export type {
  AcquireLeaseInput,
  CompletingWorkContract,
  CompletionEvent,
  HeartbeatState,
  LeaseCollision,
  LeaseOwner,
  LeaseReader,
  LeaseState,
  LeaseStore,
  LeaseStoreOptions,
  ProcessIdentity,
  ProcessInspector,
  ProcessStatus,
  RecoveryCause,
  RecoveryEvent,
  ReleaseForRecoveryInput,
  RetainedWorkContract,
  StaleSessionReconciliation,
  UninspectedWorkContract,
  WorkContractOwnerInput,
} from "./types.js";
