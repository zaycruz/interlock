import { prepareLinkedOperation, synchronizeLinkedTasks, pendingLinkedOperations, canReconcileLinkedContract, linkedTasks, assertLinkedCompletionIssue, type LinkedAuthority } from "./linked-policy.js";
import { randomUUID } from "node:crypto";
import { ChildProcessBeadsClient, type BeadsClient } from "../beads/index.js";
import { validateIssue, interlockRecoveryMarker, type BeadsIssue, type InterlockRecoveryMarker } from "../contracts/index.js";
import { currentProcessIdentity, openLeaseStore, openLeaseReader, sessionProcessIdentityFor, type LeaseStore, type LeaseReader, type ProcessIdentity, type CompletionEvent, type RecoveryEvent } from "../core/index.js";
import { assertStagedPathsAreOwned } from "./staged-paths.js";
import { status, snapshot, board } from "./status.js";
import { isUnclaimedIssue, isExactActiveContract, isExactClosedContract, metadataFor, metadataForEvent, preflightActiveContract, preflightRemoteActiveContract, validatePreflightLease, message } from "./contract-validation.js";

export interface LeaseDependencies {
  linkedAuthority?: LinkedAuthority;
  beads?: BeadsClient;
  openLeaseStore?: (repositoryPath: string) => LeaseStore;
  openLeaseReader?: (repositoryPath: string) => LeaseReader;
  processIdentityFor?: (pid: number) => ProcessIdentity;
  lifecycleProcessor?: () => ProcessIdentity;
  clock?: () => number;
}

export type LeaseCommand = (
  | { name: "claim"; contractId?: string; beadId: string; actor: string; sessionPid: number; paths: string[]; repositoryPath: string }
  | { name: "status"; all: false; beadId: string; repositoryPath: string; json: boolean }
  | { name: "status"; all: true; beadId: undefined; repositoryPath: string; json: true }
  | { name: "heartbeat"; beadId: string; repositoryPath: string }
  | { name: "complete"; beadId: string; repositoryPath: string }
  | { name: "release"; beadId: string; reason: string; repositoryPath: string }
  | { name: "resolve"; beadId: string; repositoryPath: string }
  | { name: "reconcile"; repositoryPath: string }) & { expectedContractId?: string };

export function runLeaseCommand(command: LeaseCommand, dependencies: LeaseDependencies = {}): string {
  const beads = dependencies.beads ?? new ChildProcessBeadsClient(command.repositoryPath);
  const storeFactory = dependencies.openLeaseStore ?? openLeaseStore;
  const readerFactory = dependencies.openLeaseReader ?? openLeaseReader;
  const identityFor = dependencies.processIdentityFor ?? sessionProcessIdentityFor;
  if (command.name === "status") {
    return readLeaseStatus(command, beads, readerFactory, dependencies.clock);
  }
  const processor = (dependencies.lifecycleProcessor ?? currentProcessIdentity)();
  if (command.name === "heartbeat") return heartbeat(command, beads, storeFactory, processor, dependencies.linkedAuthority);
  return withLifecycleLock(command.repositoryPath, storeFactory, processor, (store) => executeMutating(command, beads, store, identityFor, dependencies.linkedAuthority));
}

export function withLifecycleLock<T>(repositoryPath: string, storeFactory: (repositoryPath: string) => LeaseStore, processor: ProcessIdentity,
  operation: (store: LeaseStore) => T): T {
  const store = storeFactory(repositoryPath);
  let locked = false;
  try {
    store.acquireLifecycleLock(processor);
    locked = true;
    return operation(store);
  } finally {
    try {
      if (locked) store.releaseLifecycleLock(processor);
    } finally {
      store.close();
    }
  }
}

