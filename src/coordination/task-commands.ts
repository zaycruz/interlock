import { parseTaskResult } from "./task-schema.js";
import type { TaskResult } from "../application/linked-types.js";
import { runLinkedTask } from "../application/linked-tasks.js";
import { createLinkedTask } from "../application/linked-create.js";
import { inspectTasks, editTask } from "./task-edit.js";
import { has, optional, parseArgs, required, requiredToken } from "./args.js";
import { deliverDigests } from "./digest.js";
import { assertNotDoneLeader, assertTaskStageTransition } from "./pods.js";
import { assertMemberToken, readCoordinationState, withCoordinationLock } from "./state.js";
import type { CoordinationState, CoordinationTask, TaskStage } from "./types.js";
import { validatePaneName, validateTaskId } from "./validation.js";

const TASK_STAGES: TaskStage[] = ["open", "claimed", "in-progress", "blocked", "done", "closed"];
type ParsedArgs = Map<string, string | true>;

export function taskCommand(argv: string[]): string {
  const subcommand = argv[0];
  const parsed = parseArgs(argv.slice(1));
  if (subcommand === "add") return addTask(parsed);
  if (subcommand === "list") return listTasks(parsed);
  if (subcommand === "resume" && (!argv[1] || argv[1].startsWith("--"))) return inspectTasks(undefined, validatePaneName(required(parsed, "pane")), requiredToken(parsed), true);
  return identifiedTaskCommand(argv, parsed);
}

function identifiedTaskCommand(argv: string[], parsed: ParsedArgs): string {
  const subcommand = argv[0];
  const id = validateTaskId(argv[1] ?? "");
  if (!id) throw new Error(`task ${subcommand ?? ""} requires an id`);
  const pane = validatePaneName(required(parsed, "pane"));
  const token = requiredToken(parsed);
  if (subcommand === "inspect" || subcommand === "resume") return inspectTasks(id, pane, token, subcommand === "resume");
  if (["update", "withdraw", "checkpoint", "block"].includes(subcommand ?? "")) return editTask(subcommand!, id, pane, token, parsed);
  return taskExecutionCommand(argv, parsed, id, pane, token);
}

function taskExecutionCommand(argv: string[], parsed: ParsedArgs, id: string, pane: string, token: string): string {
  const subcommand = argv[0];
  const linked = readCoordinationState().tasks.find((task) => task.id === id)?.contract !== undefined;
  if (linked && ["claim", "complete", "release", "resolve", "recover", "heartbeat"].includes(subcommand ?? "")) {
    return linkedExecutionCommand(subcommand!, parsed, id, pane, token);
  }
  return coordinationTaskCommand(argv, parsed, id, pane, token);
}

function linkedExecutionCommand(subcommand: string, parsed: ParsedArgs, id: string, pane: string, token: string): string {
  const result = optional(parsed, "result");
  const task = runLinkedTask({ operation: subcommand as "claim" | "complete" | "release" | "resolve" | "recover" | "heartbeat", id, pane, token,
    sessionPid: Number(optional(parsed, "session-pid")), expectedContractId: optional(parsed, "contract-id") ?? undefined, reason: optional(parsed, "reason") ?? undefined, result: result === null ? undefined : JSON.parse(result) });
  return JSON.stringify({ ok: true, task });
}

function coordinationTaskCommand(argv: string[], parsed: ParsedArgs, id: string, pane: string, token: string): string {
  const subcommand = argv[0];
  if (subcommand === "release" && !has(parsed, "dead-claimer")) return releaseOwnedTask(id, pane, token);
  if (subcommand === "complete") {
    const input = optional(parsed, "result");
    const result = input === null ? undefined : parseTaskResult({ ...JSON.parse(input), source: "agent-declared" });
    return stageTask(["stage", id, "done"], id, pane, token, result);
  }
  if (subcommand === "reap" || subcommand === "release") return reapTask(parsed, id, pane, token);
  if (subcommand === "claim") return claimTask(id, pane, token);
  if (subcommand === "progress") return progressTask(id, pane, token);
  if (subcommand === "stage") return stageTask(argv, id, pane, token);
  throw new Error(`unknown task command: ${subcommand}`);
}

function addTask(parsed: ParsedArgs): string {
  const id = validateTaskId(required(parsed, "id"));
  const pane = validatePaneName(required(parsed, "pane"));
  const token = requiredToken(parsed);
  const contract = optional(parsed, "contract");
  if (contract !== null) {
    const ownerPane = optional(parsed, "owner-pane");
    if (ownerPane !== null) validatePaneName(ownerPane, "owner pane");
    const task = createLinkedTask({ id, pane, token, workspace: required(parsed, "workspace"), ownerPane }, JSON.parse(contract));
    return JSON.stringify({ ok: true, task });
  }
  const task = withCoordinationLock((state) => {
    assertMemberToken(state, pane, token);
    assertNotDoneLeader(state, pane, "task add");
    if (state.tasks.some((candidate) => candidate.id === id)) throw new Error(`task ${id} already exists`);
    const now = new Date().toISOString();
    const ownerPane = optional(parsed, "owner-pane");
    if (ownerPane !== null) validatePaneName(ownerPane, "owner pane");
    const task: CoordinationTask = { id, creator: pane, title: required(parsed, "title"), businessValue: required(parsed, "value"), workspace: optional(parsed, "workspace"), ownerPane, stage: "open", claimer: null, blocker: null, createdAt: now, lastProgressAt: now, revision: 1 };
    state.tasks.push(task);
    return task;
  });
  return JSON.stringify({ ok: true, task });
}

