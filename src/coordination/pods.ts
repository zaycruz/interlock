import { randomBytes } from "node:crypto";

import type { AwarenessEvent, AwarenessEventKind, CoordinationState, LeaderChannel, MessageStage, Pod, PodMember, TaskStage } from "./types.js";
import { ORCHESTRATOR_MEMBER, tokenHash } from "./state.js";
import { validateCoordinationName } from "./validation.js";
import { inspectProcess } from "../core/process-identity.js";
import type { ProcessIdentity } from "../core/types.js";

// ADR 0003 D2: the JSON pod template defines the roster, the leader, and the
// ranked succession order, all fixed at creation.
export interface PodTemplate {
  members: string[];
  leader: string;
  succession: string[];
}

export interface CreatedPod {
  pod: Pod;
  members: PodMember[];
  // Minted 256-bit tokens, returned exactly once so the operator can
  // distribute them to member processes out of band (ADR 0003 D2 step 5).
  tokens: Record<string, string>;
}

export interface ClosedPod {
  pod: Pod;
  closedChannels: LeaderChannel[];
}

export interface OpenedChannel {
  channel: LeaderChannel;
}

export interface ClosedChannel {
  channel: LeaderChannel;
}

// ADR 0003 D4: every channel carries a declared topic at open time (R8, AE6),
// bounded so the awareness feed stays a scannable index.
export const CHANNEL_TOPIC_MAX_LENGTH = 140;

// ADR 0003 OQ2: the awareness feed is append-only, so writes cap it at the
// most recent AWARENESS_FEED_MAX_EVENTS events. The id counter is never
// lowered: a dropped event's id is never reused, and the retained suffix is
// always a contiguous run of the highest ids, so reconstruction from the feed
// remains well-defined for every event still present.
export const AWARENESS_FEED_MAX_EVENTS = 1000;

// ADR 0003 OQ3: scale limits. A deployment is one orchestrator and its pods
// in one state file; these named bounds keep that file, the awareness feed,
// and the routing tables small enough for the file-backed store. Refusals
// name the limit so an operator hitting one can see the ceiling, not a
// mystery failure.
export const MAX_PODS_PER_DEPLOYMENT = 64;
export const MAX_ROSTER_SIZE = 16;

// il-2t8: stage transitions are a matrix, not a free-for-all. Tasks move
// forward through the work lifecycle and may recycle forward stages (a fresh
// look at in-progress work), but a task never reopens from done/closed and
// never manufactures a claim out of in-progress/blocked. Messages follow the
// same shape, with one extra rule: queued messages are still awaiting digest
// delivery, and closing is digest-invisible, so a queued message must be
// claimed (or answered, which marks it handled) before it can be closed —
// otherwise mail could vanish without ever surfacing in a digest.
const TASK_STAGE_TRANSITIONS: Record<TaskStage, ReadonlySet<TaskStage>> = {
  // open -> closed is deliberately absent: task mutation is owner-only, and
  // an open task has no owner, so the edge would be unreachable. Withdrawing
  // unclaimed work is a task remove concern, not a stage transition.
  open: new Set<TaskStage>(["claimed"]),
  claimed: new Set<TaskStage>(["open", "in-progress", "blocked", "done", "closed"]),
  "in-progress": new Set<TaskStage>(["open", "in-progress", "blocked", "done", "closed"]),
  blocked: new Set<TaskStage>(["open", "in-progress", "done", "closed"]),
  done: new Set<TaskStage>(["closed"]),
  closed: new Set<TaskStage>(),
};

const MESSAGE_STAGE_TRANSITIONS: Record<MessageStage, ReadonlySet<MessageStage>> = {
  queued: new Set<MessageStage>(["claimed", "handled"]),
  claimed: new Set<MessageStage>(["claimed", "handled", "closed"]),
  handled: new Set<MessageStage>(["closed"]),
  closed: new Set<MessageStage>(),
};

function assertTransition<T extends string>(transitions: Record<T, ReadonlySet<T>>, kind: string, id: string, from: T, to: T): void {
  if (from === to) return;
  if (!transitions[from].has(to)) {
    throw new Error(`${kind} ${id} cannot move from ${from} to ${to}`);
  }
}

