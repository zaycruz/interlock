import type { AwarenessEvent, AwarenessEventKind, CoordinationState, LeaderChannel, OrchestratorState, Pod, PodMember } from "./types.js";
import { validateCoordinationName, validateMemberName } from "./validation.js";
const AWARENESS_EVENT_KINDS: readonly AwarenessEventKind[] = ["pod-created", "pod-closed", "channel-opened", "channel-closed", "leader-death-verified", "leader-promoted", "leader-done", "member-appointed"];

export function pods(value: unknown): Pod[] {
  const list = arrayOf<Pod>(value);
  const seen = new Set<string>();
  for (const pod of list) {
    if (!isRecord(pod)) throw new Error("coordination pod record is corrupt");
    validateCoordinationName(pod.name, "pod name");
    validateCoordinationName(pod.leader, "pod leader");
    if (seen.has(pod.name)) throw new Error("coordination pod " + pod.name + " is duplicated");
    seen.add(pod.name);
    validatePodLifecycle(pod);
  }
  return list;
}

function validatePodLifecycle(pod: Pod): void {
  if (pod.status !== "open" && pod.status !== "closed") throw new Error("coordination pod " + pod.name + " status is corrupt");
  if (typeof pod.createdAt !== "string") throw new Error("coordination pod " + pod.name + " creation timestamp is corrupt");
  if (pod.closedAt !== null && typeof pod.closedAt !== "string") throw new Error("coordination pod " + pod.name + " close timestamp is corrupt");
  if (!Array.isArray(pod.succession)) throw new Error("coordination pod " + pod.name + " succession is corrupt");
  for (const member of pod.succession) validateCoordinationName(member, "pod succession member");
}

export function podMembers(value: unknown): PodMember[] {
  const list = arrayOf<PodMember>(value);
  const seen = new Set<string>();
  for (const member of list) {
    if (!isRecord(member)) throw new Error("coordination pod member record is corrupt");
    validateMemberName(member.member);
    validateCoordinationName(member.pod, "member pod");
    if (seen.has(member.member)) throw new Error("coordination member " + member.member + " is duplicated");
    seen.add(member.member);
    if (member.role !== "leader" && member.role !== "worker") throw new Error("coordination member " + member.member + " role is corrupt");
    if (typeof member.registeredAt !== "string") throw new Error("coordination member " + member.member + " registration timestamp is corrupt");
    validateMemberProcess(member);
    normalizeMemberTerminalMarkers(member);
  }
  return list;
}

function validateMemberProcess(member: PodMember): void {
  if (member.process !== null && (!isRecord(member.process) || !Number.isSafeInteger(member.process.pid) || (member.process.pid as number) <= 0 || typeof member.process.startedAt !== "string")) {
    throw new Error("coordination member " + member.member + " process identity is corrupt");
  }
}

function normalizeMemberTerminalMarkers(member: PodMember): void {
  if (member.diedAt !== undefined && member.diedAt !== null && typeof member.diedAt !== "string") throw new Error("coordination member " + member.member + " death timestamp is corrupt");
  if (member.doneAt !== undefined && member.doneAt !== null && typeof member.doneAt !== "string") throw new Error("coordination member " + member.member + " done timestamp is corrupt");
  // Pre-slice-4 state has no terminal markers; default them to null so the
  // lifecycle stays idempotent from the first post-upgrade event onward.
  if (member.diedAt === undefined) member.diedAt = null;
  if (member.doneAt === undefined) member.doneAt = null;
}

// ADR 0003 D6: persisted succession integrity, fail-closed at load. Each pod's
// succession must be a non-empty duplicate-free ranked list over exactly the
// pod's roster, and the pod's leader must hold the leader role in that roster.
// Anything else is a tampered or torn write and the state refuses to load.
export function assertSuccessionIntegrity(state: CoordinationState): void {
  const byName = new Map(state.podMembers.map((member) => [member.member, member]));
  for (const pod of state.pods) {
    if (pod.succession.length === 0) throw new Error("coordination pod " + pod.name + " succession is empty; every pod needs a ranked succession");
    const seen = new Set<string>();
    for (const member of pod.succession) {
      if (seen.has(member)) throw new Error("coordination pod " + pod.name + " succession repeats member " + member);
      seen.add(member);
      const record = byName.get(member);
      if (record === undefined) throw new Error("coordination pod " + pod.name + " succession member " + member + " is not in the pod roster");
      if (record.pod !== pod.name) throw new Error("coordination pod " + pod.name + " succession member " + member + " belongs to pod " + record.pod + ", not " + pod.name);
    }
    const leader = byName.get(pod.leader);
    if (leader === undefined || leader.pod !== pod.name) throw new Error("coordination pod " + pod.name + " leader " + pod.leader + " is not in the pod roster");
    if (leader.role !== "leader") throw new Error("coordination pod " + pod.name + " leader " + pod.leader + " does not hold the leader role");
  }
}

export function leaderChannels(value: unknown): LeaderChannel[] {
  const list = arrayOf<LeaderChannel>(value);
  for (const channel of list) {
    if (!isRecord(channel)) throw new Error("coordination channel record is corrupt");
    validateCoordinationName(channel.fromPod, "channel from-pod");
    validateCoordinationName(channel.toPod, "channel to-pod");
    if (typeof channel.topic !== "string" || channel.topic.trim() === "") throw new Error("coordination channel topic is corrupt");
    if (typeof channel.openedAt !== "string") throw new Error("coordination channel open timestamp is corrupt");
    if (channel.closedAt !== null && typeof channel.closedAt !== "string") throw new Error("coordination channel close timestamp is corrupt");
    if (!Number.isSafeInteger(channel.messageCount) || channel.messageCount < 0) throw new Error("coordination channel message count is corrupt");
  }
  return list;
}

export function awarenessEvents(value: unknown): AwarenessEvent[] {
  const list = arrayOf<AwarenessEvent>(value);
  for (const event of list) {
    if (!isRecord(event)) throw new Error("coordination awareness event record is corrupt");
    if (!AWARENESS_EVENT_KINDS.includes(event.kind)) throw new Error("coordination awareness event kind is corrupt");
    if (typeof event.createdAt !== "string") throw new Error("coordination awareness event timestamp is corrupt");
    validateAwarenessScope(event);
    validateAwarenessDetails(event);
  }
  return list;
}

function validateAwarenessScope(event: AwarenessEvent): void {
  if (event.pod !== undefined) validateCoordinationName(event.pod, "awareness event pod");
  if (event.fromPod !== undefined) validateCoordinationName(event.fromPod, "awareness event from-pod");
  if (event.toPod !== undefined) validateCoordinationName(event.toPod, "awareness event to-pod");
  if (event.member !== undefined) validateCoordinationName(event.member, "awareness event member");
}

function validateAwarenessDetails(event: AwarenessEvent): void {
  if (event.members !== undefined && (!Array.isArray(event.members) || event.members.some((member) => typeof member !== "string"))) throw new Error("coordination awareness event members are corrupt");
  if (event.topic !== undefined && typeof event.topic !== "string") throw new Error("coordination awareness event topic is corrupt");
  if (event.messageCount !== undefined && (!Number.isSafeInteger(event.messageCount) || event.messageCount < 0)) throw new Error("coordination awareness event message count is corrupt");
}

export function orchestratorState(value: unknown): OrchestratorState | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.initializedAt !== "string") throw new Error("coordination orchestrator state is corrupt");
  return { initializedAt: value.initializedAt };
}

function arrayOf<T>(value: unknown): T[] { return Array.isArray(value) ? structuredClone(value) as T[] : []; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
