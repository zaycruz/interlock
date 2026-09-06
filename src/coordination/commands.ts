import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { has, optional, optionalNumber, parseArgs, required, requiredToken } from "./args.js";
import { deliverDigests } from "./digest.js";
import { inboxSummary } from "./inbox-summary.js";
import { sendCommand } from "./message-send.js";
import { taskCommand } from "./task-commands.js";
import { appointPod, assertMessageStageTransition, closeLeaderChannel, closePod, createPod, evaluateSuccession, openLeaderChannel, parsePodTemplate, rebindMemberProcess, recordLeaderDone } from "./pods.js";
import { buildDashboardView, renderDashboard } from "./render.js";
import { assertMemberToken, assertOrchestratorToken, migrateLegacyCoordinationState, ORCHESTRATOR_MEMBER, provisionOrchestrator, readCoordinationState, registerMemberToken, withCoordinationLock, writeDigestDeliveryFile } from "./state.js";
import type { CoordinationMessage, CoordinationState, MessageStage, SessionState } from "./types.js";
import { validateMemberName, validatePaneName } from "./validation.js";
import { sessionProcessIdentityFor } from "../core/process-identity.js";
import { refreshAllPendingStatus, refreshPendingStatus } from "./pending-status.js";

export interface CoordinationCliResult { exitCode: number; stdout: string; stderr: string; }

const COMMANDS = new Set(["task", "send", "inbox", "session", "watch", "dashboard", "compact", "orchestrator", "state", "pod"]);

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
    "  Set INTERLOCK_PANE_TOKEN for authenticated commands. Use --token <token> to override it.",
    "  interlock session register --pane <pane>",
    "  interlock task add --id <id> --title <title> --value <business-value> --pane <pane> [--workspace <path>] [--owner-pane <pane>]",
    "  interlock task add --id <id> --pane <pane> --workspace <worktree> --contract <json> [--owner-pane <pane>]",
    "    Contract JSON: {\"beadId\":\"issue-id\",\"paths\":[\"src/file.ts\"],\"checks\":[{\"criterion\":\"Exact acceptance item\",\"command\":[\"npm\",\"test\"],\"timeoutMs\":300000}]}",
    "    Beads supplies the linked title, value, and acceptance. Use exact repository-relative paths.",
    "  interlock task list [--json]",
    "  interlock task inspect <id> --pane <pane>",
    "  interlock task resume [id] --pane <pane>",
    "  interlock task claim <id> --pane <pane> [--session-pid <pid>]  (linked tasks require the caller or ancestor PID)",
    "  interlock task progress <id> --pane <pane>",
    "  interlock task checkpoint <id> --pane <pane> --text <checkpoint>",
    "  interlock task block <id> --pane <pane> --reason <reason>",
    "  interlock task heartbeat <id> --pane <pane> [--contract-id <id>]  (linked execution)",
    "  interlock task complete <id> --pane <pane> [--contract-id <id>] [--result <json>]",
    "    Linked completion requires result JSON: {\"summary\":\"Result\",\"artifacts\":[\"path-or-url\"]}. Captured checks must pass.",
    "  interlock task release <id> --pane <pane> [--contract-id <id>] [--reason <reason>]  (linked release requires a reason)",
    "  interlock task resolve <id> --pane <pane> [--contract-id <id>]  (resolve a pending linked operation)",
    "  interlock task recover <id> --pane <pane> [--contract-id <id>] [--reason <reason>]  (requires verified execution death)",
    "  interlock task update <id> --pane <pane> --revision <n> [--title <title>] [--value <value>] [--workspace <path>] [--owner-pane <pane>] [--contract <json>]",
    "  interlock task withdraw <id> --pane <pane> --revision <n> --reason <reason>",
    "    Update and withdraw require open unclaimed work. Read the current revision with task inspect.",
    "  interlock task stage <id> <open|claimed|in-progress|blocked|done|closed> --pane <pane>  (linked tasks permit only in-progress or blocked)",
    "  interlock task reap <id> --pane <operator-pane> --dead-claimer <pane>  (unlinked tasks; claimer session must be done)",
    "  interlock send --from-pane <pane> (--to-pane <pane> | --reply <message-id>) --text <text> [--workspace <ws>] [--channel <id>] [--task <id>] [--request-id <key>]",
    "    Reuse a request ID only for the same payload. Replies inherit the task.",
    "  interlock inbox --pane <pane> [--all] [--thread <id>] [--task <id>] [--json]",
    "    Thread and task filters include terminal history addressed to this pane.",
    "  interlock inbox summary --pane <pane>  (read-only counts and at most 20 digest pointers)",
    "  interlock inbox claim --message <id> --pane <pane>",
    "  interlock inbox close --message <id> --pane <pane>",
    "  interlock session set --pane <pane> --state <idle|busy|done>",
    "  interlock watch --once",
    "  interlock dashboard --once [--json]",
    "  interlock compact",
    "  interlock orchestrator init [--rotate]  (operator: mint the orchestrator token, printed once; --rotate replaces a lost token)",
    "  interlock state migrate --legacy-pod <name> --legacy-leader <pane>  (operator: one-time version-1 upgrade; run orchestrator init first)",
    "  interlock pod create --name <pod> --template <file> --orchestrator-token <token>  (member tokens are printed once)",
    "  interlock pod appoint --pod <pod> (--leader <member> | --member <name> [--role <leader|worker>] [--no-succession]) --orchestrator-token <token>",
    "  interlock pod close --pod <pod> --orchestrator-token <token>",
    "  interlock pod rebind --member <member> [--pid <pid>]  (verified-dead identity only; binds the caller or an ancestor process)",
    "  interlock pod list [--json]",
    "  interlock pod show --pod <pod> [--json]",
    "  interlock pod channel open --pod <pod> --to-pod <pod> --member <leader> --topic <topic>  (topic required, max 140 chars)",
    "  interlock pod channel close --channel <id> --member <leader>",
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
  return maintenanceCommand(argv);
}