export function assertTaskStageTransition(id: string, from: TaskStage, to: TaskStage): void {
  assertTransition(TASK_STAGE_TRANSITIONS, "task", id, from, to);
}

export function assertMessageStageTransition(id: number, from: MessageStage, to: MessageStage): void {
  assertTransition(MESSAGE_STAGE_TRANSITIONS, "message", `#${id}`, from, to);
}

// QA il-026 MF-1: C0 control characters (in particular CR, LF, and ESC) are
// rejected outright: the awareness feed renders topics into line-oriented
// text, so a newline in a topic could forge apparent feed records and terminal
// controls could alter rendering. The plain renderer also sanitizes topics
// defensively so a pre-fix persisted value cannot forge lines either.
const C0_CONTROL = /[\u0000-\u001F]/;

export function validateChannelTopic(value: string): string {
  const topic = typeof value === "string" ? value.trim() : "";
  if (topic === "") throw new Error("channel topic is required at open time and must not be blank (ADR 0003 D4)");
  if (C0_CONTROL.test(topic)) throw new Error("channel topic must not contain control characters (CR, LF, ESC, or other C0 controls)");
  if (topic.length > CHANNEL_TOPIC_MAX_LENGTH) throw new Error(`channel topic must be at most ${CHANNEL_TOPIC_MAX_LENGTH} characters, got ${topic.length}`);
  return topic;
}

export function parsePodTemplate(value: unknown): PodTemplate {
  if (!isRecord(value)) throw new Error("pod template must be a JSON object with members, leader, and succession");
  const members = nameList(value.members, "roster");
  if (members.length === 0) throw new Error("pod template roster must be a non-empty array of member names");
  if (new Set(members).size !== members.length) throw new Error("pod template roster contains a duplicate member name");
  for (const member of members) {
    if (member === ORCHESTRATOR_MEMBER) throw new Error("member name orchestrator is reserved and cannot join a pod roster");
  }
  if (typeof value.leader !== "string" || value.leader.trim() === "") throw new Error("pod template requires a leader member name");
  const leader = value.leader;
  if (!members.includes(leader)) throw new Error("pod template leader " + leader + " is not in the roster");
  const succession = nameList(value.succession, "succession");
  if (succession.length === 0) throw new Error("pod template succession must be a non-empty ranked list");
  for (const member of succession) {
    if (!members.includes(member)) throw new Error("pod template succession member " + member + " is not in the roster");
  }
  return { members, leader, succession };
}

function nameList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error("pod template " + label + " must be an array of member names");
  return value.map((entry) => validateCoordinationName(typeof entry === "string" ? entry : "", "pod template " + label + " member"));
}

// ADR 0003 D2: orchestrator-token-authenticated creation. The caller runs this
// inside withCoordinationLock after assertOrchestratorToken. Any failure throws
// before mutation, so a rejected creation leaves no partial roster behind.
export function createPod(state: CoordinationState, name: string, template: PodTemplate): CreatedPod {
  const podName = validateCoordinationName(name, "pod name");
  if (state.pods.some((pod) => pod.name === podName)) {
    throw new Error("pod name " + podName + " is already used; pod names are never reused, including closed pods");
  }
  // OQ3: closed pods count toward the limit too — their rosters stay
  // persisted as history and their names are never reusable, so they consume
  // the same state-file budget as open pods.
  if (state.pods.length >= MAX_PODS_PER_DEPLOYMENT) {
    throw new Error("deployment already has the maximum of " + MAX_PODS_PER_DEPLOYMENT + " pods; close history cannot be deleted, so no new pod can be created");
  }
  if (template.members.length > MAX_ROSTER_SIZE) {
    throw new Error("pod roster of " + template.members.length + " members exceeds the maximum of " + MAX_ROSTER_SIZE + "; split the work across more pods");
  }
  // Provision every member engine-side: a 256-bit random token, only its hash
  // stored. A roster name already present in memberTokens with a different
  // hash is squatted or stale; creation aborts and reports the name.
  const tokens: Record<string, string> = {};
  for (const member of template.members) {
    const existing = state.podMembers.find((candidate) => candidate.member === member);
    if (existing !== undefined) throw new Error("member " + member + " already belongs to pod " + existing.pod + "; membership is exclusive");
    const token = randomBytes(32).toString("hex");
    const hash = tokenHash(token);
    const registered = state.memberTokens[member];
    if (registered !== undefined && registered !== hash) {
      throw new Error("roster member " + member + " is already registered with a different token; pod creation aborted, pick another name");
    }
    tokens[member] = token;
  }
  const now = new Date().toISOString();
  const pod: Pod = { name: podName, createdAt: now, leader: template.leader, succession: [...template.succession], status: "open", closedAt: null };
  const members: PodMember[] = template.members.map((member) => ({
    member,
    pod: podName,
    role: member === template.leader ? "leader" : "worker",
    process: null,
    registeredAt: now,
    diedAt: null,
    doneAt: null,
  }));
  for (const member of template.members) state.memberTokens[member] = tokenHash(tokens[member]!);
  state.pods.push(pod);
  state.podMembers.push(...members);
  appendAwarenessEvent(state, "pod-created", { pod: podName, members: [...template.members], member: template.leader });
  return { pod, members, tokens };
}

