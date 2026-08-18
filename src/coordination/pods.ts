import { randomBytes } from "node:crypto";

import type { AwarenessEvent, AwarenessEventKind, CoordinationState, LeaderChannel, Pod, PodMember } from "./types.js";
import { ORCHESTRATOR_MEMBER, tokenHash } from "./state.js";
import { validateCoordinationName } from "./validation.js";

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

export function validateChannelTopic(value: string): string {
  const topic = typeof value === "string" ? value.trim() : "";
  if (topic === "") throw new Error("channel topic is required at open time and must not be blank (ADR 0003 D4)");
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

// ADR 0003 D6 (MF-D): the single pre-send evaluation seam. Slice 4 slots lazy
// leader-death evaluation in here BEFORE the routing decision: evaluate death,
// apply the promotion, then evaluate the triggering send against post-promotion
// state. Keep evaluatePreSend the only pre-send call site so that ordering
// cannot be bypassed.
export function evaluatePreSend(state: CoordinationState, fromMember: string, toMember: string, channelId?: number): void {
  assertSendAllowed(state, fromMember, toMember, channelId);
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