function maintenanceCommand(argv: string[]): string {
  const command = argv[0];
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
  if (subcommand === "create") return createPodCommand(parsed);
  if (subcommand === "close") return closePodCommand(parsed);
  if (subcommand === "appoint") return appointPodCommand(parsed);
  if (subcommand === "rebind") return rebindPodCommand(parsed);
  if (subcommand === "list") return listPodCommand(parsed);
  if (subcommand === "show") return showPodCommand(parsed);
  throw new Error("pod requires create, appoint, close, rebind, list, or show");
}

function createPodCommand(parsed: ReturnType<typeof parseArgs>): string {
  const name = required(parsed, "name");
  const template = readPodTemplate(required(parsed, "template"));
  const orchestratorToken = required(parsed, "orchestrator-token");
  const created = withCoordinationLock((state) => {
    assertOrchestratorToken(state, orchestratorToken);
    return createPod(state, name, template);
  });
  return JSON.stringify({ ok: true, ...created, notice: "member tokens are printed exactly once; distribute them to member processes out of band" });
}

function closePodCommand(parsed: ReturnType<typeof parseArgs>): string {
  const name = required(parsed, "pod");
  const orchestratorToken = required(parsed, "orchestrator-token");
  const closed = withCoordinationLock((state) => {
    assertOrchestratorToken(state, orchestratorToken);
    const result = closePod(state, name);
    // Closing deregisters members; converge the nudge files now so no
    // dead pane advertises pending work until the next watch.
    refreshAllPendingStatus(state);
    return result;
  });
  return JSON.stringify({ ok: true, ...closed });
}

