import type { BeadsClient } from "../beads/index.js";
import { interlockMetadata, type BeadsIssue, type InterlockMetadata } from "../contracts/index.js";
import { normalizeLeasePaths, type LeaseOwner, type LeaseState, type LeaseStore, type ProcessIdentity, type CompletionEvent } from "../core/index.js";

type SavedContract = Pick<CompletionEvent, "workContractId" | "owner" | "paths" | "heartbeatAt">;

export function isUnclaimedIssue(issue: BeadsIssue): boolean {
  return !issue.metadataMalformed && issue.metadata !== undefined && issue.status === "open" && issue.assignee === undefined
    && !Object.hasOwn(issue.metadata, "interlock");
}

function isActiveMatchingContract(issue: BeadsIssue, beadId: string, owner: LeaseOwner, metadata: InterlockMetadata): boolean {
  return issue.status === "in_progress" && sameContract(issue, beadId, owner, metadata.contractId, normalizedMetadataPaths(metadata), metadata);
}

export function isExactActiveContract(issue: BeadsIssue, beadId: string, owner: LeaseOwner, expected: InterlockMetadata): boolean {
  if (issue.metadataMalformed || issue.metadata === undefined) return false;
  const observed = interlockMetadata(issue.metadata);
  return observed !== undefined && isActiveMatchingContract(issue, beadId, owner, observed) && sameMetadata(observed, expected);
}

export function isExactClosedContract(issue: BeadsIssue, beadId: string, owner: LeaseOwner, expected: InterlockMetadata): boolean {
  if (issue.metadataMalformed || issue.metadata === undefined) return false;
  const observed = interlockMetadata(issue.metadata);
  return observed !== undefined && issue.status === "closed" && sameContract(issue, beadId, owner, expected.contractId, expected.paths, observed)
    && sameMetadata(observed, expected);
}

function sameContract(issue: BeadsIssue, beadId: string, owner: LeaseOwner, contractId: string, paths: string[], metadata: InterlockMetadata): boolean {
  const normalizedPaths = normalizedMetadataPaths(metadata);
  return issue.id === beadId && metadata.contractId === contractId && metadata.actor === owner.actor && metadata.session.pid === owner.process.pid
    && metadata.session.startedAt === owner.process.startedAt && issue.assignee === owner.actor
    && samePaths(metadata.paths, normalizedPaths) && samePaths(paths, normalizedPaths);
}

function sameMetadata(left: InterlockMetadata, right: InterlockMetadata): boolean {
  return left.contractId === right.contractId && left.actor === right.actor && left.session.pid === right.session.pid
    && left.session.startedAt === right.session.startedAt && samePaths(left.paths, right.paths)
    && left.leaseHealth.status === right.leaseHealth.status && left.leaseHealth.heartbeatAt === right.leaseHealth.heartbeatAt;
}

export function normalizedMetadataPaths(metadata: InterlockMetadata): string[] {
  try { return normalizeLeasePaths(metadata.paths); } catch { return []; }
}

export function preflightActiveContract(beads: BeadsClient, store: LeaseStore, beadId: string): { metadata: InterlockMetadata; owner: LeaseOwner; lease: LeaseState; issue: BeadsIssue } {
  const { issue, observed } = preflightRemoteActiveContract(beads, beadId);
  return { ...validatePreflightLease(store, beadId, issue, observed), issue };
}

export function preflightRemoteActiveContract(beads: BeadsClient, beadId: string): { issue: BeadsIssue; observed: InterlockMetadata } {
  const issue = beads.getIssue(beadId);
  const observed = issue.metadata === undefined ? undefined : interlockMetadata(issue.metadata);
  if (observed === undefined || !isActiveMatchingContract(issue, beadId, ownerFromMetadata(beadId, observed), observed)) {
    throw new Error(`Beads issue ${beadId} is not an active matching Interlock contract; local and Beads state were not changed`);
  }
  return { issue, observed };
}

export function validatePreflightLease(store: LeaseStore, beadId: string, issue: BeadsIssue, observed: InterlockMetadata): { metadata: InterlockMetadata; owner: LeaseOwner; lease: LeaseState } {
  const lease = store.getWorkContract(observed.contractId);
  if (lease === undefined) throw new Error(`Interlock work contract ${observed.contractId} does not exist locally`);
  if (!lease.remoteConfirmed) throw new Error(`Interlock work contract ${observed.contractId} is not remotely confirmed`);
  if (lease.completing) throw new Error(`Interlock work contract ${observed.contractId} is already completing`);
  const expected = metadataFor(lease.workContractId, lease.owner.actor, lease.owner.process, lease.paths, lease.heartbeatAt);
  if (!isExactActiveContract(issue, beadId, lease.owner, expected)) {
    throw new Error(`Interlock work contract ${observed.contractId} does not exactly match its confirmed local lease metadata; local/Beads drift detected and local and Beads state were not changed`);
  }
  return { metadata: expected, owner: lease.owner, lease };
}

export function metadataForEvent(event: SavedContract): InterlockMetadata {
  return metadataFor(event.workContractId, event.owner.actor, event.owner.process, event.paths, event.heartbeatAt);
}

export function ownerFromMetadata(beadId: string, metadata: InterlockMetadata): LeaseOwner { return { actor: metadata.actor, beadId, process: metadata.session }; }

export function metadataFor(contractId: string, actor: string, session: ProcessIdentity, paths: string[], heartbeatAt: number): InterlockMetadata {
  return { contractId, actor, session: { pid: session.pid, startedAt: session.startedAt }, paths: [...paths], leaseHealth: { status: "fresh", heartbeatAt } };
}

export function sameOwner(left: LeaseOwner, right: LeaseOwner): boolean {
  return left.actor === right.actor && left.beadId === right.beadId && left.process.pid === right.process.pid && left.process.startedAt === right.process.startedAt;
}

export function samePaths(left: string[], right: string[]): boolean { return left.length === right.length && left.every((path, index) => path === right[index]); }

export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
