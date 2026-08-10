import type { LeaseCollision } from "./types.js";

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
