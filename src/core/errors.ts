import type { LeaseCollision, ProcessIdentity, ProcessStatus } from "./types.js";

export class UnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(`Interlock V1 supports macOS and Linux only; received ${platform}.`);
    this.name = "UnsupportedPlatformError";
  }
}

export class LeasePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeasePathError";
  }
}

export class LeaseCollisionError extends Error {
  readonly collisions: LeaseCollision[];

  constructor(collisions: LeaseCollision[]) {
    super(`Paths are leased: ${collisions.map((collision) => `${collision.path} (${collision.actor}, ${collision.beadId})`).join(", ")}`);
    this.name = "LeaseCollisionError";
    this.collisions = collisions;
  }
}

export class LeaseOwnershipError extends Error {
  constructor(workContractId: string) {
    super(`Work contract ${workContractId} is not owned by this session`);
    this.name = "LeaseOwnershipError";
  }
}

export class WorkContractExistsError extends Error {
  constructor(workContractId: string) {
    super(`Work contract ${workContractId} already exists`);
    this.name = "WorkContractExistsError";
  }
}

export class WorkContractNotFoundError extends Error {
  constructor(workContractId: string) {
    super(`Work contract ${workContractId} does not exist`);
    this.name = "WorkContractNotFoundError";
  }
}

export class LifecycleLockError extends Error {
  constructor(owner: ProcessIdentity, status: Exclude<ProcessStatus, "dead" | "mismatched">) {
    super(`Another Interlock lifecycle command holds the database lock (pid ${owner.pid}, started ${owner.startedAt}; inspection: ${status}). Wait for it to exit or inspect the stored process identity.`);
    this.name = "LifecycleLockError";
  }
}

export class LegacyLeaseDatabaseError extends Error {
  constructor(path: string) {
    super(`Existing Interlock lease database has a legacy or incomplete schema at ${path}. Finish or clear all old leases deliberately before initializing the new V1 database; Interlock will not migrate it automatically.`);
    this.name = "LegacyLeaseDatabaseError";
  }
}
