// U1: the engine-owned pending-status record. A per-pane, count-only file
// under $INTERLOCK_STATE_DIR/pending/ so any host can surface an "N pending"
// nudge (R9-R13). The coordination layer is the only writer: freshness has to
// survive the moment the agent stops looking, which is exactly when the nudge
// matters. Content rule (R11/AE5): counts and timestamps only — never message
// text, senders, or topics.
import { mkdirSync, openSync, renameSync, writeSync, closeSync } from "node:fs";
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

// The watch sweep is the repair path for a file lost to any cause, and the
// only writer for a registered pane that never receives mail (R9's "covering
// each pane with a registered identity"). Zero-count files are written too:
// absence means "never swept", not "zero". The orchestrator is a deployment
// identity, not a pane, and is excluded.
export function refreshAllPendingStatus(state: CoordinationState): void {
  for (const member of Object.keys(state.memberTokens)) {
    if (member === ORCHESTRATOR_MEMBER) continue;
    refreshPendingStatus(state, member);
  }
}
