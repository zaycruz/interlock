import { pods, podMembers, assertSuccessionIntegrity, leaderChannels, awarenessEvents, orchestratorState } from "./state-pods.js";
import { coordinationTasks, coordinationMessages } from "./task-schema.js";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { AWARENESS_FEED_MAX_EVENTS } from "./pods.js";
import type { CoordinationMessage, CoordinationState, CoordinationTask, CoordinationSession, DigestDelivery, Pod, PodMember } from "./types.js";
import { validateCoordinationName, validateMemberName, validateMemberToken, validatePaneName } from "./validation.js";
import { assertSupportedPlatform } from "../core/platform.js";

export const ORCHESTRATOR_MEMBER = "orchestrator";


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
export function coordinationPendingDir(): string { return join(coordinationStateDir(), "pending"); }

export function emptyCoordinationState(): CoordinationState {
  return {
    version: 3, nextMessageId: 1, nextDigestId: 1, nextChannelId: 1, nextAwarenessEventId: 1,
    memberTokens: {}, pods: [], podMembers: [], leaderChannels: [], awarenessEvents: [], orchestrator: null,
    tasks: [], messages: [], sessions: [], digests: [], lastWatchAt: null,
  };
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
  writeStateFile(state);
}

function writeStateFile(state: unknown): void {
  mkdirSync(coordinationStateDir(), { recursive: true });
  removeStaleTemporaryFiles();
  const temporaryPath = `${coordinationStatePath()}.tmp.${process.pid}`;
  const descriptor = openSync(temporaryPath, "w", 0o600);
  try {
    writeSync(descriptor, JSON.stringify(state, null, 2));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, coordinationStatePath());
  fsyncStateDirectory();
}

function fsyncStateDirectory(): void {
  assertSupportedPlatform();
  const descriptor = openSync(coordinationStateDir(), "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function removeStaleTemporaryFiles(): void {
  for (const entry of readdirSync(coordinationStateDir())) {
    if (!entry.startsWith("state.json.tmp.")) continue;
    try { unlinkSync(join(coordinationStateDir(), entry)); } catch (error) { if (!isMissing(error)) throw error; }
  }
}

export function withCoordinationLock<T>(operation: (state: CoordinationState) => T, options?: { commitOnThrow?: boolean }): T {
  mkdirSync(coordinationStateDir(), { recursive: true });
  const lock = coordinationLockPath();
  const owner: CoordinationLockOwner = { token: randomUUID(), pid: process.pid, acquiredAt: Date.now() };
  acquireCoordinationLock(lock, owner);
  try {
    const state = readCoordinationState();
    try {
      const result = operation(state);
      writeCoordinationState(state);
      return result;
    } catch (error) {
      // ADR 0003 D6 (MF-D): a send rejected by the routing boundary can still
      // carry a verified leader death and promotion, which must be committed —
      // death is a fact the engine observed, not a side effect of a successful
      // send. Only the send path opts in; every other rejection stays atomic.
      if (options?.commitOnThrow) writeCoordinationState(state);
      throw error;
    }
  } finally {
    releaseCoordinationLock(lock, owner.token);
  }
}

// Raw read/write inside the coordination lock for operator-level provisioning
// and the one-time version-1 migration, which must run before normalizeState
// can accept the file (ADR 0003 D8).
function withRawCoordinationLock<T>(operation: (raw: Record<string, unknown> | undefined) => { state: unknown; result: T }): T {
  mkdirSync(coordinationStateDir(), { recursive: true });
  const lock = coordinationLockPath();
  const owner: CoordinationLockOwner = { token: randomUUID(), pid: process.pid, acquiredAt: Date.now() };
  acquireCoordinationLock(lock, owner);
  try {
    const { state, result } = operation(readRawCoordinationState());
    writeStateFile(state);
    return result;
  } finally {
    releaseCoordinationLock(lock, owner.token);
  }
}

function readRawCoordinationState(): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(coordinationStatePath(), "utf8"));
    if (!isRecord(value)) throw new Error("state is not an object");
    return value;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new Error(`cannot read Interlock coordination state: ${message(error)}`);
  }
}

