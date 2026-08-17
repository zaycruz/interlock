import type { CoordinationState, DashboardView } from "./types.js";

export function buildDashboardView(state: CoordinationState, now = new Date()): DashboardView {
  const generatedAt = now.toISOString();
  const messages = { total: state.messages.length, queued: 0, claimed: 0, handled: 0, closed: 0 };
  for (const message of state.messages) messages[message.state] += 1;
  return {
    product: "interlock",
    readOnly: true,
    generatedAt,
    watcher: { lastHeartbeatAt: state.lastWatchAt, digestDeliveries: state.digests.length },
    tasks: state.tasks.map((task) => ({ ...task, stale: isStale(task.lastProgressAt, now) && (task.stage === "claimed" || task.stage === "in-progress") })),
    sessions: state.sessions.map((session) => ({ ...session })),
    messages,
    digests: state.digests.map((digest) => ({ ...digest, messageIds: [...digest.messageIds] })),
  };
}

export function renderDashboard(view: DashboardView): string {
  const lines = [
    `INTERLOCK DASHBOARD — read-only — ${view.generatedAt}`,
    `WATCHER — last heartbeat: ${view.watcher.lastHeartbeatAt ?? "never"} | digest deliveries: ${view.watcher.digestDeliveries}`,
    `MESSAGES — total ${view.messages.total} | queued ${view.messages.queued} | claimed ${view.messages.claimed} | handled ${view.messages.handled} | closed ${view.messages.closed}`,
    "",
    "TASKS — id | stage | owner | business value | title",
  ];
  if (view.tasks.length === 0) lines.push("(none)");
  for (const task of view.tasks) {
    lines.push(`${task.id} | ${task.stage}${task.stale ? "!" : ""} | ${task.claimer ?? "unclaimed"} | ${task.businessValue} | ${task.title}`);
  }
  lines.push("", "SESSIONS — pane | state | last seen");
  if (view.sessions.length === 0) lines.push("(none)");
  for (const session of view.sessions) lines.push(`${session.pane} | ${session.state} | ${session.lastSeenAt}`);
  lines.push("", "DIGESTS — id | pane | messages | reason | delivered file");
  if (view.digests.length === 0) lines.push("(none)");
  for (const digest of view.digests) lines.push(`${digest.id} | ${digest.pane} | ${digest.messageIds.map((id) => `#${id}`).join(", ")} | ${digest.reason} | ${digest.file}`);
  return `${lines.join("\n")}\n`;
}

function isStale(timestamp: string, now: Date): boolean {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && now.getTime() - parsed > 15 * 60 * 1000;
}
