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

export interface CoordinationState {
  version: 1;
  nextMessageId: number;
  nextDigestId: number;
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
