import { readFileSync, unlinkSync } from "node:fs";

import { closeLeaderChannel, closePod, createPod, evaluatePreSend, openLeaderChannel, parsePodTemplate } from "./pods.js";
import { buildDashboardView, renderDashboard } from "./render.js";
import { assertMemberToken, assertOrchestratorToken, migrateLegacyCoordinationState, ORCHESTRATOR_MEMBER, provisionOrchestrator, readCoordinationState, registerMemberToken, withCoordinationLock, writeDigestDelivery } from "./state.js";
import type { CoordinationMessage, CoordinationState, CoordinationTask, DigestDelivery, SessionState, TaskStage } from "./types.js";
import { validatePaneName, validateTaskId } from "./validation.js";

export interface CoordinationCliResult { exitCode: number; stdout: string; stderr: string; }

const COMMANDS = new Set(["task", "send", "inbox", "session", "watch", "dashboard", "compact", "orchestrator", "state", "pod"]);
const TASK_STAGES: TaskStage[] = ["open", "claimed", "in-progress", "blocked", "done", "closed"];

export function runCoordinationCli(argv: string[]): CoordinationCliResult | null {
  if (!COMMANDS.has(argv[0] ?? "")) return null;
  try {
    return { exitCode: 0, stdout: `${execute(argv)}\n`, stderr: "" };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `Error: ${message(error)}\n` };
  }
}

export function coordinationUsage(): string[] {
  return [
    "  interlock session register --pane <pane> --token <token>",
    "  interlock task add --id <id> --title <title> --value <business-value> --pane <pane> --token <token> [--workspace <ws>] [--owner-pane <pane>]",
    "  interlock task list [--json]",
    "  interlock task claim <id> --pane <pane> --token <token>",
    "  interlock task progress <id> --pane <pane> --token <token>",
    "  interlock task stage <id> <open|claimed|in-progress|blocked|done|closed> --pane <pane> --token <token>",
    "  interlock task reap <id> --pane <operator-pane> --token <token> --dead-claimer <pane>  (claimer session must be done)",
    "  interlock send --from-pane <pane> --to-pane <pane> --token <token> --text <text> [--workspace <ws>] [--reply <message-id>] [--channel <channel-id>]",
    "  interlock inbox --pane <pane> --token <token> [--all] [--json]",
    "  interlock session set --pane <pane> --token <token> --state <idle|busy|done>",
    "  interlock watch --once",
    "  interlock dashboard --once [--json]",
    "  interlock compact",
    "  interlock orchestrator init [--rotate]  (operator: mint the orchestrator token, printed once; --rotate replaces a lost token)",
    "  interlock state migrate --legacy-pod <name> --legacy-leader <pane>  (operator: one-time version-1 upgrade; run orchestrator init first)",
    "  interlock pod create --name <pod> --template <file> --orchestrator-token <token>  (member tokens are printed once)",
    "  interlock pod close --pod <pod> --orchestrator-token <token>",
    "  interlock pod list [--json]",
    "  interlock pod show --pod <pod> [--json]",
    "  interlock pod channel open --pod <pod> --to-pod <pod> --member <leader> --token <token> --topic <topic>  (topic required, max 140 chars)",
    "  interlock pod channel close --channel <id> --member <leader> --token <token>",
    "  interlock pod channel list [--pod <pod>] [--json]",
    "  interlock pod awareness [--pod <pod>] [--json]  (metadata-only feed; never message content)",
  ];
}

function execute(argv: string[]): string {
  const command = argv[0];
  if (command === "task") return taskCommand(argv.slice(1));
  if (command === "send") return sendCommand(argv.slice(1));
  if (command === "inbox") return inboxCommand(argv.slice(1));
  if (command === "session") return sessionCommand(argv.slice(1));
  if (command === "watch") return watchCommand(argv.slice(1));
  if (command === "dashboard") return dashboardCommand(argv.slice(1));
  if (command === "compact") return compactCommand();
  if (command === "orchestrator") return orchestratorCommand(argv.slice(1));
  if (command === "state") return stateCommand(argv.slice(1));
  if (command === "pod") return podCommand(argv.slice(1));
  throw new Error(`unknown coordination command: ${command}`);
}