function listTasks(parsed: ParsedArgs): string {
  const state = readCoordinationState();
  if (has(parsed, "json")) return JSON.stringify({ ok: true, tasks: state.tasks });
  return state.tasks.map((task) => `${task.id} | ${task.stage} | ${task.claimer ?? "unclaimed"} | ${task.businessValue} | ${task.title}`).join("\n") || "(no tasks)";
}

function reapTask(parsed: ParsedArgs, id: string, pane: string, token: string): string {
  const deadClaimer = validatePaneName(required(parsed, "dead-claimer"), "dead claimer");
  const task = withCoordinationLock((state) => {
    assertMemberToken(state, pane, token);
    if (deadClaimer === pane) throw new Error("operator pane cannot reap itself");
    const candidate = findTask(state, id);
    if (candidate.contract) throw new Error("linked tasks require task recover with verified execution death");
    if (candidate.claimer !== deadClaimer) throw new Error("task " + id + " is not claimed by " + deadClaimer);
    const session = state.sessions.find((value) => value.pane === deadClaimer);
    if (session === undefined) throw new Error("dead claimer " + deadClaimer + " has no registered session");
    // A quiet session can still be alive. Require an explicit done state.
    if (session.state !== "done") throw new Error("dead claimer " + deadClaimer + " must be done before reap");
    // Terminal tasks must not reopen, even when the claimer is done.
    assertTaskStageTransition(id, candidate.stage, "open");
    candidate.claimer = null;
    candidate.stage = "open";
    candidate.blocker = null;
    candidate.revision += 1;
    candidate.lastProgressAt = new Date().toISOString();
    return { ...candidate, reapReason: "session-done" };
  });
  return JSON.stringify({ ok: true, task });
}

function claimTask(id: string, pane: string, token: string): string {
  return JSON.stringify({ ok: true, task: withCoordinationLock((state) => {
    assertMemberToken(state, pane, token);
    assertNotDoneLeader(state, pane, "task claim");
    const task = findTask(state, id);
    if (task.stage !== "open" || task.claimer !== null) {
      throw new Error(`claim_conflict: task ${id} is ${task.stage}, claimed by ${task.claimer ?? "unknown"} (revision ${task.revision})`);
    }
    task.claimer = pane; task.stage = "claimed"; task.revision += 1; task.lastProgressAt = new Date().toISOString();
    return { ...task };
  }) });
}

function progressTask(id: string, pane: string, token: string): string {
  return JSON.stringify({ ok: true, task: withCoordinationLock((state) => {
    assertMemberToken(state, pane, token);
    assertNotDoneLeader(state, pane, "task progress");
    const task = ownedTask(state, id, pane);
    if (task.execution && task.execution.phase !== "active") throw new Error("linked execution is pending");
    if (task.stage === "claimed") task.stage = "in-progress"; task.revision += 1; task.lastProgressAt = new Date().toISOString(); return { ...task };
  }) });
}

function stageTask(argv: string[], id: string, pane: string, token: string, declaredResult?: TaskResult): string {
  const stage = argv[2] as TaskStage | undefined;
  if (!stage || !TASK_STAGES.includes(stage)) throw new Error(`task stage must be one of ${TASK_STAGES.join("|")}`);
  const result = withCoordinationLock((state) => {
    assertMemberToken(state, pane, token);
    assertNotDoneLeader(state, pane, "task stage");
    const task = ownedTask(state, id, pane);
    if (task.contract && !["in-progress", "blocked"].includes(stage)) throw new Error("linked task lifecycle requires task complete or task release; stage cannot bypass its contract");
    if (task.execution && task.execution.phase !== "active") throw new Error("linked execution is pending");
    // The transition matrix prevents new claims and reopening terminal work.
    assertTaskStageTransition(id, task.stage, stage);
    // Clear ownership so an open task can be claimed again.
    if (stage === "open") { task.claimer = null; task.blocker = null; }
    if (stage === "blocked") task.blocker = "declared by " + pane;
    if (declaredResult !== undefined) task.result = declaredResult;
    task.stage = stage; task.revision += 1; task.lastProgressAt = new Date().toISOString();
    const digests = stage === "done" ? deliverDigests(state, "task-done") : [];
    return { task: { ...task }, digests };
  });
  return JSON.stringify({ ok: true, ...result });
}

function findTask(state: CoordinationState, id: string): CoordinationTask { const task = state.tasks.find((candidate) => candidate.id === id); if (!task) throw new Error(`unknown task ${id}`); return task; }
function ownedTask(state: CoordinationState, id: string, pane: string): CoordinationTask { const task = findTask(state, id); if (task.claimer !== pane) throw new Error(`task ${id} is owned by ${task.claimer ?? "nobody"}; pane ${pane} cannot mutate it`); return task; }

function releaseOwnedTask(id: string, pane: string, token: string): string {
  return JSON.stringify({ ok: true, task: withCoordinationLock((state) => {
    assertMemberToken(state, pane, token);
    const task = ownedTask(state, id, pane);
    assertTaskStageTransition(id, task.stage, "open");
    task.claimer = null; task.stage = "open"; task.blocker = null; task.revision += 1;
    task.lastProgressAt = new Date().toISOString(); return task;
  }) });
}