function appointPodCommand(parsed: ReturnType<typeof parseArgs>): string {
  const name = required(parsed, "pod");
  const orchestratorToken = required(parsed, "orchestrator-token");
  const leader = optional(parsed, "leader");
  const member = optional(parsed, "member");
  if ((leader === null) === (member === null)) throw new Error("pod appoint requires exactly one of --leader or --member");
  if (leader !== null && (has(parsed, "role") || has(parsed, "no-succession"))) throw new Error("--role and --no-succession apply only when adding --member");
  const role = optional(parsed, "role") ?? "worker";
  if (role !== "leader" && role !== "worker") throw new Error("--role must be leader or worker");
  const appointed = withCoordinationLock((state) => {
    assertOrchestratorToken(state, orchestratorToken);
    return leader !== null
      ? appointPod(state, name, { leader })
      : appointPod(state, name, { member: member!, role, succession: !has(parsed, "no-succession") });
  });
  return JSON.stringify({ ok: true, ...appointed, notice: Object.keys(appointed.tokens).length === 0 ? undefined : "member tokens are printed exactly once; distribute them to member processes out of band" });
}

function rebindPodCommand(parsed: ReturnType<typeof parseArgs>): string {
  const member = validateMemberName(required(parsed, "member"));
  const token = requiredToken(parsed);
  // ADR 0003 D6 (MF-A): the rebind binds the calling process's own identity
  // engine-side. An optional --pid names the caller or one of its ancestors
  // (the il-8o3 session guard); a foreign pid is rejected, so a stolen token
  // can never pin the member to an unrelated or immortal process.
  const pidArg = optionalNumber(parsed, "pid");
  const identity = pidArg === undefined ? sessionProcessIdentityFor(process.pid) : sessionProcessIdentityFor(pidArg);
  const rebound = withCoordinationLock((state) => {
    assertMemberToken(state, member, token);
    return rebindMemberProcess(state, member, identity);
  });
  return JSON.stringify({ ok: true, member: rebound });
}

function listPodCommand(parsed: ReturnType<typeof parseArgs>): string {
  const state = readCoordinationState();
  if (has(parsed, "json")) return JSON.stringify({ ok: true, pods: state.pods });
  return state.pods.map((pod) => `${pod.name} | ${pod.status} | leader ${pod.leader} | members ${state.podMembers.filter((member) => member.pod === pod.name).length}`).join("\n") || "(no pods)";
}

