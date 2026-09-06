import { buildInterlockSnapshot, type InterlockSnapshot } from "../contracts/index.js";
import type { BeadsClient } from "../beads/index.js";
import type { LeaseReader } from "../core/index.js";

export interface SnapshotReadOptions {
  workspace: string;
  clock?: () => number;
}

export function readInterlockSnapshot(
  beads: BeadsClient,
  leaseReader: LeaseReader | undefined,
  beadId: string,
  options: SnapshotReadOptions,
): InterlockSnapshot {
  const issue = beads.getIssue(beadId);
  const lease = leaseReader?.getWorkContractByBeadId(beadId);
  return buildInterlockSnapshot(issue, lease, options);
}

export function readInterlockBoard(
  beads: BeadsClient,
  leaseReader: LeaseReader | undefined,
  options: SnapshotReadOptions,
): InterlockSnapshot[] {
  if (leaseReader === undefined) return [];
  return [...leaseReader.listWorkContracts()]
    .sort((left, right) => compareContractIds(left.workContractId, right.workContractId))
    .map((lease) => buildInterlockSnapshot(beads.getIssue(lease.owner.beadId), lease, options));
}

function compareContractIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
