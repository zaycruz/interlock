import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CoordinationMessage, CoordinationState, CoordinationTask, CoordinationSession, DigestDelivery } from "./types.js";
import { validatePaneName, validatePaneToken } from "./validation.js";

const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 10;

interface CoordinationLockOwner {
  token: string;
  pid: number;
  acquiredAt: number;
}

export function coordinationStateDir(): string {
  return process.env.INTERLOCK_STATE_DIR ?? join(homedir(), ".local", "state", "interlock");
}

export function coordinationStatePath(): string { return join(coordinationStateDir(), "state.json"); }
export function coordinationLockPath(): string { return join(coordinationStateDir(), "state.lock"); }
export function coordinationDeliveryDir(): string { return join(coordinationStateDir(), "deliveries"); }

export function emptyCoordinationState(): CoordinationState {
  return { version: 1, nextMessageId: 1, nextDigestId: 1, paneTokens: {}, tasks: [], messages: [], sessions: [], digests: [], lastWatchAt: null };
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
  const owner: CoordinationLockOwner = { token: randomUUID(), pid: process.pid, acquiredAt: Date.now() };
  acquireCoordinationLock(lock, owner);
  try {
    const state = readCoordinationState();
    const result = operation(state);
    writeCoordinationState(state);
    return result;
  } finally {
    releaseCoordinationLock(lock, owner.token);
  }
}

export function writeDigestDelivery(state: CoordinationState, digest: Omit<DigestDelivery, "file">, messages: CoordinationMessage[]): DigestDelivery {
  validatePaneName(digest.pane);
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
  state.paneTokens = paneTokens(value.paneTokens);
  state.tasks = arrayOf<CoordinationTask>(value.tasks);
  state.messages = arrayOf<CoordinationMessage>(value.messages);
  state.sessions = arrayOf<CoordinationSession>(value.sessions);
  state.digests = arrayOf<DigestDelivery>(value.digests);
  state.lastWatchAt = typeof value.lastWatchAt === "string" ? value.lastWatchAt : null;
  return state;
}

export function registerPaneToken(state: CoordinationState, pane: string, token: string): void {
  validatePaneName(pane);
  const hash = tokenHash(validatePaneToken(token));
  const existing = state.paneTokens[pane];
  if (existing !== undefined && !safeEqual(existing, hash)) throw new Error("pane " + pane + " is already registered with a different token");
  state.paneTokens[pane] = hash;
}

export function assertPaneToken(state: CoordinationState, pane: string, token: string): void {
  validatePaneName(pane);
  const expected = state.paneTokens[pane];
  if (expected === undefined) throw new Error("pane " + pane + " is not registered; run session register before mutating it");
  const actual = tokenHash(validatePaneToken(token));
  if (!safeEqual(expected, actual)) throw new Error("pane token does not authenticate " + pane);
}

function acquireCoordinationLock(lock: string, owner: CoordinationLockOwner): void {
  const deadline = Date.now() + lockWaitMs();
  for (;;) {
    try {
      const descriptor = openSync(lock, "wx", 0o600);
      try { writeSync(descriptor, JSON.stringify(owner)); } finally { closeSync(descriptor); }
      return;
    } catch (error) {
      if (!isExisting(error)) throw error;
      const existing = readLockOwner(lock);
      if (existing === undefined || !isProcessAlive(existing.pid)) {
        if (existing === undefined) removeLockIfUnowned(lock);
        else removeLockIfOwner(lock, existing.token);
        continue;
      }
      if (Date.now() > deadline) throw new Error("Interlock coordination state lock timeout");
      const pauseUntil = Date.now() + LOCK_POLL_MS;
      while (Date.now() < pauseUntil) { /* bounded mutex backoff */ }
    }
  }
}

function releaseCoordinationLock(lock: string, token: string): void {
  removeLockIfOwner(lock, token);
}

function readLockOwner(lock: string): CoordinationLockOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(lock, "utf8"));
    if (!isRecord(value)) return undefined;
    const token = value.token;
    const pid = value.pid;
    const acquiredAt = value.acquiredAt;
    if (typeof token !== "string" || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof acquiredAt !== "number" || !Number.isFinite(acquiredAt)) return undefined;
    return { token, pid, acquiredAt };
  } catch {
    return undefined;
  }
}

function removeLockIfOwner(lock: string, token: string): void {
  const current = readLockOwner(lock);
  if (current?.token !== token) return;
  try { unlinkSync(lock); } catch (error) { if (!isMissing(error)) throw error; }
}

function removeLockIfUnowned(lock: string): void {
  if (readLockOwner(lock) !== undefined) return;
  try { unlinkSync(lock); } catch (error) { if (!isMissing(error)) throw error; }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function lockWaitMs(): number {
  const configured = Number(process.env.INTERLOCK_COORDINATION_LOCK_TIMEOUT_MS ?? LOCK_WAIT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : LOCK_WAIT_MS;
}

function paneTokens(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("coordination pane tokens are not an object");
  const result: Record<string, string> = {};
  for (const [pane, hash] of Object.entries(value)) {
    validatePaneName(pane);
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("coordination pane token hash for " + pane + " is invalid");
    result[pane] = hash;
  }
  return result;
}

function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
function arrayOf<T>(value: unknown): T[] { return Array.isArray(value) ? structuredClone(value) as T[] : []; }
function positiveInteger(value: unknown, fallback: number): number { return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMissingFile(error: unknown): boolean { return isNodeError(error) && error.code === "ENOENT"; }
function isExisting(error: unknown): boolean { return isNodeError(error) && error.code === "EEXIST"; }
function isMissing(error: unknown): boolean { return isNodeError(error) && error.code === "ENOENT"; }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
