import { existsSync } from "node:fs";
import { ChildProcessBeadsClient } from "../beads/index.js";
import { existingLeaseDatabasePath, openLeaseReader } from "../core/index.js";
import { readInterlockSnapshot } from "../application/snapshot.js";
import { optional, required } from "./args.js";
import { assertMemberToken, readCoordinationState, withCoordinationLock } from "./state.js";
import { assertNotDoneLeader } from "./pods.js";
import type { CoordinationState, CoordinationTask } from "./types.js";
import { readTaskContract, canonicalWorkspace } from "../application/linked-contract.js";
import { validatePaneName } from "./validation.js";

type Args = Map<string, string | true>;
export function inspectTasks(id: string | undefined, pane: string, token: string, resume: boolean): string {
  const state = readCoordinationState();
  assertMemberToken(state, pane, token);
  const tasks = id ? [findTask(state, id)] : state.tasks.filter((task) => task.claimer === pane);
  const observedTasks = tasks.map(observeTask);
  if (!resume) return JSON.stringify({ ok: true, task: observedTasks[0] });
  const ids = new Set(tasks.map((task) => task.id));
  const messages = state.messages.filter((message) => message.taskId && ids.has(message.taskId) && (message.fromPane === pane || message.toPane === pane));
  return JSON.stringify({ ok: true, tasks: observedTasks, messages });
}

export function editTask(operation: string, id: string, pane: string, token: string, args: Args): string {
  const task = withCoordinationLock((state) => {
    assertMemberToken(state, pane, token);
    assertNotDoneLeader(state, pane, `task ${operation}`);
    const current = findTask(state, id);
    if (operation === "checkpoint" || operation === "block") return progress(current, pane, operation, args);
    assertEditableTask(current, pane, args);
    if (operation === "withdraw") { current.stage = "closed"; current.withdrawalReason = required(args, "reason"); }
    else update(current, args, state);
    current.revision += 1; current.lastProgressAt = new Date().toISOString(); return current;
  });
  return JSON.stringify({ ok: true, task });
}

function assertEditableTask(current: CoordinationTask, pane: string, args: Args): void {
  if (current.creator !== pane && current.ownerPane !== pane && current.claimer !== pane) throw new Error("only the task creator or owner can edit it");
  if (Number(required(args, "revision")) !== current.revision) throw new Error("task revision conflict");
  if (current.stage !== "open" || current.claimer !== null) throw new Error("only an open unclaimed task can be corrected or withdrawn");
  if (current.execution && current.execution.phase !== "released") throw new Error("task execution must be resolved before editing");
}

function update(task: CoordinationTask, args: Args, state: CoordinationState): void {
  const workspace = optional(args, "workspace");
  const contract = optional(args, "contract");
  if (task.contract && (optional(args, "title") || optional(args, "value"))) throw new Error("Beads owns linked title and value; update the issue then supply its contract");
  if (workspace !== null) task.workspace = workspace;
  if (task.contract && workspace !== null && contract === null) throw new Error("workspace changes require the linked contract");
  if (contract !== null) updateLinkedContract(task, contract, state);
  updateTaskMetadata(task, args);
}

function updateTaskMetadata(task: CoordinationTask, args: Args): void {
  const title = optional(args, "title"); if (title !== null) task.title = title;
  const value = optional(args, "value"); if (value !== null) task.businessValue = value;
  const owner = optional(args, "owner-pane"); if (owner !== null) task.ownerPane = validatePaneName(owner);
}

function updateLinkedContract(task: CoordinationTask, contract: string, state: CoordinationState): void {
  if (!task.contract) throw new Error("create a new linked task instead of changing a coordination-only task identity");
  if (!task.workspace) throw new Error("linked task requires --workspace");
  task.workspace = canonicalWorkspace(task.workspace);
  const linked = readTaskContract(task.workspace, JSON.parse(contract));
  if (linked.contract.beadId !== task.contract.beadId || linked.contract.repositoryId !== task.contract.repositoryId) throw new Error("canonical task identity cannot change");
  assertUniqueContract(state, task.id, linked.contract);
  Object.assign(task, linked);
}

function progress(task: CoordinationTask, pane: string, operation: string, args: Args): CoordinationTask {
  if (task.claimer !== pane) throw new Error("only the task owner can record progress");
  if (["open", "done", "closed"].includes(task.stage)) throw new Error("task is not active");
  if (task.execution && task.execution.phase !== "active") throw new Error("execution is pending; resolve it before recording progress");
  if (operation === "checkpoint") { task.checkpoint = required(args, "text"); task.stage = "in-progress"; task.blocker = null; }
  else { task.blocker = required(args, "reason"); task.stage = "blocked"; }
  task.revision += 1; task.lastProgressAt = new Date().toISOString(); return task;
}

export function assertUniqueContract(state: CoordinationState, id: string, contract: NonNullable<CoordinationTask["contract"]>): void {
  if (state.tasks.some((task) => task.id !== id && task.contract?.repositoryId === contract.repositoryId && task.contract.beadId === contract.beadId)) throw new Error("canonical repository/Beads task already exists");
}
function findTask(state: CoordinationState, id: string): CoordinationTask { const task = state.tasks.find((candidate) => candidate.id === id); if (!task) throw new Error(`unknown task ${id}`); return task; }


function observeTask(task: CoordinationTask): CoordinationTask & { observation?: unknown } {
  if (!task.contract || !task.workspace) return task;
  const workspace = task.execution?.workspace ?? task.workspace;
  let reader: ReturnType<typeof openLeaseReader> | undefined;
  try {
    const beads = new ChildProcessBeadsClient(workspace);
    reader = existsSync(existingLeaseDatabasePath(workspace)) ? openLeaseReader(workspace) : undefined;
    return { ...task, observation: { snapshot: readInterlockSnapshot(beads, reader, task.contract.beadId, { workspace }),
      upstream: beads.dependencies(task.contract.beadId), downstream: beads.dependents(task.contract.beadId) } };
  } catch (error) {
    return { ...task, observation: { error: error instanceof Error ? error.message : String(error) } };
  } finally { reader?.close(); }
}