function podCommand(argv: string[]): string {
  const subcommand = argv[0];
  if (subcommand === "channel") return channelCommand(argv.slice(1));
  if (subcommand === "awareness") return awarenessCommand(argv.slice(1));
  const parsed = parseArgs(argv.slice(1));
  if (subcommand === "create") {
    const name = required(parsed, "name");
    const template = readPodTemplate(required(parsed, "template"));
    const orchestratorToken = required(parsed, "orchestrator-token");
    const created = withCoordinationLock((state) => {
      assertOrchestratorToken(state, orchestratorToken);
      return createPod(state, name, template);
    });
    return JSON.stringify({ ok: true, ...created, notice: "member tokens are printed exactly once; distribute them to member processes out of band" });
  }
  if (subcommand === "close") {
    const name = required(parsed, "pod");
    const orchestratorToken = required(parsed, "orchestrator-token");
    const closed = withCoordinationLock((state) => {
      assertOrchestratorToken(state, orchestratorToken);
      return closePod(state, name);
    });
    return JSON.stringify({ ok: true, ...closed });
  }
  // Read-only views, same posture as the dashboard: no token, no mutation.
  if (subcommand === "list") {
    const state = readCoordinationState();
    if (has(parsed, "json")) return JSON.stringify({ ok: true, pods: state.pods });
    return state.pods.map((pod) => `${pod.name} | ${pod.status} | leader ${pod.leader} | members ${state.podMembers.filter((member) => member.pod === pod.name).length}`).join("\n") || "(no pods)";
  }
  if (subcommand === "show") {
    const name = required(parsed, "pod");
    const state = readCoordinationState();
    const pod = state.pods.find((candidate) => candidate.name === name);
    if (pod === undefined) throw new Error("unknown pod " + name);
    const members = state.podMembers.filter((member) => member.pod === name);
    if (has(parsed, "json")) return JSON.stringify({ ok: true, pod, members });
    const lines = [`POD ${pod.name} | ${pod.status} | leader ${pod.leader} | succession ${pod.succession.join(", ")}`];
    for (const member of members) lines.push(`${member.member} | ${member.role} | registered ${member.registeredAt}`);
    return lines.join("\n");
  }
  throw new Error("pod requires create, close, list, or show");
}

function channelCommand(argv: string[]): string {
  const subcommand = argv[0];
  const parsed = parseArgs(argv.slice(1));
  if (subcommand === "open") {
    const pod = required(parsed, "pod");
    const toPod = required(parsed, "to-pod");
    const member = required(parsed, "member");
    const token = requiredToken(parsed);
    const topic = required(parsed, "topic");
    const opened = withCoordinationLock((state) => {
      assertMemberToken(state, member, token);
      return openLeaderChannel(state, member, pod, toPod, topic);
    });
    return JSON.stringify({ ok: true, ...opened });
  }
  if (subcommand === "close") {
    const channelId = optionalNumber(parsed, "channel");
    if (channelId === undefined) throw new Error("--channel is required");
    const member = required(parsed, "member");
    const token = requiredToken(parsed);
    const closed = withCoordinationLock((state) => {
      assertMemberToken(state, member, token);
      return closeLeaderChannel(state, member, channelId);
    });
    return JSON.stringify({ ok: true, ...closed });
  }
  // Read-only view, same posture as the dashboard: no token, no mutation.
  if (subcommand === "list") {
    const state = readCoordinationState();
    const pod = optional(parsed, "pod");
    const channels = pod === null
      ? state.leaderChannels
      : state.leaderChannels.filter((channel) => channel.fromPod === pod || channel.toPod === pod);
    if (has(parsed, "json")) return JSON.stringify({ ok: true, channels });
    return channels.map((channel) => `#${channel.id} | ${channel.fromPod} <-> ${channel.toPod} | ${channel.closedAt === null ? "open" : "closed"} | messages ${channel.messageCount} | ${channel.topic}`).join("\n") || "(no channels)";
  }
  throw new Error("pod channel requires open, close, or list");
}

