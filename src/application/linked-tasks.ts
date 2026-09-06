import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ChildProcessBeadsClient } from "../beads/index.js";
import { validateIssue } from "../contracts/index.js";
import { inspectProcess, sessionProcessIdentityFor, openLeaseReader } from "../core/index.js";
import { assertMemberToken, readCoordinationState, withCoordinationLock } from "../coordination/state.js";
import { assertNotDoneLeader } from "../coordination/pods.js";
import { parseTaskResult } from "../coordination/task-schema.js";
import type { CoordinationTask } from "../coordination/types.js";
import { assertAcceptanceCoverage, canonicalRepository } from "./linked-contract.js";
import { runLeaseCommand, type LeaseDependencies } from "./lease-commands.js";

export interface LinkedTaskRequest {
  operation: "claim" | "complete" | "release" | "resolve" | "recover" | "heartbeat";
  id: string;
  pane: string;
  token: string;
  sessionPid?: number;
  expectedContractId?: string;
  reason?: string;
  result?: unknown;
}

export function runLinkedTask(request: LinkedTaskRequest, dependencies: LeaseDependencies = {}): CoordinationTask {
  dependencies = { ...dependencies, linkedAuthority: { pane: request.pane, token: request.token } };
  const task = readAuthorizedTask(request);
  if (request.operation === "claim") return claimLinkedTask(request, task, dependencies);
  assertExecutionIdentity(request, task);
  if (isTerminalResolution(request, task)) return task;
  authorizeExecutionAction(request, task);
  executeTaskAction({ ...request, operation: request.operation }, task, dependencies);
  return readCoordinationState().tasks.find((candidate) => candidate.id === task.id)!;
}

function claimLinkedTask(request: LinkedTaskRequest, task: CoordinationTask, dependencies: LeaseDependencies): CoordinationTask {
  if (!Number.isSafeInteger(request.sessionPid) || request.sessionPid! <= 0) throw new Error("linked claim requires --session-pid");
  const processIdentity = (dependencies.processIdentityFor ?? sessionProcessIdentityFor)(request.sessionPid!);
  const workspace = resolve(task.workspace!);
  if (canonicalRepository(workspace) !== task.contract!.repositoryId) throw new Error("task workspace no longer belongs to its canonical repository");
  const beads = dependencies.beads ?? new ChildProcessBeadsClient(workspace);
  const issue = validateIssue(beads.getIssue(task.contract!.beadId));
  assertAcceptanceCoverage(issue.acceptanceCriteria, task.contract!.checks);
  const contractId = randomUUID();
  withCoordinationLock((state) => {
    assertMemberToken(state, request.pane, request.token);
    const current = state.tasks.find((candidate) => candidate.id === task.id)!;
    if (current.stage !== "open" || current.claimer !== null || current.revision !== task.revision) throw new Error("claim_conflict: task changed or is already owned");
    if (current.execution && current.execution.phase !== "released") throw new Error("previous execution is unresolved");
    if (current.execution) (current.executionHistory ??= []).push(current.execution);
    current.execution = { contractId, process: processIdentity, actor: request.pane, workspace, acceptance: issue.acceptanceCriteria,
      checks: structuredClone(current.contract!.checks), paths: [...current.contract!.paths], phase: "claim-pending", claimedAt: new Date().toISOString() };
    current.title = issue.issue.title; current.businessValue = issue.value;
    current.claimer = request.pane; current.stage = "claimed"; current.revision += 1; current.lastProgressAt = new Date().toISOString();
  });
  runLeaseCommand({ name: "claim", beadId: task.contract!.beadId, actor: request.pane, sessionPid: request.sessionPid!,
    paths: task.contract!.paths, repositoryPath: workspace, contractId }, { ...dependencies, beads, processIdentityFor: () => processIdentity });
  return readCoordinationState().tasks.find((candidate) => candidate.id === task.id)!;
}