// ADR 0003 D3: exactly one orchestrator per deployment, provisioned only here.
// The token is minted engine-side, stored as a sha256 hash, and returned once
// for the operator. A second init refuses because the stored hash differs from
// any fresh mint; --rotate replaces a lost token.
function assertSupportedRawVersion(raw: Record<string, unknown> | undefined): void {
  if (raw !== undefined && raw.version !== 1 && raw.version !== 2 && raw.version !== 3) throw new Error(unsupportedVersionMessage(raw));
}

function requireLegacyState(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  if (raw === undefined) throw new Error("no coordination state exists to migrate");
  if (raw.version === 2 || raw.version === 3) throw new Error("coordination state is already version 2; nothing to migrate");
  if (raw.version !== 1) throw new Error(unsupportedVersionMessage(raw));
  return raw;
}

export function provisionOrchestrator(options: { rotate: boolean }): { token: string; rotated: boolean } {
  return withRawCoordinationLock((raw) => {
    assertSupportedRawVersion(raw);
    const token = randomBytes(32).toString("hex");
    const hash = tokenHash(token);
    const doubleInit = "orchestrator is already initialized; a second init cannot reproduce the printed-once token, use `interlock orchestrator init --rotate` to replace a lost token";
    if (raw === undefined || raw.version === 2 || raw.version === 3) {
      const state = raw === undefined ? emptyCoordinationState() : normalizeState(raw);
      if (state.memberTokens[ORCHESTRATOR_MEMBER] !== undefined && !options.rotate) throw new Error(doubleInit);
      state.memberTokens[ORCHESTRATOR_MEMBER] = hash;
      state.orchestrator = { initializedAt: new Date().toISOString() };
      return { state, result: { token, rotated: options.rotate } };
    }
    // Version-1 file: the ADR D8 order is init first, migrate second, so the
    // provisioning is recorded in the legacy file and state migrate carries
    // it into version 2.
    const legacyTokens = memberTokens(raw.paneTokens);
    if (legacyTokens[ORCHESTRATOR_MEMBER] !== undefined && !options.rotate) throw new Error(doubleInit);
    const state = { ...raw, paneTokens: { ...legacyTokens, [ORCHESTRATOR_MEMBER]: hash }, orchestrator: { initializedAt: new Date().toISOString() } };
    return { state, result: { token, rotated: options.rotate } };
  });
}

// ADR 0003 D8: the one-time version-1 upgrade. Wraps every version-1 pane in a
// single orchestrator-created pod, renames paneTokens to memberTokens, and
// carries messages, tasks, sessions, and digests over unchanged as history.
export function migrateLegacyCoordinationState(legacyPod: string, legacyLeader: string): { pod: Pod; members: PodMember[] } {
  const podName = validateCoordinationName(legacyPod, "pod name");
  const leader = validateCoordinationName(legacyLeader, "legacy leader");
  // The reserved orchestrator name is never a valid pod leader: init inserts
  // the orchestrator hash into the same token map migrate reads, so the
  // "registered version-1 pane" check below would pass for it and produce a
  // leaderless pod (every real member demoted to worker).
  if (leader === ORCHESTRATOR_MEMBER) {
    throw new Error("legacy leader orchestrator is reserved for the orchestrator; a pod leader must be a version-1 pane member");
  }
  return withRawCoordinationLock((raw) => {
    const legacy = requireLegacyState(raw);
    const tokens = memberTokens(legacy.paneTokens);
    if (tokens[ORCHESTRATOR_MEMBER] === undefined) {
      throw new Error("orchestrator is not initialized; migration creates a pod and pod creation requires the orchestrator, run `interlock orchestrator init` first");
    }
    if (tokens[leader] === undefined) throw new Error("legacy leader " + leader + " is not a registered version-1 pane");
    const tasks = arrayOf<CoordinationTask>(legacy.tasks);
    const messages = arrayOf<CoordinationMessage>(legacy.messages);
    const sessions = arrayOf<CoordinationSession>(legacy.sessions);
    const digests = arrayOf<DigestDelivery>(legacy.digests);
    const now = new Date().toISOString();
    const names = Object.keys(tokens).filter((name) => name !== ORCHESTRATOR_MEMBER).sort();
    const pod: Pod = { name: podName, createdAt: now, leader, succession: [leader, ...names.filter((name) => name !== leader)], status: "open", closedAt: null };
    const members: PodMember[] = names.map((member) => ({ member, pod: podName, role: member === leader ? "leader" as const : "worker" as const, process: null, registeredAt: now, diedAt: null, doneAt: null }));
    // Schema invariant: the leader is a pod member and exactly one member holds the leader role.
    const leaders = members.filter((member) => member.role === "leader");
    if (leaders.length !== 1 || leaders[0]!.member !== leader) throw new Error("internal: migration must produce a pod with exactly one leader-role member");
    const state = emptyCoordinationState();
    state.memberTokens = tokens;
    state.pods = [pod];
    state.podMembers = members;
    state.tasks = tasks;
    state.messages = messages;
    state.sessions = sessions;
    state.digests = digests;
    state.lastWatchAt = typeof legacy.lastWatchAt === "string" ? legacy.lastWatchAt : null;
    state.nextMessageId = idCounter(legacy.nextMessageId, highestId(messages, "message"));
    state.nextDigestId = idCounter(legacy.nextDigestId, highestId(digests, "digest"));
    state.orchestrator = { initializedAt: isRecord(legacy.orchestrator) && typeof legacy.orchestrator.initializedAt === "string" ? legacy.orchestrator.initializedAt : now };
    return { state, result: { pod, members } };
  });
}

