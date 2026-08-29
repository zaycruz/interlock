// U1: the engine-owned pending-status record. A per-pane, count-only file
// under $INTERLOCK_STATE_DIR/pending/ so any host can surface an "N pending"
// nudge (R9-R13). The coordination layer is the only writer: freshness has to
// survive the moment the agent stops looking, which is exactly when the nudge
// matters. Content rule (R11/AE5): counts and timestamps only — never message
// text, senders, or topics.
import { existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";

import { coordinationPendingDir, ORCHESTRATOR_MEMBER } from "./state.js";
import type { CoordinationState } from "./types.js";

export interface PendingStatus {
  version: number;
  pane: string;
  pending: number;
  oldestPendingAt: string | null;
  updatedAt: string;
}

function pendingStatusPath(pane: string): string {
  // Pane names are filesystem-safe by construction — validateCoordinationName
  // restricts the charset and rejects '..' — so the name needs no escaping.
  return join(coordinationPendingDir(), `${pane}.json`);
}

function derivePendingStatus(state: CoordinationState, pane: string): PendingStatus {
  const pendingMessages = state.messages.filter((message) => message.toPane === pane && (message.state === "queued" || message.state === "claimed"));
  let oldest: string | null = null;
  for (const message of pendingMessages) if (oldest === null || message.createdAt < oldest) oldest = message.createdAt;
  return { version: 1, pane, pending: pendingMessages.length, oldestPendingAt: oldest, updatedAt: new Date().toISOString() };
}

// Converge-on-rewrite (never increment/decrement): every refresh writes the
// whole derived record, so drift from a crash between the state commit and
// this write self-heals on the pane's next operation or the next sweep. The
// temp-file + rename shape mirrors writeStateFile so a host reading the file
// concurrently never observes a torn record. Callers MUST already hold the
// coordination lock — that is what keeps status writes racing-free (KTD4).
export function refreshPendingStatus(state: CoordinationState, pane: string): void {
  const record = derivePendingStatus(state, pane);
  mkdirSync(coordinationPendingDir(), { recursive: true });
  const target = pendingStatusPath(pane);
  const temporaryPath = `${target}.tmp.${process.pid}`;
  const descriptor = openSync(temporaryPath, "w", 0o600);
  try {
    writeSync(descriptor, JSON.stringify(record, null, 2));
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, target);
}

// The watch sweep converges the whole directory (repair + registration
// coverage in one pass): every registered pane gets its derived record —
// zero-count included, because absence means "never swept", not "zero"
// (R9) — and any leftover record for a pane that is no longer registered is
// removed. A closed pod's members keep their messages as history, so a
// stale file would advertise work for a pane that can never authenticate
// again. The orchestrator is a deployment identity, not a pane; it never
// gets a record.
export function refreshAllPendingStatus(state: CoordinationState): void {
  const registered = new Set(Object.keys(state.memberTokens));
  const directory = coordinationPendingDir();
  // Converge the directory: any regular file that is not this engine's own
  // record for a registered pane is junk — a deregistered pane's leftover,
  // a crash-orphaned temp file, or a foreign planted file. rmSync throws on
  // non-file entries (EISDIR), and that throw inside the lock would brick
  // every later watch; so non-file entries are left untouched, not deleted.
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const pane = entry.name.endsWith(".json") ? entry.name.slice(0, -".json".length) : null;
      const orphaned = pane !== null && (pane === ORCHESTRATOR_MEMBER || !registered.has(pane));
      // The refresh write + rename is atomic under the lock, so any visible
      // .tmp.<pid> file belongs to a process that died mid-write.
      if (orphaned || entry.name.includes(".tmp.")) rmSync(join(directory, entry.name), { force: true });
    }
  }
  for (const member of Object.keys(state.memberTokens)) {
    if (member === ORCHESTRATOR_MEMBER) continue;
    refreshPendingStatus(state, member);
  }
}
