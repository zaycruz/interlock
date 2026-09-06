import type { TaskExecution } from "./linked-types.js";
import { realpathSync } from "node:fs";
import type { BeadsClient } from "../beads/index.js";
import { interlockMetadata, interlockRecoveryMarker, type BeadsIssue, type InterlockMetadata } from "../contracts/index.js";
import { runVerificationChecks } from "../contracts/verification.js";
import { inspectProcess, DEFAULT_STALE_AFTER_MS, type LeaseStore, type LeaseState } from "../core/index.js";
import { readCoordinationState, withCoordinationLock, assertMemberToken } from "../coordination/state.js";
import type { CoordinationTask } from "../coordination/types.js";
import type { LeaseCommand } from "./lease-commands.js";
import { canonicalRepository } from "./linked-contract.js";
import { assertStagedPathsAreOwned } from "./staged-paths.js";

export function linkedTasks(repositoryPath: string): CoordinationTask[] {
  const tasks = readCoordinationState().tasks.filter((task) => task.contract !== undefined);
  if (tasks.length === 0) return [];
  const repositoryId = canonicalRepository(repositoryPath);
  return tasks.filter((task) => task.contract!.repositoryId === repositoryId);
}

export interface LinkedAuthority { pane: string; token: string; }

export function prepareLinkedOperation(command: Exclude<LeaseCommand, { name: "status" }>, beads: BeadsClient, store: LeaseStore, authority?: LinkedAuthority): void {
  const tasks = linkedTasks(command.repositoryPath);
  if (command.name === "reconcile") {
    prepareReconciliation(command.repositoryPath, tasks, beads, store, authority);
    return;
  }
  const task = tasks.find((candidate) => candidate.contract!.beadId === command.beadId);
  if (!task) return;
  assertLinkedAuthority(task, authority);
  if (command.name === "claim") {
    assertReservedClaim(task, command);
    if (beads.getIssue(command.beadId).acceptanceCriteria.trim() !== task.execution!.acceptance) throw new Error("Beads acceptance changed before claim");
    return;
  }
  const lease = validateExecutionLease(task, command, store);
  if (command.name === "complete") { verifyCompletion(task, beads); return; }
  if (command.name === "release") {
    prepareRelease(task, command.reason, lease);
  }
}

function assertReservedClaim(task: CoordinationTask, command: Extract<LeaseCommand, { name: "claim" }>): void {
  const execution = task.execution;
  if (!execution || execution.phase !== "claim-pending" || command.contractId !== execution.contractId) {
    throw new Error(`linked task ${task.id} requires its durable reservation; use task claim`);
  }
  if (execution.actor !== command.actor || execution.process.pid !== command.sessionPid || JSON.stringify(execution.paths) !== JSON.stringify(command.paths)) {
    throw new Error("claim does not match the linked execution reservation");
  }
}

function verifyCompletion(task: CoordinationTask, beads: BeadsClient): void {
  const execution = task.execution!;
  if (!execution.result) throw new Error(`linked task ${task.id} requires a result summary and artifact references; use task complete --result`);
  if (beads.getIssue(task.contract!.beadId).acceptanceCriteria.trim() !== execution.acceptance) throw new Error("Beads acceptance changed after claim; release and claim again after correcting the contract");
  assertStagedPathsAreOwned(execution.workspace, execution.paths);
  const verification = runVerificationChecks(execution.workspace, execution.checks);
  updateExecution(task, (current) => {
    current.verification = verification;
    if (verification.every((result) => result.passed)) current.phase = "completion-pending";
  });
  if (verification.some((result) => !result.passed)) throw new Error("required verification failed; inspect task resume for executed results");
}

function assertPendingCompletion(task: CoordinationTask, beads: BeadsClient, store: LeaseStore): void {
  if (!task.execution) return;
  const event = store.completionEvents().find((item) => item.workContractId === task.execution!.contractId);
  if (!event) return;
  const execution = task.execution;
  if (!execution.result || !execution.verification?.length || execution.verification.some((result) => !result.passed)) throw new Error("linked completion intent lacks verified evidence");
  if (beads.getIssue(task.contract!.beadId).acceptanceCriteria.trim() !== execution.acceptance) throw new Error("pending linked completion acceptance changed");
}