export function writeDigestDelivery(state: CoordinationState, digest: Omit<DigestDelivery, "file">, messages: CoordinationMessage[]): DigestDelivery {
  validatePaneName(digest.pane);
  // il-yhw: exactly-once under partial failure. The persisted digest record
  // is the durable marker that suppresses re-delivery; the delivery file is
  // a re-materializable artifact of that record. Record the digest first,
  // then write the file — a file-write failure leaves the digest persisted,
  // so the next sweep skips it instead of duplicating it, and the inbox
  // surfaces the missing file for redelivery instead of pretending it landed.
  const delivery: DigestDelivery = { ...digest, file: join(coordinationDeliveryDir(), digest.pane, `digest-${digest.id}.json`) };
  state.digests.push(delivery);
  writeDigestDeliveryFile(delivery, messages);
  return delivery;
}

// Re-materializes the delivery file for a persisted digest. Idempotent: the
// filename is keyed by the digest id, so a rewrite after a partial failure
// converges on the same content instead of duplicating.
export function writeDigestDeliveryFile(delivery: DigestDelivery, messages: CoordinationMessage[]): void {
  const paneDir = join(coordinationDeliveryDir(), delivery.pane);
  mkdirSync(paneDir, { recursive: true });
  writeFileSync(delivery.file, JSON.stringify({ ...delivery, messages }, null, 2));
}

function normalizeState(value: unknown): CoordinationState {
  if (!isRecord(value)) throw new Error("state is not an object");
  if (value.version !== 2 && value.version !== 3) throw new Error(unsupportedVersionMessage(value));
  const state = emptyCoordinationState();
  state.memberTokens = memberTokens(value.memberTokens);
  state.pods = pods(value.pods);
  state.podMembers = podMembers(value.podMembers);
  state.leaderChannels = leaderChannels(value.leaderChannels);
  state.awarenessEvents = awarenessEvents(value.awarenessEvents);
  // OQ2: a state file written before the retention cap can carry an oversized
  // feed. Trim to the newest events at load, oldest first, so every
  // subsequent mutation persists the bounded feed without operator action.
  // The id counter below still floors against the retained suffix, so ids are
  // never reused.
  if (state.awarenessEvents.length > AWARENESS_FEED_MAX_EVENTS) {
    state.awarenessEvents.splice(0, state.awarenessEvents.length - AWARENESS_FEED_MAX_EVENTS);
  }
  state.orchestrator = orchestratorState(value.orchestrator);
  state.tasks = coordinationTasks(value.tasks);
  state.messages = coordinationMessages(value.messages);
  state.sessions = arrayOf<CoordinationSession>(value.sessions);
  state.digests = arrayOf<DigestDelivery>(value.digests);
  state.lastWatchAt = typeof value.lastWatchAt === "string" ? value.lastWatchAt : null;
  state.nextMessageId = idCounter(value.nextMessageId, highestId(state.messages, "message"));
  state.nextDigestId = idCounter(value.nextDigestId, Math.max(highestId(state.digests, "digest"), highestDeliveryDigestId()));
  state.nextChannelId = idCounter(value.nextChannelId, highestId(state.leaderChannels, "channel"));
  state.nextAwarenessEventId = idCounter(value.nextAwarenessEventId, highestId(state.awarenessEvents, "awareness event"));
  assertSuccessionIntegrity(state);
  return state;
}