// ADR 0003 D7: deliberate orchestrator close. Nothing automatic closes a pod.
export function closePod(state: CoordinationState, name: string): ClosedPod {
  const pod = state.pods.find((candidate) => candidate.name === name);
  if (pod === undefined) throw new Error("unknown pod " + name);
  if (pod.status === "closed") throw new Error("pod " + name + " is already closed");
  const roster = state.podMembers.filter((member) => member.pod === name).map((member) => member.member);
  const now = new Date().toISOString();
  pod.status = "closed";
  pod.closedAt = now;
  appendAwarenessEvent(state, "pod-closed", { pod: name, members: roster });
  // No further command may authenticate as a member of the pod.
  for (const member of roster) delete state.memberTokens[member];
  const closedChannels: LeaderChannel[] = [];
  for (const channel of state.leaderChannels) {
    if (channel.closedAt !== null || (channel.fromPod !== name && channel.toPod !== name)) continue;
    channel.closedAt = now;
    closedChannels.push(channel);
    appendAwarenessEvent(state, "channel-closed", { fromPod: channel.fromPod, toPod: channel.toPod, topic: channel.topic, messageCount: channel.messageCount });
  }
  // The pod record, member records, channels, and messages persist as history.
  return { pod, closedChannels };
}

// ADR 0003 D6 (MF-D): the single pre-send evaluation seam. Lazy leader-death
// evaluation runs here BEFORE the routing decision: evaluate death, apply the
// promotion, then evaluate the triggering send against post-promotion state.
// Keep evaluatePreSend the only pre-send call site so that ordering cannot be
// bypassed.
export function evaluatePreSend(state: CoordinationState, fromMember: string, toMember: string, channelId?: number): void {
  evaluateSuccession(state, fromMember);
  evaluateSuccession(state, toMember);
  assertSendAllowed(state, fromMember, toMember, channelId);
}

