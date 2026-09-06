import { z } from "zod";
import { parseVerificationChecks } from "../contracts/verification.js";
import { normalizeLeasePaths } from "../core/paths.js";
import type { CoordinationMessage, CoordinationTask } from "./types.js";
import { validateTaskId, validatePaneName } from "./validation.js";

const text = z.string().trim().min(1);
const result = z.object({ source: z.literal("agent-declared"), summary: text, artifacts: z.array(text).min(1) }).strict();
const execution = z.object({
  contractId: text, process: z.object({ pid: z.number().int().positive(), startedAt: text }).strict(),
  actor: text, workspace: text, acceptance: text, checks: z.unknown(), paths: z.array(text).min(1),
  phase: z.enum(["claim-pending", "active", "completion-pending", "release-pending", "done", "released"]),
  claimedAt: text, result: result.optional(), verification: z.array(z.object({
    source: z.literal("interlock-executed"), criterion: text, command: z.array(text).min(1), passed: z.boolean(),
    exitCode: z.number().int().nullable(), signal: z.string().nullable(), output: z.string(), error: z.string().optional(), finishedAt: text,
  }).strict()).optional(), releaseReason: text.optional(),
}).strict();
const contract = z.object({ repositoryId: text, beadId: text, paths: z.array(text).min(1), checks: z.unknown() }).strict();
const taskSchema = z.object({
  id: text, title: text, businessValue: text, workspace: z.string().nullable(), ownerPane: z.string().nullable(),
  stage: z.enum(["open", "claimed", "in-progress", "blocked", "done", "closed"]), claimer: z.string().nullable(), blocker: z.string().nullable(),
  createdAt: text, lastProgressAt: text, revision: z.number().int().positive(), creator: text.optional(), result: result.optional(), contract: contract.optional(),
  execution: execution.optional(), executionHistory: z.array(execution).optional(), checkpoint: text.optional(), withdrawalReason: text.optional(),
}).strict();

export function coordinationTasks(value: unknown): CoordinationTask[] {
  const tasks = z.array(taskSchema).parse(value ?? []);
  const ids = new Set<string>();
  const links = new Set<string>();
  for (const candidate of tasks) {
    validateTaskId(candidate.id);
    if (ids.has(candidate.id)) throw new Error(`duplicate task ${candidate.id}`);
    ids.add(candidate.id);
    if (candidate.contract !== undefined) {
      const key = JSON.stringify([candidate.contract.repositoryId, candidate.contract.beadId]);
      if (links.has(key)) throw new Error("duplicate canonical task contract");
      links.add(key);
      candidate.contract.checks = parseVerificationChecks(candidate.contract.checks);
      candidate.contract.paths = normalizeLeasePaths(candidate.contract.paths);
    }
    for (const record of [...(candidate.executionHistory ?? []), ...(candidate.execution ? [candidate.execution] : [])]) {
      if (!candidate.contract) throw new Error("execution has no linked contract");
      record.checks = parseVerificationChecks(record.checks);
      record.paths = normalizeLeasePaths(record.paths);
      validatePaneName(record.actor);
    }
    assertExecutionState(candidate);
  }
  return tasks as CoordinationTask[];
}

export function coordinationMessages(value: unknown): CoordinationMessage[] {
  if (!Array.isArray(value)) return [];
  for (const message of value) {
    if (message.taskId !== undefined) validateTaskId(message.taskId);
    if (message.requestId !== undefined) text.parse(message.requestId);
    if (message.channelId !== undefined) z.number().int().positive().parse(message.channelId);
  }
  return structuredClone(value) as CoordinationMessage[];
}

export function parseTaskResult(value: unknown): import("../application/linked-types.js").TaskResult { return result.parse(value); }


function assertExecutionState(candidate: z.infer<typeof taskSchema>): void {
  const task = candidate;
  if (!task.execution) return;
  const execution = task.execution;
  if (execution.phase === "released") {
    if (task.claimer !== null || !["open", "closed"].includes(task.stage)) throw new Error("released execution retains task ownership");
    return;
  }
  if (task.claimer !== execution.actor) throw new Error("task owner differs from immutable execution actor");
  if (execution.phase === "done") {
    if (!["done", "closed"].includes(task.stage)) throw new Error("completed execution has nonterminal task state");
    return;
  }
  if (["open", "done", "closed"].includes(task.stage)) throw new Error("pending or active execution has invalid task stage");
}