function unsupportedVersionMessage(value: Record<string, unknown>): string {
  const found = value.version === undefined ? "missing" : String(value.version);
  return `coordination state version is ${found}, not 2; version-1 state requires the explicit operator upgrade: run \`interlock orchestrator init\`, then \`interlock state migrate --legacy-pod <name> --legacy-leader <pane>\``;
}

export function registerMemberToken(state: CoordinationState, member: string, token: string): void {
  validateMemberName(member);
  if (member === ORCHESTRATOR_MEMBER) {
    throw new Error("member name orchestrator is reserved for the orchestrator; provision it with `interlock orchestrator init`");
  }
  const hash = tokenHash(validateMemberToken(token));
  const existing = state.memberTokens[member];
  if (existing !== undefined && !safeEqual(existing, hash)) throw new Error("member " + member + " is already registered with a different token");
  state.memberTokens[member] = hash;
}

export function assertMemberToken(state: CoordinationState, member: string, token: string): void {
  validateMemberName(member);
  const expected = state.memberTokens[member];
  if (expected === undefined) throw new Error("member " + member + " is not registered; run session register before mutating it");
  const actual = tokenHash(validateMemberToken(token));
  if (!safeEqual(expected, actual)) throw new Error("member token does not authenticate " + member);
}

// ADR 0003 D3: orchestrator powers (pod create/close, appointments) are all
// token-checked. Fails loudly with the provisioning step when the orchestrator
// was never initialized.
export function assertOrchestratorToken(state: CoordinationState, token: string): void {
  if (state.orchestrator === null || state.memberTokens[ORCHESTRATOR_MEMBER] === undefined) {
    throw new Error("orchestrator is not initialized; run `interlock orchestrator init` first");
  }
  assertMemberToken(state, ORCHESTRATOR_MEMBER, token);
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

function memberTokens(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("coordination member tokens are not an object");
  const result: Record<string, string> = {};
  for (const [member, hash] of Object.entries(value)) {
    validateMemberName(member);
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("coordination member token hash for " + member + " is invalid");
    result[member] = hash;
  }
  return result;
}

export function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
function arrayOf<T>(value: unknown): T[] { return Array.isArray(value) ? structuredClone(value) as T[] : []; }
function highestId(items: ReadonlyArray<{ id: unknown }>, kind: string): number {
  let highest = 0;
  for (const item of items) {
    if (!isRecord(item) || !Number.isSafeInteger(item.id) || (item.id as number) <= 0) throw new Error(`coordination ${kind} id is corrupt`);
    highest = Math.max(highest, item.id as number);
  }
  return highest;
}
function idCounter(value: unknown, highestExistingId: number): number {
  const floor = highestExistingId + 1;
  return Number.isSafeInteger(value) && (value as number) >= floor ? value as number : floor;
}

// il-yhw: a crash between a delivery-file write and the state commit leaves
// an orphaned digest-N.json with no persisted digest record. The next-digest
// counter must floor against those artifacts too, or the next sweep reuses N
// and overwrites the orphan — a second logical delivery under one id. Files
// that do not match the digest naming scheme are ignored.
function highestDeliveryDigestId(): number {
  let highest = 0;
  let panes: string[];
  try {
    panes = readdirSync(coordinationDeliveryDir());
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
  for (const pane of panes) {
    let files: string[];
    try {
      files = readdirSync(join(coordinationDeliveryDir(), pane));
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    for (const file of files) {
      const match = /^digest-(\d+)\.json$/.exec(file);
      if (match !== null) highest = Math.max(highest, Number(match[1]));
    }
  }
  return highest;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMissingFile(error: unknown): boolean { return isNodeError(error) && error.code === "ENOENT"; }
function isExisting(error: unknown): boolean { return isNodeError(error) && error.code === "EEXIST"; }
function isMissing(error: unknown): boolean { return isNodeError(error) && error.code === "ENOENT"; }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