// ADR 0003 D5: the awareness feed is metadata-only — who talked to whom and
// about what, never message content. Read-only, same posture as the dashboard.
// QA il-026 MF-1 defense in depth: even a pre-fix persisted topic containing
// control characters must render on one line; C0 controls and DEL are replaced.
function sanitizeFeedText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, "?");
}

function awarenessCommand(argv: string[]): string {
  const parsed = parseArgs(argv);
  const state = readCoordinationState();
  const pod = optional(parsed, "pod");
  const events = pod === null
    ? state.awarenessEvents
    : state.awarenessEvents.filter((event) => event.pod === pod || event.fromPod === pod || event.toPod === pod);
  if (has(parsed, "json")) return JSON.stringify({ ok: true, events });
  return events.map((event) => {
    const parties = event.pod ?? `${event.fromPod ?? "?"} <-> ${event.toPod ?? "?"}`;
    const detail = sanitizeFeedText(event.topic ?? event.member ?? "");
    const count = event.messageCount === undefined ? "" : ` | messages ${event.messageCount}`;
    return `#${event.id} | ${event.createdAt} | ${event.kind} | ${parties}${detail === "" ? "" : ` | ${detail}`}${count}`;
  }).join("\n") || "(no awareness events)";
}

function readPodTemplate(path: string): ReturnType<typeof parsePodTemplate> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read pod template ${path}: ${message(error)}`);
  }
  try {
    return parsePodTemplate(JSON.parse(text));
  } catch (error) {
    throw new Error(`invalid pod template ${path}: ${message(error)}`);
  }
}

function orchestratorCommand(argv: string[]): string {
  if (argv[0] !== "init") throw new Error("orchestrator requires init");
  const parsed = parseArgs(argv.slice(1));
  const provisioned = provisionOrchestrator({ rotate: has(parsed, "rotate") });
  return JSON.stringify({ ok: true, orchestrator: ORCHESTRATOR_MEMBER, token: provisioned.token, rotated: provisioned.rotated });
}

function stateCommand(argv: string[]): string {
  if (argv[0] !== "migrate") throw new Error("state requires migrate");
  const parsed = parseArgs(argv.slice(1));
  const migrated = migrateLegacyCoordinationState(required(parsed, "legacy-pod"), required(parsed, "legacy-leader"));
  return JSON.stringify({ ok: true, pod: migrated.pod, members: migrated.members });
}

function taskCommand(argv: string[]): string {
  const subcommand = argv[0];
  const parsed = parseArgs(argv.slice(1));
  if (subcommand === "add") {
    const id = validateTaskId(required(parsed, "id"));
    const pane = validatePaneName(required(parsed, "pane"));
    const token = requiredToken(parsed);
    const task = withCoordinationLock((state) => {
      assertMemberToken(state, pane, token);
      if (state.tasks.some((candidate) => candidate.id === id)) throw new Error(`task ${id} already exists`);
      const now = new Date().toISOString();
      const ownerPane = optional(parsed, "owner-pane");
      if (ownerPane !== null) validatePaneName(ownerPane, "owner pane");
      const task: CoordinationTask = { id, title: required(parsed, "title"), businessValue: required(parsed, "value"), workspace: optional(parsed, "workspace"), ownerPane, stage: "open", claimer: null, blocker: null, createdAt: now, lastProgressAt: now, revision: 1 };
      state.tasks.push(task);
      return task;
    });
    return JSON.stringify({ ok: true, task });
  }
  if (subcommand === "list") {
    const state = readCoordinationState();
    if (has(parsed, "json")) return JSON.stringify({ ok: true, tasks: state.tasks });
    return state.tasks.map((task) => `${task.id} | ${task.stage} | ${task.claimer ?? "unclaimed"} | ${task.businessValue} | ${task.title}`).join("\n") || "(no tasks)";
  }
  const id = validateTaskId(argv[1] ?? "");
  if (!id) throw new Error(`task ${subcommand ?? ""} requires an id`);
  const pane = validatePaneName(required(parsed, "pane"));
  const token = requiredToken(parsed);
  if (subcommand === "reap" || subcommand === "release") {
    const deadClaimer = validatePaneName(required(parsed, "dead-claimer"), "dead claimer");
    const task = withCoordinationLock((state) => {
      assertMemberToken(state, pane, token);
      if (deadClaimer === pane) throw new Error("operator pane cannot reap itself");
      const candidate = findTask(state, id);
      if (candidate.claimer !== deadClaimer) throw new Error("task " + id + " is not claimed by " + deadClaimer);
      const session = state.sessions.find((value) => value.pane === deadClaimer);
      if (session === undefined) throw new Error("dead claimer " + deadClaimer + " has no registered session");
      // Staleness is never a death input: lastSeenAt only advances on session set,
      // so a live but quiet claimer would be wrongfully displaced. Reap requires
      // the claimer session to be verifiably finished (state done).
      if (session.state !== "done") throw new Error("dead claimer " + deadClaimer + " must be done before reap");
      candidate.claimer = null;
      candidate.stage = "open";
      candidate.blocker = null;
      candidate.revision += 1;
      candidate.lastProgressAt = new Date().toISOString();
      return { ...candidate, reapReason: "session-done" };
    });
    return JSON.stringify({ ok: true, task });
  }
  if (subcommand === "claim") {
    return JSON.stringify({ ok: true, task: withCoordinationLock((state) => {
      assertMemberToken(state, pane, token);
      const task = findTask(state, id);
      if (task.stage !== "open" || task.claimer !== null) {
        throw new Error(`claim_conflict: task ${id} is ${task.stage}, claimed by ${task.claimer ?? "unknown"} (revision ${task.revision})`);
      }
      task.claimer = pane; task.stage = "claimed"; task.revision += 1; task.lastProgressAt = new Date().toISOString();
      return { ...task };
    }) });
  }
  if (subcommand === "progress") {
    return JSON.stringify({ ok: true, task: withCoordinationLock((state) => {
      assertMemberToken(state, pane, token);
      const task = ownedTask(state, id, pane); if (task.stage === "claimed") task.stage = "in-progress"; task.revision += 1; task.lastProgressAt = new Date().toISOString(); return { ...task };
    }) });
  }
  if (subcommand === "stage") {
    const stage = argv[2] as TaskStage | undefined;
    if (!stage || !TASK_STAGES.includes(stage)) throw new Error(`task stage must be one of ${TASK_STAGES.join("|")}`);
    const result = withCoordinationLock((state) => {
      assertMemberToken(state, pane, token);
      const task = ownedTask(state, id, pane); task.stage = stage; task.revision += 1; task.lastProgressAt = new Date().toISOString();
      const digests = stage === "done" ? deliverDigests(state, "task-done") : [];
      return { task: { ...task }, digests };
    });
    return JSON.stringify({ ok: true, ...result });
  }
  throw new Error(`unknown task command: ${subcommand}`);
}

function sendCommand(argv: string[]): string {
  const parsed = parseArgs(argv);
  const result = withCoordinationLock((state) => {
    const fromPane = validatePaneName(required(parsed, "from-pane"), "sender pane");
    assertMemberToken(state, fromPane, requiredToken(parsed));
    const replyTo = optionalNumber(parsed, "reply");
    const parent = replyTo === undefined ? undefined : state.messages.find((message) => message.id === replyTo);
    if (replyTo !== undefined && parent === undefined) throw new Error(`unknown message #${replyTo}`);
    if (parent && parent.toPane !== fromPane) throw new Error("reply sender " + fromPane + " is not the addressed pane " + parent.toPane);
    const toPane = parent?.fromPane ?? validatePaneName(required(parsed, "to-pane"), "recipient pane");
    const channelId = optionalNumber(parsed, "channel");
    // ADR 0003 D4: the routing boundary is enforced by mechanism, immediately
    // after token authentication and before any state mutation, through the
    // single pre-send evaluation seam (see evaluatePreSend in pods.ts).
    evaluatePreSend(state, fromPane, toPane, channelId);
    const id = state.nextMessageId++;
    const now = new Date().toISOString();
    const message: CoordinationMessage = { id, threadId: parent?.threadId ?? id, replyTo: replyTo ?? null, fromPane, toPane, workspace: optional(parsed, "workspace"), text: required(parsed, "text"), state: "queued", claimer: null, createdAt: now };
    if (parent && (parent.state === "queued" || parent.state === "claimed")) parent.state = "handled";
    state.messages.push(message);
    // The send cleared the boundary: a channel send counts toward the channel's
    // closing message count (R11). Intra-pod sends never carry a channel id.
    if (channelId !== undefined) {
      const channel = state.leaderChannels.find((candidate) => candidate.id === channelId)!;
      channel.messageCount += 1;
    }
    const digests = deliverDigests(state, "watcher-heartbeat");
    return { message, digests };
  });
  return JSON.stringify({ ok: true, ...result });
}

