import { has, optional, optionalNumber, parseArgs, required, requiredToken } from "./args.js";
import { deliverDigests } from "./digest.js";
import { assertMessageStageTransition, evaluatePreSend } from "./pods.js";
import { refreshPendingStatus } from "./pending-status.js";
import { assertMemberToken, ORCHESTRATOR_MEMBER, withCoordinationLock } from "./state.js";
import type { CoordinationMessage, CoordinationState } from "./types.js";
import { validatePaneName, validateTaskId } from "./validation.js";

type ParsedArgs = ReturnType<typeof parseArgs>;
type MessagePayload = Pick<CoordinationMessage, "fromPane" | "toPane" | "replyTo" | "workspace" | "text" | "taskId" | "channelId" | "requestId">;

export function sendCommand(argv: string[]): string {
  const parsed = parseArgs(argv);
  const result = withCoordinationLock((state) => {
    const fromPane = validatePaneName(required(parsed, "from-pane"), "sender pane");
    assertMemberToken(state, fromPane, requiredToken(parsed));
    const { payload, parent } = resolvePayload(state, parsed, fromPane);
    const previous = findRetry(state, payload);
    // Authentication permits retrieval of this sender's accepted operation.
    // Do not repeat routing, channel counts, or reply effects for a receipt.
    if (previous) return { message: previous, digests: [], deduplicated: true };
    evaluatePreSend(state, fromPane, payload.toPane, payload.channelId);
    const id = state.nextMessageId++;
    const message: CoordinationMessage = {
      ...payload, id, threadId: parent?.threadId ?? id,
      state: "queued", claimer: null, createdAt: new Date().toISOString(),
    };
    const parentHandoff = handleParent(parent);
    state.messages.push(message);
    countChannelSend(state, payload.channelId);
    const digests = deliverDigests(state, "watcher-heartbeat");
    refreshNudge(state, payload.toPane);
    if (parentHandoff) refreshNudge(state, fromPane);
    return { message, digests, deduplicated: false };
    // A rejected send can still record verified leader death and succession.
  }, { commitOnThrow: true });
  return JSON.stringify({ ok: true, ...result });
}

function resolvePayload(state: CoordinationState, parsed: ParsedArgs, fromPane: string) {
  const replyTo = optionalNumber(parsed, "reply");
  const parent = resolveParent(state, replyTo, fromPane);
  const toPane = parent?.fromPane ?? validatePaneName(required(parsed, "to-pane"), "recipient pane");
  const payload: MessagePayload = {
    fromPane, toPane, replyTo: replyTo ?? null,
    workspace: optional(parsed, "workspace"), text: required(parsed, "text"),
    taskId: resolveTask(state, parsed, parent), channelId: optionalNumber(parsed, "channel"),
    requestId: has(parsed, "request-id") ? required(parsed, "request-id") : undefined,
  };
  return { payload, parent };
}

function resolveParent(state: CoordinationState, replyTo: number | undefined, fromPane: string): CoordinationMessage | undefined {
  if (replyTo === undefined) return undefined;
  const parent = state.messages.find((item) => item.id === replyTo);
  if (!parent) throw new Error(`unknown message #${replyTo}`);
  if (parent.toPane !== fromPane) throw new Error(`reply sender ${fromPane} is not the addressed pane ${parent.toPane}`);
  return parent;
}

function resolveTask(state: CoordinationState, parsed: ParsedArgs, parent?: CoordinationMessage): string | undefined {
  const supplied = has(parsed, "task") ? validateTaskId(required(parsed, "task")) : undefined;
  if (parent && supplied !== undefined && supplied !== parent.taskId) throw new Error("reply task conflicts with parent task");
  const taskId = parent ? parent.taskId : supplied;
  if (taskId !== undefined && !state.tasks.some((task) => task.id === taskId)) throw new Error(`unknown task ${taskId}`);
  return taskId;
}

function findRetry(state: CoordinationState, payload: MessagePayload): CoordinationMessage | undefined {
  if (payload.requestId === undefined) return undefined;
  const previous = state.messages.find((item) => item.fromPane === payload.fromPane && item.requestId === payload.requestId);
  if (!previous) return undefined;
  const fields = ["toPane", "replyTo", "workspace", "text", "taskId", "channelId"] as const;
  if (fields.some((field) => previous[field] !== payload[field])) throw new Error(`request_id_conflict: ${payload.requestId}`);
  return previous;
}

function handleParent(parent?: CoordinationMessage): boolean {
  if (!parent || (parent.state !== "queued" && parent.state !== "claimed")) return false;
  assertMessageStageTransition(parent.id, parent.state, "handled");
  parent.state = "handled";
  return true;
}

function countChannelSend(state: CoordinationState, channelId?: number): void {
  if (channelId === undefined) return;
  const channel = state.leaderChannels.find((item) => item.id === channelId)!;
  channel.messageCount += 1;
}

function refreshNudge(state: CoordinationState, pane: string): void {
  if (pane === ORCHESTRATOR_MEMBER) return;
  try { refreshPendingStatus(state, pane); } catch { /* The watch sweep repairs advisory files. */ }
}