// ADR 0003 D6 (R13, R16): death-verified auto-promotion. If the named member's
// pod has a bound, verifiably dead leader, promote the first ranked successor
// whose own process verifies alive. Only `dead` and `mismatched` count as
// death — `alive`, `ambiguous`, and `unknown` never fire promotion (AE1), and
// staleness/silence/missed heartbeats are not inputs at all.
export function evaluateSuccession(state: CoordinationState, member: string): void {
  const entry = membershipOf(state, member);
  if (entry === undefined) return;
  const { pod } = entry;
  if (pod.status !== "open") return;
  const leader = state.podMembers.find((candidate) => candidate.member === pod.leader && candidate.pod === pod.name);
  if (leader === undefined || leader.process === null) return;
  // Terminal marker: a leader already verified dead is never re-evaluated, so
  // leader-death-verified fires exactly once per leader (idempotent lifecycle).
  if (leader.diedAt !== null) return;
  const status = inspectProcess(leader.process);
  if (status !== "dead" && status !== "mismatched") return;

  leader.diedAt = new Date().toISOString();
  appendAwarenessEvent(state, "leader-death-verified", { pod: pod.name, member: leader.member });

  for (const candidate of pod.succession) {
    if (candidate === leader.member) continue;
    const successor = state.podMembers.find((entry) => entry.member === candidate && entry.pod === pod.name);
    if (successor === undefined || successor.process === null) continue;
    // The successor must be able to authenticate as the pod's new leader: a
    // missing token hash would promote an unreachable leader and strand the
    // pod's external reach. Fail closed — keep the pod leaderless in place.
    if (state.memberTokens[successor.member] === undefined) continue;
    // `ambiguous` (weak ps precision) still confirms a live process with a
    // matching start time; only `dead`, `mismatched`, and `unknown` disqualify
    // a successor. Promotion fires only on the leader's verified death, never
    // on a candidate's ambiguity.
    const candidateStatus = inspectProcess(successor.process);
    if (candidateStatus !== "alive" && candidateStatus !== "ambiguous") continue;
    leader.role = "worker";
    successor.role = "leader";
    pod.leader = successor.member;
    // The dead leader's token must not survive as a posthumous forgery path
    // (MF-B); the hash is deleted only when a reachable successor takes over.
    delete state.memberTokens[leader.member];
    appendAwarenessEvent(state, "leader-promoted", { pod: pod.name, member: successor.member });
    return;
  }
  // Every candidate is dead, unverifiable, or unauthenticated: the pod keeps
  // its roster and its dead leader's token (fail closed — the roster still
  // authenticates), loses external reach, and waits for the orchestrator. It
  // never closes (R15).
}

// ADR 0003 D6 (MF-A): rebind lifecycle. A member whose recorded identity has
// verifiably died rebinds to the calling process's own identity, captured
// engine-side. There is no --pid flag and no way to name another process: a
// stolen token can rebind only to a process the thief actually runs, and only
// after the real member's process is verifiably gone.
export function rebindMemberProcess(state: CoordinationState, member: string, identity: ProcessIdentity): PodMember {
  const entry = membershipOf(state, member);
  if (entry === undefined) throw new Error("member " + member + " is not in a pod");
  if (entry.pod.status === "closed") throw new Error("pod " + entry.pod.name + " is closed");
  const record = entry.member;
  if (record.process !== null) {
    const status = inspectProcess(record.process);
    if (status !== "dead" && status !== "mismatched") {
      throw new Error("member " + member + " is still alive under its recorded process identity; rebind requires a verified-dead identity");
    }
  }
  record.process = identity;
  return record;
}

// ADR 0003 D6 (R14, MF-C): leader-done power reduction. The done leader keeps
// role "leader" for addressing and keeps its token, but its open channels are
// closed in the same mutation, each with its message count recorded, and the
// leader-done awareness event fires. No promotion runs; the pod waits for the
// orchestrator to appoint a successor or close it (AE3).
export function recordLeaderDone(state: CoordinationState, member: string): void {
  const entry = membershipOf(state, member);
  if (entry === undefined) return;
  if (entry.member.role !== "leader" || entry.pod.status !== "open") return;
  // Terminal marker: leader-done fires once, on the transition into done.
  if (entry.member.doneAt !== null) return;
  entry.member.doneAt = new Date().toISOString();
  appendAwarenessEvent(state, "leader-done", { pod: entry.pod.name, member });
  const now = new Date().toISOString();
  for (const channel of state.leaderChannels) {
    if (channel.closedAt !== null) continue;
    if (channel.fromPod !== entry.pod.name && channel.toPod !== entry.pod.name) continue;
    channel.closedAt = now;
    appendAwarenessEvent(state, "channel-closed", { fromPod: channel.fromPod, toPod: channel.toPod, topic: channel.topic, messageCount: channel.messageCount });
  }
}

// ADR 0003 D6 (MF-C): a leader that reported done sheds all external and
// task-mutation authority; only intra-pod messaging survives while the pod
// waits for the orchestrator. Enforced at every mutation boundary.
export function assertNotDoneLeader(state: CoordinationState, member: string, action: string): void {
  const entry = membershipOf(state, member);
  if (entry === undefined) return;
  if (entry.member.role === "leader" && entry.member.doneAt !== null) {
    throw new Error(action + " rejected: leader " + member + " has reported done and no longer holds that authority");
  }
}