function executeMutating(command: Exclude<LeaseCommand, { name: "status" } | { name: "heartbeat" }>, beads: BeadsClient, store: LeaseStore,
  identityFor: (pid: number) => ProcessIdentity, authority?: LinkedAuthority): string {
  prepareLinkedOperation(command, beads, store, authority);
  try {
    if (command.name === "reconcile") {
      for (const pending of pendingLinkedOperations(command.repositoryPath, store, authority)) {
        prepareLinkedOperation(pending, beads, store, authority);
        dispatchMutation(pending, beads, store, identityFor, authority);
      }
    }
    return dispatchMutation(command, beads, store, identityFor, authority);
  } finally {
    synchronizeLinkedTasks(command.repositoryPath, beads, store);
  }
}

function dispatchMutation(command: Exclude<LeaseCommand, { name: "status" } | { name: "heartbeat" }>, beads: BeadsClient, store: LeaseStore, identityFor: (pid: number) => ProcessIdentity, authority?: LinkedAuthority): string {
  switch (command.name) {
    case "claim": return claim(command, beads, store, identityFor, authority);
    case "complete": return complete(command, beads, store);
    case "release": return release(command, beads, store, authority);
    case "resolve": return resolveClaim(command, beads, store);
    case "reconcile": return reconcile(beads, store, command.repositoryPath, authority);
  }
}

function claim(command: Extract<LeaseCommand, { name: "claim" }>, beads: BeadsClient, store: LeaseStore,
  identityFor: (pid: number) => ProcessIdentity, authority?: LinkedAuthority): string {
  const observedIssue = beads.getIssue(command.beadId);
  const validatedIssue = validateIssue(observedIssue);
  if (!isUnclaimedIssue(observedIssue)) {
    throw new Error(`Beads issue ${command.beadId} is not an unassigned open issue without Interlock metadata; local and Beads state were not changed`);
  }
  reconcileLifecycle(store, beads, command.repositoryPath, authority);
  const owner = { actor: command.actor, beadId: command.beadId, process: identityFor(command.sessionPid) };
  const contractId = command.contractId ?? randomUUID();
  const lease = store.acquire({ workContractId: contractId, owner, paths: command.paths });
  const metadata = metadataFor(contractId, owner.actor, owner.process, lease.paths, lease.heartbeatAt);
  store.markRemoteAttempted({ workContractId: contractId, owner });
  try {
    beads.claim(command.beadId, command.actor, metadata);
  } catch (error) {
    throw new Error(`Beads claim outcome is ambiguous for ${command.beadId}. The attempted local contract and its paths remain reserved because the remote update may have succeeded: ${message(error)}. Inspect Beads and correct local/remote drift deliberately.`);
  }
  let remote: BeadsIssue;
  try {
    remote = beads.getIssue(command.beadId);
  } catch (error) {
    throw new Error(`Beads claim for ${command.beadId} returned successfully, but its result could not be read. The attempted local contract and its paths remain reserved: ${message(error)}. Inspect Beads and correct local/remote drift deliberately.`);
  }
  if (!isExactActiveContract(remote, command.beadId, owner, metadata)) {
    throw new Error(`Beads claim for ${command.beadId} did not produce the exact active Interlock contract. The attempted local contract remains reserved; inspect and correct local/remote drift deliberately.`);
  }
  try {
    store.confirmRemote({ workContractId: contractId, owner });
  } catch (error) {
    throw new Error(`Beads claim succeeded for ${command.beadId}, but SQLite remote confirmation failed: ${message(error)}. Remote/local drift requires operator intervention; Interlock will never auto-recover this Bead.`);
  }
  return `Claimed ${validatedIssue.issue.id} with ${lease.paths.length} exact path lease(s).`;
}

