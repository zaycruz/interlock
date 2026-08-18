import type { ProcessIdentity } from "../core/types.js";

export type TaskStage = "open" | "claimed" | "in-progress" | "blocked" | "done" | "closed";
export type SessionState = "idle" | "busy" | "done";
export type MessageStage = "queued" | "claimed" | "handled" | "closed";

export interface CoordinationTask {
  id: string;
  title: string;
  businessValue: string;
  workspace: string | null;
  ownerPane: string | null;
  stage: TaskStage;
  claimer: string | null;
  blocker: string | null;
  createdAt: string;
  lastProgressAt: string;
  revision: number;
}

export interface CoordinationMessage {
  id: number;
  threadId: number;
  replyTo: number | null;
  fromPane: string;
  toPane: string;
  workspace: string | null;
  text: string;
  state: MessageStage;
  claimer: string | null;
  createdAt: string;
}

export interface CoordinationSession {
  pane: string;
  state: SessionState;
  lastSeenAt: string;
}

export interface DigestDelivery {
  id: number;
  pane: string;
  messageIds: number[];
  reason: "watcher-heartbeat" | "agent-idle" | "agent-done" | "task-done";
  createdAt: string;
  file: string;
}

export interface Pod {
  name: string;
  createdAt: string;
  leader: string;
  succession: string[];
  status: "open" | "closed";
  closedAt: string | null;
}

export interface PodMember {
  member: string;
  pod: string;
  role: "leader" | "worker";
  process: ProcessIdentity | null;
  registeredAt: string;
}

export interface LeaderChannel {
  id: number;
  fromPod: string;
  toPod: string;
  topic: string;
  openedAt: string;
  closedAt: string | null;
  messageCount: number;
}

export type AwarenessEventKind = "pod-created" | "pod-closed" | "channel-opened" | "channel-closed"
  | "leader-death-verified" | "leader-promoted" | "leader-done";

// Metadata only: pod names, member names, topic, messageCount. Never text (ADR 0003 D1/D5).
export interface AwarenessEvent {
  id: number;
  kind: AwarenessEventKind;
  createdAt: string;
  pod?: string;
  fromPod?: string;
  toPod?: string;
  member?: string;
  members?: string[];
  topic?: string;
  messageCount?: number;
}

export interface OrchestratorState {
  initializedAt: string;
}

export interface CoordinationState {
  version: 2;
  nextMessageId: number;
  nextDigestId: number;
  nextChannelId: number;
  nextAwarenessEventId: number;
  memberTokens: Record<string, string>;
  pods: Pod[];
  podMembers: PodMember[];
  leaderChannels: LeaderChannel[];
  awarenessEvents: AwarenessEvent[];
  orchestrator: OrchestratorState | null;
  tasks: CoordinationTask[];
  messages: CoordinationMessage[];
  sessions: CoordinationSession[];
  digests: DigestDelivery[];
  lastWatchAt: string | null;
}

export interface DashboardView {
  product: "interlock";
  readOnly: true;
  generatedAt: string;
  watcher: {
    lastHeartbeatAt: string | null;
    digestDeliveries: number;
  };
  tasks: Array<CoordinationTask & { stale: boolean }>;
  sessions: CoordinationSession[];
  messages: {
    total: number;
    queued: number;
    claimed: number;
    handled: number;
    closed: number;
  };
  digests: DigestDelivery[];
}