function inboxCommand(argv: string[]): string {
  const parsed = parseArgs(argv);
  const state = readCoordinationState();
  const pane = validatePaneName(required(parsed, "pane"));
  assertMemberToken(state, pane, requiredToken(parsed));
  const messages = state.messages.filter((message) => message.toPane === pane && (has(parsed, "all") || message.state === "queued" || message.state === "claimed"));
  const digests = state.digests.filter((digest) => digest.pane === pane);
  if (has(parsed, "json")) return JSON.stringify({ ok: true, pane, messages, digests });
  const lines = [`INBOX ${pane}`, ...messages.map((message) => `#${message.id} ${message.state} ${message.fromPane} -> ${message.toPane}: ${message.text}`), "DIGEST DELIVERIES", ...digests.map((digest) => `#${digest.id} ${digest.reason} messages=${digest.messageIds.map((id) => `#${id}`).join(",")} file=${digest.file}`)];
  return `${lines.join("\n")}\n`;
}

function sessionCommand(argv: string[]): string {
  if (argv[0] === "register") {
    const parsed = parseArgs(argv.slice(1));
    const pane = validatePaneName(required(parsed, "pane"));
    const token = requiredToken(parsed);
    const registered = withCoordinationLock((state) => {
      registerMemberToken(state, pane, token);
      return pane;
    });
    return JSON.stringify({ ok: true, pane: registered, registered: true });
  }
  if (argv[0] !== "set") throw new Error("session requires set or register");
  const parsed = parseArgs(argv.slice(1));
  const pane = validatePaneName(required(parsed, "pane"));
  const token = requiredToken(parsed);
  const sessionState = required(parsed, "state") as SessionState;
  if (!["idle", "busy", "done"].includes(sessionState)) throw new Error("session state must be idle|busy|done");
  const result = withCoordinationLock((state) => {
    assertMemberToken(state, pane, token);
    const now = new Date().toISOString();
    const existing = state.sessions.find((session) => session.pane === pane);
    if (existing) { existing.state = sessionState; existing.lastSeenAt = now; } else state.sessions.push({ pane, state: sessionState, lastSeenAt: now });
    const digests = sessionState === "idle" || sessionState === "done" ? deliverDigests(state, sessionState === "done" ? "agent-done" : "agent-idle") : [];
    return { session: state.sessions.find((session) => session.pane === pane), digests };
  });
  return JSON.stringify({ ok: true, ...result });
}

function watchCommand(argv: string[]): string {
  const parsed = parseArgs(argv);
  if (!has(parsed, "once")) throw new Error("watch requires --once; use a timer or service to invoke the heartbeat");
  const result = withCoordinationLock((state) => { state.lastWatchAt = new Date().toISOString(); const digests = deliverDigests(state, "watcher-heartbeat"); return { heartbeatAt: state.lastWatchAt, digests }; });
  return JSON.stringify({ ok: true, digested: result.digests.length, messageIds: result.digests.flatMap((digest) => digest.messageIds), ...result });
}

function dashboardCommand(argv: string[]): string {
  const parsed = parseArgs(argv);
  if (!has(parsed, "once") && !has(parsed, "json")) throw new Error("dashboard requires --once");
  const view = buildDashboardView(readCoordinationState());
  return has(parsed, "json") ? JSON.stringify(view) : renderDashboard(view);
}

function compactCommand(): string {
  return JSON.stringify({ ok: true, ...withCoordinationLock((state) => compactTerminalRecords(state)) });
}

// Drops terminal messages (handled/closed) and digests that no longer cover a
// retained message. nextMessageId and nextDigestId are never lowered, so the
// persisted counters remain the id high-water mark even when every record of a
// kind is removed.
function compactTerminalRecords(state: CoordinationState): { removedMessages: number; removedDigests: number; keptMessages: number; keptDigests: number } {
  const keptMessages = state.messages.filter((message) => message.state !== "handled" && message.state !== "closed");
  const keptIds = new Set(keptMessages.map((message) => message.id));
  const keptDigests = state.digests.filter((digest) => digest.messageIds.some((id) => keptIds.has(id)));
  const removedDigestFiles = state.digests.filter((digest) => !digest.messageIds.some((id) => keptIds.has(id))).map((digest) => digest.file);
  const removedMessages = state.messages.length - keptMessages.length;
  const removedDigests = state.digests.length - keptDigests.length;
  state.messages = keptMessages;
  state.digests = keptDigests;
  for (const file of removedDigestFiles) removeDigestFile(file);
  return { removedMessages, removedDigests, keptMessages: keptMessages.length, keptDigests: keptDigests.length };
}

function removeDigestFile(file: string): void {
  try { unlinkSync(file); } catch (error) { if (!isNodeError(error) || error.code !== "ENOENT") throw error; }
}

function deliverDigests(state: CoordinationState, reason: DigestDelivery["reason"]): DigestDelivery[] {
  const delivered = new Set(state.digests.flatMap((digest) => digest.messageIds));
  const byPane = new Map<string, CoordinationMessage[]>();
  for (const message of state.messages) {
    if (message.state !== "queued" || delivered.has(message.id)) continue;
    const messages = byPane.get(message.toPane) ?? []; messages.push(message); byPane.set(message.toPane, messages);
  }
  const deliveries: DigestDelivery[] = [];
  for (const [pane, messages] of byPane) {
    const session = state.sessions.find((candidate) => candidate.pane === pane);
    if (!session || session.state !== "idle") continue;
    const id = state.nextDigestId++;
    deliveries.push(writeDigestDelivery(state, { id, pane, messageIds: messages.map((message) => message.id), reason, createdAt: new Date().toISOString() }, messages));
  }
  return deliveries;
}

function findTask(state: CoordinationState, id: string): CoordinationTask { const task = state.tasks.find((candidate) => candidate.id === id); if (!task) throw new Error(`unknown task ${id}`); return task; }
function ownedTask(state: CoordinationState, id: string, pane: string): CoordinationTask { const task = findTask(state, id); if (task.claimer !== pane) throw new Error(`task ${id} is owned by ${task.claimer ?? "nobody"}; pane ${pane} cannot mutate it`); return task; }
function parseArgs(argv: string[]): Map<string, string | true> { const values = new Map<string, string | true>(); for (let index = 0; index < argv.length; index += 1) { const value = argv[index]!; if (!value.startsWith("--")) { values.set(`$${index}`, value); continue; } const name = value.slice(2); const next = argv[index + 1]; if (next !== undefined && !next.startsWith("--")) { values.set(name, next); index += 1; } else values.set(name, true); } return values; }
function required(values: Map<string, string | true>, name: string): string { const value = values.get(name); if (typeof value !== "string" || value.trim() === "") throw new Error(`--${name} is required`); return value; }
function optional(values: Map<string, string | true>, name: string): string | null { const value = values.get(name); return typeof value === "string" && value.trim() !== "" ? value : null; }
function requiredToken(values: Map<string, string | true>): string { const value = optional(values, "token") ?? process.env.INTERLOCK_PANE_TOKEN; if (value === undefined || value.trim() === "") throw new Error("--token is required (or set INTERLOCK_PANE_TOKEN)"); return value; }
function optionalNumber(values: Map<string, string | true>, name: string): number | undefined { const value = optional(values, name); if (value === null) return undefined; const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`); return parsed; }
function has(values: Map<string, string | true>, name: string): boolean { return values.has(name); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