function heartbeat(command: Extract<LeaseCommand, { name: "heartbeat" }>, beads: BeadsClient,
  storeFactory: (repositoryPath: string) => LeaseStore, processor: ProcessIdentity, authority?: LinkedAuthority): string {
  const { issue, observed } = preflightRemoteActiveContract(beads, command.beadId);
  const renewed = withLifecycleLock(command.repositoryPath, storeFactory, processor, (store) => {
    prepareLinkedOperation(command, beads, store, authority);
    const { metadata, owner } = validatePreflightLease(store, command.beadId, issue, observed);
    const updatedLease = store.heartbeat({ workContractId: metadata.contractId, owner });
    const nextMetadata = metadataFor(metadata.contractId, metadata.actor, metadata.session, updatedLease.paths, updatedLease.heartbeatAt);
    // The Beads write stays inside the lock: a lock-free write could land after a concurrent
    // release/reconcile recovered the bead and re-wedge its cleared Interlock metadata.
    try { beads.heartbeat(command.beadId, nextMetadata); } catch (error) {
      throw new Error(`Local heartbeat succeeded for ${command.beadId} at ${new Date(updatedLease.heartbeatAt).toISOString()}, but Beads metadata sync failed: ${message(error)}. Retry interlock heartbeat ${command.beadId}.`);
    }
    return { owner, nextMetadata, heartbeatAt: updatedLease.heartbeatAt };
  });
  try {
    const remote = beads.getIssue(command.beadId);
    if (!isExactActiveContract(remote, command.beadId, renewed.owner, renewed.nextMetadata)) throw new Error("Beads returned a different active contract or metadata");
  } catch (error) {
    throw new Error(`Local heartbeat succeeded for ${command.beadId} at ${new Date(renewed.heartbeatAt).toISOString()}, but exact Beads verification failed: ${message(error)}. The renewed local lease remains reserved; inspect Beads and retry interlock heartbeat ${command.beadId}.`);
  }
  return `Heartbeated ${command.beadId}: local lease and Beads metadata are synchronized.`;
}

function complete(command: Extract<LeaseCommand, { name: "complete" }>, beads: BeadsClient, store: LeaseStore): string {
  const { metadata, owner, lease, issue } = preflightActiveContract(beads, store, command.beadId);
  assertStagedPathsAreOwned(command.repositoryPath, lease.paths);
  assertLinkedCompletionIssue(command.repositoryPath, metadata.contractId, issue);
  const event = store.beginCompletion({ workContractId: metadata.contractId, owner });
  try {
    beads.close(command.beadId);
  } catch (error) {
    throw new Error(`Completion for ${command.beadId} is pending. The durable completion intent remains because Beads close may have succeeded: ${message(error)}. Run interlock reconcile; it will retry Beads close when the exact active contract remains.`);
  }
  try {
    const remote = beads.getIssue(command.beadId);
    if (!isExactClosedContract(remote, command.beadId, owner, metadataForEvent(event))) throw new Error("Beads returned a different closed contract or metadata");
  } catch (error) {
    throw new Error(`Completion for ${command.beadId} is pending. Beads close returned successfully, but exact closed-contract verification failed: ${message(error)}. The durable completion intent remains; inspect Beads and run interlock reconcile.`);
  }
  try { store.acknowledgeCompletion(event.id); } catch (error) {
    throw new Error(`Beads issue ${command.beadId} closed, but local completion acknowledgement failed: ${message(error)}. Run interlock reconcile; it will only release the exact closed contract.`);
  }
  return `Completed ${command.beadId} and released its Interlock lease.`;
}

function release(command: Extract<LeaseCommand, { name: "release" }>, beads: BeadsClient, store: LeaseStore, authority?: LinkedAuthority): string {
  const { metadata, owner } = preflightActiveContract(beads, store, command.beadId);
  store.releaseForRecovery({ workContractId: metadata.contractId, owner, reason: command.reason });
  try { reconcileLifecycle(store, beads, command.repositoryPath, authority, authority === undefined); } catch (error) { throw pendingRecoveryError(command.beadId, error); }
  return `Released ${command.beadId}, reopened it, and cleared its Interlock assignment.`;
}