// ADR 0003 D4: the routing boundary, decided by one pure function over state.
// Rules evaluate in order; anything not explicitly allowed is rejected.
export function assertSendAllowed(state: CoordinationState, fromMember: string, toMember: string, channelId?: number): void {
  // The orchestrator is never a channel endpoint (D5): leaders file non-channel
  // reports to it, and it messages pod leaders only. Never workers.
  if (fromMember === ORCHESTRATOR_MEMBER || toMember === ORCHESTRATOR_MEMBER) {
    if (channelId !== undefined) throw new Error("send rejected: the orchestrator is not a leader-channel endpoint; reports to the orchestrator do not ride channels");
    const leader = fromMember === ORCHESTRATOR_MEMBER ? toMember : fromMember;
    const entry = membershipOf(state, leader);
    // ADR 0003 D6 (MF-C): a leader that reported done sheds external reach,
    // including reports to the orchestrator, while it waits for appointment.
    if (entry !== undefined && entry.member.doneAt !== null && entry.member.role === "leader") {
      throw new Error("send rejected: leader " + entry.member.member + " has reported done and no longer has external reach");
    }
    if (fromMember === ORCHESTRATOR_MEMBER && (entry === undefined || entry.pod.status !== "open" || entry.member.role !== "leader")) {
      throw new Error("send rejected: the orchestrator can only message pod leaders, never workers");
    }
    if (toMember === ORCHESTRATOR_MEMBER && (entry === undefined || entry.pod.status !== "open" || entry.member.role !== "leader")) {
      throw new Error("send rejected: only a pod leader can report to the orchestrator");
    }
    return;
  }
  const from = membershipOf(state, fromMember);
  const to = membershipOf(state, toMember);
  if (from === undefined) throw new Error("send rejected: member " + fromMember + " is not in a pod");
  if (to === undefined) throw new Error("send rejected: member " + toMember + " is not in a pod");
  if (from.pod.status === "closed") throw new Error("send rejected: pod " + from.pod.name + " is closed");
  if (to.pod.status === "closed") throw new Error("send rejected: pod " + to.pod.name + " is closed");
  // ADR 0003 D6 (MF-C): a leader that reported done sheds external reach. A
  // done leader cannot send outside its pod — not to another pod, not to the
  // orchestrator — while it waits for the orchestrator to appoint or close.
  if (from.member.doneAt !== null && from.member.role === "leader" && from.pod.name !== to.pod.name) {
    throw new Error("send rejected: leader " + fromMember + " has reported done and no longer has external reach");
  }
  // Rule 1: same pod, any member to any member including the leader.
  if (from.pod.name === to.pod.name) {
    if (channelId !== undefined) throw new Error("send rejected: leader channels carry cross-pod sends only, not intra-pod mail");
    return;
  }
  // Rule 2: leader to leader of another pod, only over an open channel whose
  // endpoints are exactly the two pods.
  if (from.member.role !== "leader") throw new Error("send rejected: worker " + fromMember + " cannot send outside pod " + from.pod.name);
  if (to.member.role !== "leader") throw new Error("send rejected: external mail to pod " + to.pod.name + " is addressed to its leader, never to worker " + toMember);
  if (channelId === undefined) throw new Error("send rejected: pods " + from.pod.name + " and " + to.pod.name + " have no open leader channel; name one with --channel");
  const channel = state.leaderChannels.find((candidate) => candidate.id === channelId);
  if (channel === undefined) throw new Error("send rejected: unknown leader channel " + channelId);
  const endpoints = (channel.fromPod === from.pod.name && channel.toPod === to.pod.name) || (channel.fromPod === to.pod.name && channel.toPod === from.pod.name);
  if (!endpoints) throw new Error("send rejected: leader channel " + channelId + " does not connect pods " + from.pod.name + " and " + to.pod.name);
  if (channel.closedAt !== null) throw new Error("send rejected: leader channel " + channelId + " is closed");
}

function membershipOf(state: CoordinationState, member: string): { pod: Pod; member: PodMember } | undefined {
  const entry = state.podMembers.find((candidate) => candidate.member === member);
  if (entry === undefined) return undefined;
  const pod = state.pods.find((candidate) => candidate.name === entry.pod);
  if (pod === undefined) return undefined;
  return { pod, member: entry };
}

