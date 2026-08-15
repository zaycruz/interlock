import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CoordinationMessage, CoordinationState, CoordinationTask, CoordinationSession, DigestDelivery } from "./types.js";

const STALE_LOCK_MS = 30_000;

export function coordinationStateDir(): string {
  return process.env.INTERLOCK_STATE_DIR ?? join(homedir(), ".local", "state", "interlock");
}

export function coordinationStatePath(): string { return join(coordinationStateDir(), "state.json"); }
export function coordinationLockPath(): string { return join(coordinationStateDir(), "state.lock"); }
export function coordinationDeliveryDir(): string { return join(coordinationStateDir(), "deliveries"); }

export function emptyCoordinationState(): CoordinationState {
  return { version: 1, nextMessageId: 1, nextDigestId: 1, tasks: [], messages: [], sessions: [], digests: [], lastWatchAt: null };
}

export function readCoordinationState(): CoordinationState {
  try {
    const value: unknown = JSON.parse(readFileSync(coordinationStatePath(), "utf8"));
    return normalizeState(value);
  } catch (error) {
    if (isMissingFile(error)) return emptyCoordinationState();
    throw new Error(`cannot read Interlock coordination state: ${message(error)}`);
  }
}

export function writeCoordinationState(state: CoordinationState): void {
  mkdirSync(coordinationStateDir(), { recursive: true });
  const temporaryPath = `${coordinationStatePath()}.tmp.${process.pid}`;
  writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
  renameSync(temporaryPath, coordinationStatePath());
}

export function withCoordinationLock<T>(operation: (state: CoordinationState) => T): T {
  mkdirSync(coordinationStateDir(), { recursive: true });
  const lock = coordinationLockPath();
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (!isExisting(error)) throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          rmdirSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error("Interlock coordination state lock timeout");
      const pauseUntil = Date.now() + 10;
      while (Date.now() < pauseUntil) { /* bounded mutex backoff */ }
    }
  }
  try {
    const state = readCoordinationState();
    const result = operation(state);
    writeCoordinationState(state);
    return result;
  } finally {
    try { rmdirSync(lock); } catch { /* another process already recovered it */ }
  }
}

export function writeDigestDelivery(state: CoordinationState, digest: Omit<DigestDelivery, "file">, messages: CoordinationMessage[]): DigestDelivery {
  const paneDir = join(coordinationDeliveryDir(), digest.pane);
  mkdirSync(paneDir, { recursive: true });
  const file = join(paneDir, `digest-${digest.id}.json`);
  const delivery: DigestDelivery = { ...digest, file };
  writeFileSync(file, JSON.stringify({ ...delivery, messages }, null, 2));
  state.digests.push(delivery);
  return delivery;
}

function normalizeState(value: unknown): CoordinationState {
  if (!isRecord(value)) throw new Error("state is not an object");
  const state = emptyCoordinationState();
  state.nextMessageId = positiveInteger(value.nextMessageId, 1);
  state.nextDigestId = positiveInteger(value.nextDigestId, 1);
  state.tasks = arrayOf<CoordinationTask>(value.tasks);
  state.messages = arrayOf<CoordinationMessage>(value.messages);
  state.sessions = arrayOf<CoordinationSession>(value.sessions);
  state.digests = arrayOf<DigestDelivery>(value.digests);
  state.lastWatchAt = typeof value.lastWatchAt === "string" ? value.lastWatchAt : null;
  return state;
}

function arrayOf<T>(value: unknown): T[] { return Array.isArray(value) ? structuredClone(value) as T[] : []; }
function positiveInteger(value: unknown, fallback: number): number { return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMissingFile(error: unknown): boolean { return isNodeError(error) && error.code === "ENOENT"; }
function isExisting(error: unknown): boolean { return isNodeError(error) && error.code === "EEXIST"; }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