function resolveClaim(command: Extract<LeaseCommand, { name: "resolve" }>, beads: BeadsClient, store: LeaseStore): string {
  const lease = store.getWorkContractByBeadId(command.beadId);
  if (lease === undefined) return resolveMissingClaim(command, beads, store);
  if (lease.remoteConfirmed && command.expectedContractId === lease.workContractId) {
    preflightActiveContract(beads, store, command.beadId);
    return `Resolved ${command.beadId}: the exact local and Beads contract is already confirmed.`;
  }
  if (lease.remoteConfirmed) {
    throw new Error(`Interlock work contract ${lease.workContractId} for ${command.beadId} is already remotely confirmed; use interlock heartbeat, complete, or release`);
  }
  if (!lease.remoteAttempted) {
    store.release({ workContractId: lease.workContractId, owner: lease.owner });
    return `Resolved ${command.beadId}: the claim never reached Beads, so the unattempted local contract was cleared. The bead can be claimed again.`;
  }
  let remote: BeadsIssue;
  try {
    remote = beads.getIssue(command.beadId);
  } catch (error) {
    throw new Error(`Cannot resolve the ambiguous claim for ${command.beadId}: Beads state could not be read: ${message(error)}. The attempted local contract ${lease.workContractId} remains reserved. Manual step: run \`bd show ${command.beadId}\` once Beads is reachable, decide whether the claim landed, then rerun interlock resolve ${command.beadId}.`);
  }
  const expected = metadataFor(lease.workContractId, lease.owner.actor, lease.owner.process, lease.paths, lease.heartbeatAt);
  if (isExactActiveContract(remote, command.beadId, lease.owner, expected)) {
    store.confirmRemote({ workContractId: lease.workContractId, owner: lease.owner });
    return `Resolved ${command.beadId}: the Beads claim landed, so the local contract was confirmed.`;
  }
  if (isUnclaimedIssue(remote)) {
    store.release({ workContractId: lease.workContractId, owner: lease.owner });
    return `Resolved ${command.beadId}: the Beads claim did not land, so the attempted local contract was cleared. The bead can be claimed again.`;
  }
  throw new Error(`Cannot resolve the ambiguous claim for ${command.beadId}: Beads state matches neither an unclaimed issue nor the exact attempted contract ${lease.workContractId}. The attempted local contract remains reserved. Manual step: run \`bd show ${command.beadId}\`; if the claim did not land, clear its assignee and interlock metadata in Beads and rerun interlock resolve ${command.beadId}; if it landed under different metadata, correct the Beads metadata to match the local contract and rerun.`);
}

function reconcile(beads: BeadsClient, store: LeaseStore, repositoryPath: string, authority?: LinkedAuthority): string {
  const processed = reconcileLifecycle(store, beads, repositoryPath, authority, authority === undefined);
  return processed === 0 ? "Reconciliation found no pending lifecycle events." : `Reconciled ${processed} lifecycle event(s).`;
}

function reconcileLifecycle(store: LeaseStore, beads: BeadsClient, repositoryPath: string, authority?: LinkedAuthority, requireClean = true): number {
  prepareLinkedOperation({ name: "reconcile", repositoryPath }, beads, store, authority);
  store.reconcileStaleSessions();
  let processed = 0;
  const failures: string[] = [];
  processed += reconcileCompletions(store, beads, repositoryPath, failures, authority);
  for (const event of store.recoveryEvents()) {
    if (!canReconcileLinkedContract(repositoryPath, event.workContractId, authority)) continue;
    try {
      recoverBead(beads, event);
      store.acknowledgeRecovery(event.id);
      processed += 1;
    } catch (error) {
      failures.push(`recovery ${event.owner.beadId}: ${message(error)}`);
    }
  }
  if (failures.length > 0 || (requireClean && store.hasPendingLifecycleWork())) {
    throw new Error(`Lifecycle recovery remains pending: ${failures.join("; ") || "an event was retained"}. Inspect Beads and local state. Do not claim new work until reconciliation succeeds.`);
  }
  return processed;
}