function updateExecution(task: CoordinationTask, change: (execution: NonNullable<CoordinationTask["execution"]>) => void): void {
  withCoordinationLock((state) => {
    const current = state.tasks.find((candidate) => candidate.id === task.id);
    if (!current?.execution || current.execution.contractId !== task.execution!.contractId) throw new Error("linked execution changed during operation");
    change(current.execution); current.revision += 1; current.lastProgressAt = new Date().toISOString();
  });
}

export function synchronizeLinkedTasks(repositoryPath: string, beads: BeadsClient, store: LeaseStore): void {
  for (const task of linkedTasks(repositoryPath)) synchronizeTask(task, beads, store);
}

function synchronizeTask(task: CoordinationTask, beads: BeadsClient, store: LeaseStore): void {
  const execution = task.execution;
  if (!execution || execution.phase === "done" || execution.phase === "released") return;
  const lease = store.getWorkContractByBeadId(task.contract!.beadId);
  if (synchronizeLiveLease(task, execution, lease)) return;
  if (store.recoveryEvents().some((event) => event.workContractId === execution.contractId)) return;
  if (store.completionEvents().some((event) => event.workContractId === execution.contractId)) return;
  const phase = observedTerminalPhase(execution, beads.getIssue(task.contract!.beadId));
  if (phase !== undefined) persistTerminalPhase(task, execution, phase);
}

function synchronizeLiveLease(task: CoordinationTask, execution: TaskExecution, lease: LeaseState | undefined): boolean {
  if (!lease) return false;
  if (lease.workContractId !== execution.contractId) throw new Error("linked execution differs from observed lease");
  if (lease.remoteConfirmed && !lease.completing && execution.phase === "claim-pending") {
    updateExecution(task, (current) => { current.phase = "active"; });
  }
  return true;
}

function observedTerminalPhase(execution: TaskExecution, issue: BeadsIssue): "done" | "released" | undefined {
  const metadata = issue.metadata && interlockMetadata(issue.metadata);
  if (issue.status === "closed" && metadata?.contractId === execution.contractId && execution.phase === "completion-pending") return "done";
  if (observedRelease(execution, issue, metadata)) return "released";
  return undefined;
}

function observedRelease(execution: TaskExecution, issue: BeadsIssue, metadata: InterlockMetadata | undefined): boolean {
  if (issue.status !== "open" || issue.assignee !== undefined) return false;
  const recovery = issue.metadata && interlockRecoveryMarker(issue.metadata);
  if (recovery?.contractId === execution.contractId) return true;
  return execution.phase === "claim-pending" && metadata === undefined && !issue.metadataMalformed;
}

function persistTerminalPhase(task: CoordinationTask, execution: TaskExecution, phase: "done" | "released"): void {
  const done = phase === "done";
  withCoordinationLock((state) => {
    const current = state.tasks.find((candidate) => candidate.id === task.id)!;
    if (current.execution?.contractId !== execution.contractId) throw new Error("linked execution changed before convergence");
    current.execution.phase = phase;
    current.stage = done ? "done" : "open";
    if (!done) current.claimer = null;
    current.blocker = null; current.revision += 1; current.lastProgressAt = new Date().toISOString();
  });
}


export function pendingLinkedOperations(repositoryPath: string, store: LeaseStore, authority?: LinkedAuthority): Array<Extract<LeaseCommand, { name: "complete" | "release" }>> {
  const pending: Array<Extract<LeaseCommand, { name: "complete" | "release" }>> = [];
  for (const task of linkedTasks(repositoryPath)) {
    const execution = task.execution;
    if (!execution || !canReconcileLinkedContract(repositoryPath, execution.contractId, authority)) continue;
    const lease = store.getWorkContract(execution.contractId);
    if (!lease?.remoteConfirmed || lease.completing) continue;
    const common = { beadId: task.contract!.beadId, repositoryPath: execution.workspace, expectedContractId: execution.contractId };
    if (execution.phase === "completion-pending") pending.push({ name: "complete", ...common });
    if (execution.phase === "release-pending") pending.push({ name: "release", reason: execution.releaseReason ?? "resume pending release", ...common });
  }
  return pending;
}