export function appendAwarenessEvent(state: CoordinationState, kind: AwarenessEventKind, fields: Partial<Omit<AwarenessEvent, "id" | "kind" | "createdAt">>): AwarenessEvent {
  const event: AwarenessEvent = { id: state.nextAwarenessEventId++, kind, createdAt: new Date().toISOString(), ...fields };
  state.awarenessEvents.push(event);
  if (state.awarenessEvents.length > AWARENESS_FEED_MAX_EVENTS) {
    state.awarenessEvents.splice(0, state.awarenessEvents.length - AWARENESS_FEED_MAX_EVENTS);
  }
  return event;
}

// ADR 0003 D4/D5: leader-to-leader channels. The caller authenticates the
// member token inside withCoordinationLock before invoking this; here we
// prove the caller is the leader of the opening pod. Both endpoints must be
// open pods; the topic is mandatory and bounded. One open channel per pod
// pair: a second open is rejected while the first is live.
export function openLeaderChannel(state: CoordinationState, member: string, podName: string, toPodName: string, topic: string): OpenedChannel {
  const declaredTopic = validateChannelTopic(topic);
  if (podName === toPodName) throw new Error("leader channel endpoints must be two different pods");
  const from = leaderMembership(state, member, podName);
  // D6: channel open is part of the leader's external authority, so it
  // follows the same post-done power reduction as send and task mutations.
  assertNotDoneLeader(state, member, "pod channel open");
  const toPod = state.pods.find((candidate) => candidate.name === toPodName);
  if (toPod === undefined) throw new Error("unknown pod " + toPodName);
  if (from.pod.status === "closed") throw new Error("pod " + podName + " is closed; no new channels");
  if (toPod.status === "closed") throw new Error("pod " + toPodName + " is closed; no new channels");
  const existing = state.leaderChannels.find((channel) =>
    channel.closedAt === null &&
    ((channel.fromPod === podName && channel.toPod === toPodName) || (channel.fromPod === toPodName && channel.toPod === podName)));
  if (existing !== undefined) {
    throw new Error(`a leader channel between pods ${podName} and ${toPodName} is already open (channel ${existing.id})`);
  }
  const channel: LeaderChannel = {
    id: state.nextChannelId++,
    fromPod: podName,
    toPod: toPodName,
    topic: declaredTopic,
    openedAt: new Date().toISOString(),
    closedAt: null,
    messageCount: 0,
  };
  state.leaderChannels.push(channel);
  appendAwarenessEvent(state, "channel-opened", { fromPod: channel.fromPod, toPod: channel.toPod, topic: channel.topic });
  return { channel };
}

// Either endpoint's leader may close a channel; workers and outsiders cannot.
// The awareness event records the final message count (R11).
export function closeLeaderChannel(state: CoordinationState, member: string, channelId: number): ClosedChannel {
  const channel = state.leaderChannels.find((candidate) => candidate.id === channelId);
  if (channel === undefined) throw new Error("unknown leader channel " + channelId);
  const membership = membershipOf(state, member);
  const isEndpointLeader = membership !== undefined &&
    membership.member.role === "leader" &&
    membership.pod.status === "open" &&
    (membership.pod.name === channel.fromPod || membership.pod.name === channel.toPod);
  if (!isEndpointLeader) {
    throw new Error("leader channel " + channelId + " can only be closed by a leader of pod " + channel.fromPod + " or pod " + channel.toPod);
  }
  if (channel.closedAt !== null) throw new Error("leader channel " + channelId + " is already closed");
  channel.closedAt = new Date().toISOString();
  appendAwarenessEvent(state, "channel-closed", { fromPod: channel.fromPod, toPod: channel.toPod, topic: channel.topic, messageCount: channel.messageCount });
  return { channel };
}

function leaderMembership(state: CoordinationState, member: string, podName: string): { pod: Pod; member: PodMember } {
  const entry = membershipOf(state, member);
  if (entry === undefined || entry.pod.name !== podName || entry.member.role !== "leader") {
    throw new Error("member " + member + " is not the leader of pod " + podName + "; only a pod leader opens and closes channels");
  }
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
