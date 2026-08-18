import { buildDashboardView, renderDashboard } from "./render.js";
import { assertPaneToken, readCoordinationState, registerPaneToken, withCoordinationLock, writeDigestDelivery } from "./state.js";
import type { CoordinationMessage, CoordinationState, CoordinationTask, DigestDelivery, SessionState, TaskStage } from "./types.js";
import { validatePaneName, validateTaskId } from "./validation.js";

export interface CoordinationCliResult { exitCode: number; stdout: string; stderr: string; }

const COMMANDS = new Set(["task", "send", "inbox", "session", "watch", "dashboard"]);
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
    "  interlock send --from-pane <pane> --to-pane <pane> --token <token> --text <text> [--workspace <ws>] [--reply <message-id>]",
    "  interlock inbox --pane <pane> --token <token> [--all] [--json]",
    "  interlock session set --pane <pane> --token <token> --state <idle|busy|done>",
    "  interlock watch --once",
    "  interlock dashboard --once [--json]",
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
  throw new Error(`unknown coordination command: ${command}`);
}

function taskCommand(argv: string[]): string {
  const subcommand = argv[0];
  const parsed = parseArgs(argv.slice(1));
  if (subcommand === "add") {
    const id = validateTaskId(required(parsed, "id"));
    const pane = validatePaneName(required(parsed, "pane"));
    const token = requiredToken(parsed);
    const task = withCoordinationLock((state) => {
      assertPaneToken(state, pane, token);
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
      assertPaneToken(state, pane, token);
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
      assertPaneToken(state, pane, token);
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
      assertPaneToken(state, pane, token);
      const task = ownedTask(state, id, pane); if (task.stage === "claimed") task.stage = "in-progress"; task.revision += 1; task.lastProgressAt = new Date().toISOString(); return { ...task };
    }) });
  }
  if (subcommand === "stage") {
    const stage = argv[2] as TaskStage | undefined;
    if (!stage || !TASK_STAGES.includes(stage)) throw new Error(`task stage must be one of ${TASK_STAGES.join("|")}`);
    const result = withCoordinationLock((state) => {
      assertPaneToken(state, pane, token);
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
    assertPaneToken(state, fromPane, requiredToken(parsed));
    const replyTo = optionalNumber(parsed, "reply");
    const parent = replyTo === undefined ? undefined : state.messages.find((message) => message.id === replyTo);
    if (replyTo !== undefined && parent === undefined) throw new Error(`unknown message #${replyTo}`);
    if (parent && parent.toPane !== fromPane) throw new Error("reply sender " + fromPane + " is not the addressed pane " + parent.toPane);
    const toPane = parent?.fromPane ?? validatePaneName(required(parsed, "to-pane"), "recipient pane");
    const id = state.nextMessageId++;
    const now = new Date().toISOString();
    const message: CoordinationMessage = { id, threadId: parent?.threadId ?? id, replyTo: replyTo ?? null, fromPane, toPane, workspace: optional(parsed, "workspace"), text: required(parsed, "text"), state: "queued", claimer: null, createdAt: now };
    if (parent && (parent.state === "queued" || parent.state === "claimed")) parent.state = "handled";
    state.messages.push(message);
    const digests = deliverDigests(state, "watcher-heartbeat");
    return { message, digests };
  });
  return JSON.stringify({ ok: true, ...result });
}

function inboxCommand(argv: string[]): string {
  const parsed = parseArgs(argv);
  const state = readCoordinationState();
  const pane = validatePaneName(required(parsed, "pane"));
  assertPaneToken(state, pane, requiredToken(parsed));
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
      registerPaneToken(state, pane, token);
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
    assertPaneToken(state, pane, token);
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
    if (!session || (session.state !== "idle" && session.state !== "done")) continue;
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
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