function assertLinkedAuthority(task: CoordinationTask, authority: LinkedAuthority | undefined): void {
  if (!authority) throw new Error(`linked task ${task.id} requires authenticated task commands`);
  assertMemberToken(readCoordinationState(), authority.pane, authority.token);
  if (task.claimer === authority.pane) return;
  const status = task.execution && inspectProcess(task.execution.process);
  if (status !== "dead" && status !== "mismatched") throw new Error("only the linked task owner or verified-dead recovery can mutate its execution");
}

function assertReconciliationAuthority(task: CoordinationTask, store: LeaseStore, authority: LinkedAuthority | undefined): void {
  if (!task.execution) return;
  const contractId = task.execution.contractId;
  const pending = store.completionEvents().some((event) => event.workContractId === contractId)
    || store.recoveryEvents().some((event) => event.workContractId === contractId);
  if (pending) {
    if (!authority) throw new Error(`linked task ${task.id} requires authenticated task commands`);
    assertMemberToken(readCoordinationState(), authority.pane, authority.token);
    return;
  }
  const lease = store.getWorkContract(contractId);
  if (!lease || Date.now() - lease.heartbeatAt <= DEFAULT_STALE_AFTER_MS) return;
  const status = inspectProcess(task.execution.process);
  if (status === "dead" || status === "mismatched") assertLinkedAuthority(task, authority);
}


export function canReconcileLinkedContract(repositoryPath: string, contractId: string, authority?: LinkedAuthority): boolean {
  const task = linkedTasks(repositoryPath).find((candidate) => candidate.execution?.contractId === contractId);
  if (!task) return true;
  if (!authority) return false;
  assertMemberToken(readCoordinationState(), authority.pane, authority.token);
  if (task.claimer === authority.pane) return true;
  const status = inspectProcess(task.execution!.process);
  return status === "dead" || status === "mismatched";
}


export function assertLinkedCompletionIssue(repositoryPath: string, contractId: string, issue: BeadsIssue): void {
  const task = linkedTasks(repositoryPath).find((candidate) => candidate.execution?.contractId === contractId);
  if (task && issue.acceptanceCriteria.trim() !== task.execution!.acceptance) throw new Error("Beads acceptance changed during verification; completion remains pending");
}

function prepareReconciliation(repositoryPath: string, tasks: CoordinationTask[], beads: BeadsClient, store: LeaseStore, authority?: LinkedAuthority): void {
  for (const task of tasks) {
    assertReconciliationAuthority(task, store, authority);
    if (canReconcileLinkedContract(repositoryPath, task.execution?.contractId ?? "", authority)) assertPendingCompletion(task, beads, store);
  }
}

function validateExecutionLease(task: CoordinationTask, command: Exclude<LeaseCommand, { name: "status" | "claim" | "reconcile" }>, store: LeaseStore): LeaseState | undefined {
  const execution = task.execution;
  if (!execution) throw new Error("linked task has no execution; use task claim");
  if (execution.phase === "done" || execution.phase === "released") throw new Error("linked execution is terminal");
  if (command.expectedContractId && command.expectedContractId !== execution.contractId) throw new Error("expected execution contract changed");
  if (realpathSync(command.repositoryPath) !== realpathSync(execution.workspace)) throw new Error("linked operation must use its claimed worktree");
  const lease = store.getWorkContractByBeadId(command.beadId);
  if (lease !== undefined && lease.workContractId !== execution.contractId) throw new Error("linked task contract differs from its local lease");
  return lease;
}

function prepareRelease(task: CoordinationTask, reason: string, lease: LeaseState | undefined): void {
  const execution = task.execution!;
  if (lease?.completing || (execution.phase === "completion-pending" && lease === undefined)) throw new Error("SQLite completion is pending or acknowledged; resolve it before release");
  updateExecution(task, (current) => { current.phase = "release-pending"; current.releaseReason = reason; });
}