function showPodCommand(parsed: ReturnType<typeof parseArgs>): string {
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

function inboxCommand(argv: string[]): string {
  if (argv[0] === "summary") return inboxSummary(argv.slice(1));
  const subcommand = argv[0];
  if (subcommand === "claim" || subcommand === "close") {
    // il-2t8: claimed and closed were unreachable through the CLI. The
    // addressed pane claims its own queued mail and closes out claimed or
    // handled mail; the matrix forbids resurrecting terminal messages.
    const target: MessageStage = subcommand === "claim" ? "claimed" : "closed";
    const parsed = parseArgs(argv.slice(1));
    const pane = validatePaneName(required(parsed, "pane"));
    const token = requiredToken(parsed);
    const id = optionalNumber(parsed, "message");
    if (id === undefined) throw new Error("--message is required");
    const result = withCoordinationLock((state) => {
      assertMemberToken(state, pane, token);
      const found = state.messages.find((candidate) => candidate.id === id);
      if (found === undefined) throw new Error(`unknown message #${id}`);
      if (found.toPane !== pane) throw new Error(`message #${id} is not addressed to ${pane}`);
      assertMessageStageTransition(found.id, found.state, target);
      found.state = target;
      if (pane !== ORCHESTRATOR_MEMBER) { try { refreshPendingStatus(state, pane); } catch { /* sweep repairs */ } }
      return { ...found };
    });
    return JSON.stringify({ ok: true, message: result });
  }
  const parsed = parseArgs(argv);
  const pane = validatePaneName(required(parsed, "pane"));
  const token = requiredToken(parsed);
  const result = withCoordinationLock((state) => {
    assertMemberToken(state, pane, token);
    const messages = selectInboxMessages(state, parsed, pane);
    const digests = state.digests.filter((digest) => digest.pane === pane);
    // il-yhw: a digest whose delivery file was lost to a partial failure is
    // still the durable record. Repair it inside the lock — the file is
    // idempotently keyed by digest id, so rewriting converges instead of
    // duplicating — and surface it as redelivered. Running under the lock is
    // what keeps a concurrent send from being erased by a stale snapshot.
    const repaired: number[] = [];
    for (const digest of digests) {
      if (existsSync(digest.file)) continue;
      writeDigestDeliveryFile(digest, state.messages.filter((message) => digest.messageIds.includes(message.id)));
      repaired.push(digest.id);
    }
    return { messages, digests, repaired };
  });
  const { messages, digests } = result;
  const repaired = result.repaired;
  if (has(parsed, "json")) return JSON.stringify({ ok: true, pane, messages, digests, redelivered: repaired });
  const lines = [`INBOX ${pane}`, ...messages.map((message) => `#${message.id} ${message.state} ${message.fromPane} -> ${message.toPane}: ${message.text}`), "DIGEST DELIVERIES", ...digests.map((digest) => `#${digest.id} ${digest.reason} messages=${digest.messageIds.map((id) => `#${id}`).join(",")} file=${digest.file}`)];
  return `${lines.join("\n")}\n`;
}

function selectInboxMessages(state: CoordinationState, parsed: ReturnType<typeof parseArgs>, pane: string): CoordinationMessage[] {
  const thread = optionalNumber(parsed, "thread");
  const task = optional(parsed, "task");
  const history = has(parsed, "all") || thread !== undefined || task !== null;
  return state.messages.filter((message) => {
    if (message.toPane !== pane) return false;
    if (thread !== undefined && message.threadId !== thread) return false;
    if (task !== null && message.taskId !== task) return false;
    return history || message.state === "queued" || message.state === "claimed";
  });
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
    // ADR 0003 D6 (R14, MF-C): a leader reporting done fires leader-done and
    // sheds external reach (its open channels close) without promoting anyone.
    if (sessionState === "done") recordLeaderDone(state, pane);
    const digests = sessionState === "idle" || sessionState === "done" ? deliverDigests(state, sessionState === "done" ? "agent-done" : "agent-idle") : [];
    return { session: state.sessions.find((session) => session.pane === pane), digests };
  });
  return JSON.stringify({ ok: true, ...result });
}

function watchCommand(argv: string[]): string {
  const parsed = parseArgs(argv);
  if (!has(parsed, "once")) throw new Error("watch requires --once; use a timer or service to invoke the heartbeat");
  const result = withCoordinationLock((state) => {
    state.lastWatchAt = new Date().toISOString();
    // ADR 0003 D6: the watch sweep is an evaluation point for leader death,
    // alongside the lazy pre-send evaluation in evaluatePreSend.
    for (const pod of state.pods) evaluateSuccession(state, pod.leader);
    const digests = deliverDigests(state, "watcher-heartbeat");
    // U1: the sweep doubles as the pending-status repair path — it restores a
    // file lost to any cause and gives every registered pane (zero-count
    // included) its first record, satisfying R9's registration coverage.
    refreshAllPendingStatus(state);
    return { heartbeatAt: state.lastWatchAt, digests };
  });
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

// Retain task and retry history. Keep counters monotonic when other records expire.
function compactTerminalRecords(state: CoordinationState): { removedMessages: number; removedDigests: number; keptMessages: number; keptDigests: number } {
  // Retain task history and retry threads so receipts retain their reply context.
  const retainedThreads = new Set(state.messages.filter((message) => message.taskId !== undefined || message.requestId !== undefined).map((message) => message.threadId));
  const keptMessages = state.messages.filter((message) => retainedThreads.has(message.threadId) || (message.state !== "handled" && message.state !== "closed"));
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
