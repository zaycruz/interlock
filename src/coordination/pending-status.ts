// U1: the engine-owned pending-status record. A per-pane, count-only file
// under $INTERLOCK_STATE_DIR/pending/ so any host can surface an "N pending"
// nudge (R9-R13). The coordination layer is the only writer: freshness has to
// survive the moment the agent stops looking, which is exactly when the nudge
// matters. Content rule (R11/AE5): counts and timestamps only — never message
// text, senders, or topics.
import { existsSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync, closeSync } from "node:fs";
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
// (R9) — and any leftover regular file that is not a registered pane's
// record is removed: a deregistered pane's leftover (a closed pod's members
// keep their messages as history, so a stale file would advertise work for
// a pane that can never authenticate again), a crash-orphaned temp file, or
// foreign junk. Non-file entries are left untouched, never deleted: rmSync
// throws on them (EISDIR), and a throw inside the coordination lock would
// brick every later watch.
export function refreshAllPendingStatus(state: CoordinationState): void {
  const registered = new Set(Object.keys(state.memberTokens));
  const directory = coordinationPendingDir();
  if (existsSync(directory) && !lstatSync(directory).isDirectory()) {
    // A non-directory at the pending path (operator mistake, tampering)
    // wedges every writer with ENOTDIR/EEXIST. It is foreign by definition;
    // remove it so the refresh loop below can create the real directory.
    rmSync(directory, { force: true });
  }
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const pane = entry.name.endsWith(".json") ? entry.name.slice(0, -".json".length) : null;
      const orphaned = pane !== null && (pane === ORCHESTRATOR_MEMBER || !registered.has(pane));
      // The refresh write + rename is atomic under the lock, so a visible
      // `<x>.json.tmp.<pid>` file belongs to a process that died mid-write.
      // The shape is anchored to the `.json.tmp.` infix so a legitimately
      // named pane containing ".tmp." keeps its own record.
      const staleTemp = entry.name.includes(".json.tmp.");
      if (orphaned || (staleTemp && !registered.has(pane ?? ""))) rmSync(join(directory, entry.name), { force: true });
    }
  }
  for (const member of Object.keys(state.memberTokens)) {
    if (member === ORCHESTRATOR_MEMBER) continue;
    // Per-pane best-effort: one unwritable record (collision, EACCES) must
    // not stop the sweep from converging the other panes.
    try { refreshPendingStatus(state, member); } catch { /* host sees the stale record until the operator clears it */ }
  }
}
