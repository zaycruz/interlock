import { validateTaskId, validatePaneName } from "../coordination/validation.js";
import { currentProcessIdentity, openLeaseStore } from "../core/index.js";
import { assertMemberToken, readCoordinationState, withCoordinationLock } from "../coordination/state.js";
import { assertNotDoneLeader } from "../coordination/pods.js";
import type { CoordinationTask } from "../coordination/types.js";
import { readTaskContract, canonicalWorkspace } from "./linked-contract.js";
import { withLifecycleLock } from "./lease-commands.js";

export function createLinkedTask(input: { id: string; pane: string; token: string; workspace: string; ownerPane: string | null }, contract: unknown): CoordinationTask {
  validateTaskId(input.id);
  validatePaneName(input.pane);
  if (input.ownerPane !== null) validatePaneName(input.ownerPane);
  assertMemberToken(readCoordinationState(), input.pane, input.token);
  const workspace = canonicalWorkspace(input.workspace);
  // Lease-before-coordination ordering prevents attachment racing a legacy claim.
  return withLifecycleLock(workspace, openLeaseStore, currentProcessIdentity(), () => {
    const linked = readTaskContract(workspace, contract);
    return withCoordinationLock((state) => {
      assertMemberToken(state, input.pane, input.token);
      assertNotDoneLeader(state, input.pane, "task add");
      if (state.tasks.some((task) => task.id === input.id)) throw new Error(`task ${input.id} already exists`);
      if (state.tasks.some((task) => task.contract?.repositoryId === linked.contract.repositoryId && task.contract.beadId === linked.contract.beadId)) throw new Error("canonical repository/Beads task already exists");
      const now = new Date().toISOString();
      const task: CoordinationTask = { id: input.id, ...linked, creator: input.pane, workspace, ownerPane: input.ownerPane,
        stage: "open", claimer: null, blocker: null, createdAt: now, lastProgressAt: now, revision: 1 };
      state.tasks.push(task); return task;
    });
  });
}