function saveResult(request: LinkedTaskRequest, task: CoordinationTask): void {
  const value = request.result;
  const result = parseTaskResult(typeof value === "object" && value !== null ? { ...value, source: "agent-declared" } : value);
  withCoordinationLock((state) => {
    assertMemberToken(state, request.pane, request.token);
    const current = state.tasks.find((candidate) => candidate.id === task.id)!;
    if (current.claimer !== request.pane || current.execution?.contractId !== task.execution!.contractId) throw new Error("task execution changed");
    if (current.execution.phase !== "active") throw new Error("task execution is not active; resolve its pending operation first");
    current.execution.result = result; current.revision += 1;
  });
}

function assertVerifiedDead(task: CoordinationTask): void {
  const status = inspectProcess(task.execution!.process);
  if (status !== "dead" && status !== "mismatched") throw new Error(`execution death is not verified (${status}); ownership remains reserved`);
}

function releaseLinkedTask(task: CoordinationTask, reason: string, dependencies: LeaseDependencies): void {
  const command = { beadId: task.contract!.beadId, repositoryPath: task.execution!.workspace, expectedContractId: task.execution!.contractId };
  if (task.execution!.phase === "claim-pending") {
    runLeaseCommand({ name: "resolve", ...command }, dependencies);
    const current = readCoordinationState().tasks.find((candidate) => candidate.id === task.id)!;
    if (current.execution!.phase === "released") return;
  }
  if (task.execution!.phase === "release-pending" || (task.execution!.phase === "completion-pending" && hasCompletionEvent(task, dependencies))) {
    runLeaseCommand({ name: "reconcile", repositoryPath: command.repositoryPath }, dependencies); return;
  }
  runLeaseCommand({ name: "release", reason, ...command }, dependencies);
}


function hasCompletionEvent(task: CoordinationTask, dependencies: LeaseDependencies): boolean {
  const reader = (dependencies.openLeaseReader ?? openLeaseReader)(task.execution!.workspace);
  try {
    const lease = reader.getWorkContractByBeadId(task.contract!.beadId);
    return lease === undefined || lease.completing;
  }
  finally { reader.close(); }
}

function readAuthorizedTask(request: LinkedTaskRequest): CoordinationTask {
  const state = readCoordinationState();
  assertMemberToken(state, request.pane, request.token);
  assertNotDoneLeader(state, request.pane, `task ${request.operation}`);
  const task = state.tasks.find((candidate) => candidate.id === request.id);
  if (!task?.contract || !task.workspace) throw new Error("task has no linked execution contract");
  return task;
}

function assertExecutionIdentity(request: LinkedTaskRequest, task: CoordinationTask): void {
  if (!task.execution) throw new Error("task has no execution to operate on");
  if (request.expectedContractId && request.expectedContractId !== task.execution.contractId) throw new Error("expected execution contract changed");
}

function isTerminalResolution(request: LinkedTaskRequest, task: CoordinationTask): boolean {
  if (task.execution!.phase === "done" || task.execution!.phase === "released") {
    if (request.operation === "resolve") return true;
    throw new Error("task execution is terminal; ownership and evidence are unchanged");
  }
  return false;
}

function authorizeExecutionAction(request: LinkedTaskRequest, task: CoordinationTask): void {
  if (request.operation !== "recover" && task.claimer !== request.pane) throw new Error("only the task owner can operate on its execution");
  if (request.operation === "recover") assertVerifiedDead(task);
  if (request.operation === "release" && !request.reason?.trim()) throw new Error("task release requires a reason");
}

type ExistingTaskRequest = Omit<LinkedTaskRequest, "operation"> & { operation: Exclude<LinkedTaskRequest["operation"], "claim"> };
function executeTaskAction(request: ExistingTaskRequest, task: CoordinationTask, dependencies: LeaseDependencies): void {
  if (request.operation === "complete") saveResult(request, task);
  const common = { beadId: task.contract!.beadId, repositoryPath: task.execution!.workspace, expectedContractId: task.execution!.contractId };
  if (request.operation === "release" || request.operation === "recover") {
    releaseLinkedTask(task, request.reason ?? "verified-dead execution", dependencies);
  } else if (request.operation === "resolve" && ["completion-pending", "release-pending"].includes(task.execution!.phase)) {
    runLeaseCommand({ name: "reconcile", repositoryPath: common.repositoryPath }, dependencies);
  } else {
    runLeaseCommand({ name: request.operation, ...common }, dependencies);
  }
}