function recoverCompletedContract(beads: BeadsClient, event: CompletionEvent): void {
  const issue = beads.getIssue(event.owner.beadId);
  const expected = metadataForEvent(event);
  if (isExactClosedContract(issue, event.owner.beadId, event.owner, expected)) return;
  if (!isExactActiveContract(issue, event.owner.beadId, event.owner, expected)) {
    throw new Error(`observed Beads state is not the exact active or closed completion contract ${event.workContractId}; manual review is required`);
  }
  beads.close(event.owner.beadId);
  const closed = beads.getIssue(event.owner.beadId);
  if (!isExactClosedContract(closed, event.owner.beadId, event.owner, expected)) {
    throw new Error(`Beads close retry for completion event ${event.id} did not produce the exact closed contract; the event remains pending`);
  }
}

function recoverBead(beads: BeadsClient, event: RecoveryEvent): void {
  const issue = beads.getIssue(event.owner.beadId);
  const marker: InterlockRecoveryMarker = { eventId: event.id, contractId: event.workContractId };
  if (hasRecoveryResult(issue, event.owner.beadId, marker)) return;
  if (!isActiveMatchingRecovery(issue, event)) {
    throw new Error(`observed Beads state does not match recovery event ${event.id}; manual review is required`);
  }
  beads.recover(event.owner.beadId, marker);
  if (!hasRecoveryResult(beads.getIssue(event.owner.beadId), event.owner.beadId, marker)) {
    throw new Error(`Beads recovery for event ${event.id} did not produce the exact acknowledged state; the event remains pending`);
  }
}

function hasRecoveryResult(issue: BeadsIssue, beadId: string, marker: InterlockRecoveryMarker): boolean {
  if (issue.metadataMalformed || issue.metadata === undefined) return false;
  const observed = interlockRecoveryMarker(issue.metadata);
  return issue.id === beadId && issue.status === "open" && issue.assignee === undefined && !Object.hasOwn(issue.metadata, "interlock")
    && observed?.eventId === marker.eventId && observed.contractId === marker.contractId;
}

function isActiveMatchingRecovery(issue: BeadsIssue, event: RecoveryEvent): boolean {
  return isExactActiveContract(issue, event.owner.beadId, event.owner, metadataForEvent(event));
}

function pendingRecoveryError(beadId: string, error: unknown): Error {
  return new Error(`Beads recovery remains pending for ${beadId}: ${message(error)}. Corrective action: inspect the Beads issue and Interlock lifecycle event, then run interlock reconcile. Do not claim new work until reconciliation succeeds.`);
}

function readLeaseStatus(command: Extract<LeaseCommand, { name: "status" }>, beads: BeadsClient, readerFactory: (repositoryPath: string) => LeaseReader, clock: (() => number) | undefined): string {
  return command.all
    ? board(command, beads, readerFactory, clock)
    : command.json ? snapshot(command, beads, readerFactory, clock) : status(command, beads, readerFactory, clock);
}

function resolveMissingClaim(command: Extract<LeaseCommand, { name: "resolve" }>, beads: BeadsClient, store: LeaseStore): string {
  if (command.expectedContractId) {
    synchronizeLinkedTasks(command.repositoryPath, beads, store);
    const linked = linkedTasks(command.repositoryPath).find((task) => task.execution?.contractId === command.expectedContractId);
    if (linked?.execution?.phase === "released") return `Resolved ${command.beadId}: the reserved claim had no local lease or remote effect.`;
  }
  throw new Error(`No local Interlock work contract exists for ${command.beadId}; nothing to resolve`);
}

function reconcileCompletions(store: LeaseStore, beads: BeadsClient, repositoryPath: string, failures: string[], authority?: LinkedAuthority): number {
  let processed = 0;
  for (const event of store.completionEvents()) {
    if (!canReconcileLinkedContract(repositoryPath, event.workContractId, authority)) continue;
    try {
      recoverCompletedContract(beads, event);
      store.acknowledgeCompletion(event.id);
      processed += 1;
    } catch (error) {
      failures.push(`completion ${event.owner.beadId}: ${message(error)}`);
    }
  }
  return processed;
}
