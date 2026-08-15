import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ChildProcessBeadsClient, type BeadsClient } from "../beads/index.js";
import {
  interlockMetadata,
  interlockRecoveryMarker,
  renderWorkContract,
  validateIssue,
  type BeadsIssue,
  type InterlockMetadata,
  type InterlockRecoveryMarker,
} from "../contracts/index.js";
import {
  currentProcessIdentity,
  DEFAULT_STALE_AFTER_MS,
  existingLeaseDatabasePath,
  normalizeLeasePaths,
  openLeaseReader,
  openLeaseStore,
  processIdentityFor,
  type CompletionEvent,
  type LeaseOwner,
  type LeaseReader,
  type LeaseState,
  type LeaseStore,
  type ProcessIdentity,
  type RecoveryEvent,
} from "../core/index.js";
import { assertStagedPathsAreOwned } from "./staged-paths.js";
import { readInterlockBoard, readInterlockSnapshot } from "./snapshot.js";
import { coordinationUsage, runCoordinationCli } from "../coordination/index.js";

export interface CliResult { exitCode: number; stdout: string; stderr: string; }
export interface CliDependencies {
  beads?: BeadsClient;
  openLeaseStore?: (repositoryPath: string) => LeaseStore;
  openLeaseReader?: (repositoryPath: string) => LeaseReader;
  processIdentityFor?: (pid: number) => ProcessIdentity;
  lifecycleProcessor?: () => ProcessIdentity;
  clock?: () => number;
}

type Command =
  | { name: "claim"; beadId: string; actor: string; sessionPid: number; paths: string[]; repositoryPath: string }
  | { name: "status"; all: false; beadId: string; repositoryPath: string; json: boolean }
  | { name: "status"; all: true; beadId: undefined; repositoryPath: string; json: true }
  | { name: "heartbeat"; beadId: string; repositoryPath: string }
  | { name: "complete"; beadId: string; repositoryPath: string }
  | { name: "release"; beadId: string; reason: string; repositoryPath: string }
  | { name: "reconcile"; repositoryPath: string };

export function runCli(argv: string[], dependencies: CliDependencies = {}): CliResult {
  const coordination = runCoordinationCli(argv);
  if (coordination !== null) return coordination;
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) return { exitCode: 0, stdout: `${usage()}\n`, stderr: "" };
  try {
    const command = parseCommand(argv);
    const beads = dependencies.beads ?? new ChildProcessBeadsClient(command.repositoryPath);
    const storeFactory = dependencies.openLeaseStore ?? openLeaseStore;
    const readerFactory = dependencies.openLeaseReader ?? openLeaseReader;
    const identityFor = dependencies.processIdentityFor ?? processIdentityFor;
    if (command.name === "status") {
      const output = command.all
        ? board(command, beads, readerFactory, dependencies.clock)
        : command.json ? snapshot(command, beads, readerFactory, dependencies.clock) : status(command, beads, storeFactory);
      return { exitCode: 0, stdout: `${output}\n`, stderr: "" };
    }
    const processor = (dependencies.lifecycleProcessor ?? currentProcessIdentity)();
    const result = withLifecycleLock(command.repositoryPath, storeFactory, processor, (store) => executeMutating(command, beads, store, identityFor));
    return { exitCode: 0, stdout: `${result}\n`, stderr: "" };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `Error: ${message(error)}\n` };
  }
}

function withLifecycleLock<T>(repositoryPath: string, storeFactory: (repositoryPath: string) => LeaseStore, processor: ProcessIdentity,
  operation: (store: LeaseStore) => T): T {
  const store = storeFactory(repositoryPath);
  let locked = false;
  try {
    store.acquireLifecycleLock(processor);
    locked = true;
    return operation(store);
  } finally {
    try {
      if (locked) store.releaseLifecycleLock(processor);
    } finally {
      store.close();
    }
  }
}

function executeMutating(command: Exclude<Command, { name: "status" }>, beads: BeadsClient, store: LeaseStore,
  identityFor: (pid: number) => ProcessIdentity): string {
  switch (command.name) {
    case "claim": return claim(command, beads, store, identityFor);
    case "heartbeat": return heartbeat(command, beads, store);
    case "complete": return complete(command, beads, store);
    case "release": return release(command, beads, store);
    case "reconcile": return reconcile(beads, store);
  }
}

function claim(command: Extract<Command, { name: "claim" }>, beads: BeadsClient, store: LeaseStore,
  identityFor: (pid: number) => ProcessIdentity): string {
  const observedIssue = beads.getIssue(command.beadId);
  const validatedIssue = validateIssue(observedIssue);
  if (observedIssue.metadataMalformed || observedIssue.metadata === undefined || observedIssue.status !== "open" || observedIssue.assignee !== undefined || Object.hasOwn(observedIssue.metadata, "interlock")) {
    throw new Error(`Beads issue ${command.beadId} is not an unassigned open issue without Interlock metadata; local and Beads state were not changed`);
  }
  reconcileLifecycle(store, beads);
  const owner = { actor: command.actor, beadId: command.beadId, process: identityFor(command.sessionPid) };
  const contractId = randomUUID();
  const lease = store.acquire({ workContractId: contractId, owner, paths: command.paths });
  const metadata = metadataFor(contractId, owner.actor, owner.process, lease.paths, lease.heartbeatAt);
  store.markRemoteAttempted({ workContractId: contractId, owner });
  try {
    beads.claim(command.beadId, command.actor, metadata);
  } catch (error) {
    throw new Error(`Beads claim outcome is ambiguous for ${command.beadId}. The attempted local contract and its paths remain reserved because the remote update may have succeeded: ${message(error)}. Inspect Beads and correct local/remote drift deliberately.`);
  }
  let remote: BeadsIssue;
  try {
    remote = beads.getIssue(command.beadId);
  } catch (error) {
    throw new Error(`Beads claim for ${command.beadId} returned successfully, but its result could not be read. The attempted local contract and its paths remain reserved: ${message(error)}. Inspect Beads and correct local/remote drift deliberately.`);
  }
  if (!isExactActiveContract(remote, command.beadId, owner, metadata)) {
    throw new Error(`Beads claim for ${command.beadId} did not produce the exact active Interlock contract. The attempted local contract remains reserved; inspect and correct local/remote drift deliberately.`);
  }
  try {
    store.confirmRemote({ workContractId: contractId, owner });
  } catch (error) {
    throw new Error(`Beads claim succeeded for ${command.beadId}, but SQLite remote confirmation failed: ${message(error)}. Remote/local drift requires operator intervention; Interlock will never auto-recover this Bead.`);
  }
  return `Claimed ${validatedIssue.issue.id} with ${lease.paths.length} exact path lease(s).`;
}

function status(command: Extract<Command, { name: "status"; all: false }>, beads: BeadsClient, storeFactory: (repositoryPath: string) => LeaseStore): string {
  const issue = beads.getIssue(command.beadId);
  const metadata = issue.metadata === undefined ? undefined : interlockMetadata(issue.metadata);
  const databasePath = existingLeaseDatabasePath(command.repositoryPath);
  const store = existsSync(databasePath) ? storeFactory(command.repositoryPath) : undefined;
  try {
    const lease = store?.getWorkContractByBeadId(command.beadId);
    const drift = statusDrift(issue, metadata, lease, command.beadId);
    try {
      const validatedIssue = validateIssue(issue);
      return renderWorkContract({
        issue: validatedIssue,
        paths: lease?.paths ?? metadata?.paths ?? [],
        upstream: beads.dependencies(command.beadId),
        downstream: beads.dependents(command.beadId),
        leaseHealth: drift === undefined && lease !== undefined
          ? { status: Date.now() - lease.heartbeatAt > DEFAULT_STALE_AFTER_MS ? "expired" : "fresh", heartbeatAt: lease.heartbeatAt }
          : undefined,
        drift,
      });
    } catch (error) {
      return renderStatusDiagnostic(issue, error, lease?.paths ?? metadata?.paths ?? [], drift);
    }
  } finally { store?.close(); }
}

function snapshot(
  command: Extract<Command, { name: "status"; all: false }>,
  beads: BeadsClient,
  readerFactory: (repositoryPath: string) => LeaseReader,
  clock: (() => number) | undefined,
): string {
  const databasePath = existingLeaseDatabasePath(command.repositoryPath);
  const reader = existsSync(databasePath) ? readerFactory(command.repositoryPath) : undefined;
  try {
    return JSON.stringify(readInterlockSnapshot(beads, reader, command.beadId, { workspace: command.repositoryPath, clock }));
  } finally { reader?.close(); }
}

function heartbeat(command: Extract<Command, { name: "heartbeat" }>, beads: BeadsClient, store: LeaseStore): string {
  const { metadata, owner } = preflightActiveContract(beads, store, command.beadId);
  const updatedLease = store.heartbeat({ workContractId: metadata.contractId, owner });
  const nextMetadata = metadataFor(metadata.contractId, metadata.actor, metadata.session, updatedLease.paths, updatedLease.heartbeatAt);
  try { beads.heartbeat(command.beadId, nextMetadata); } catch (error) {
    throw new Error(`Local heartbeat succeeded for ${command.beadId} at ${new Date(updatedLease.heartbeatAt).toISOString()}, but Beads metadata sync failed: ${message(error)}. Retry interlock heartbeat ${command.beadId}.`);
  }
  try {
    const remote = beads.getIssue(command.beadId);
    if (!isExactActiveContract(remote, command.beadId, owner, nextMetadata)) throw new Error("Beads returned a different active contract or metadata");
  } catch (error) {
    throw new Error(`Local heartbeat succeeded for ${command.beadId} at ${new Date(updatedLease.heartbeatAt).toISOString()}, but exact Beads verification failed: ${message(error)}. The renewed local lease remains reserved; inspect Beads and retry interlock heartbeat ${command.beadId}.`);
  }
  return `Heartbeated ${command.beadId}: local lease and Beads metadata are synchronized.`;
}

function complete(command: Extract<Command, { name: "complete" }>, beads: BeadsClient, store: LeaseStore): string {
  const { metadata, owner, lease } = preflightActiveContract(beads, store, command.beadId);
  assertStagedPathsAreOwned(command.repositoryPath, lease.paths);
  const event = store.beginCompletion({ workContractId: metadata.contractId, owner });
  try {
    beads.close(command.beadId);
  } catch (error) {
    throw new Error(`Completion for ${command.beadId} is pending. The durable completion intent remains because Beads close may have succeeded: ${message(error)}. Run interlock reconcile after inspection.`);
  }
  try {
    const remote = beads.getIssue(command.beadId);
    if (!isExactClosedContract(remote, command.beadId, owner, metadataForEvent(event))) throw new Error("Beads returned a different closed contract or metadata");
  } catch (error) {
    throw new Error(`Completion for ${command.beadId} is pending. Beads close returned successfully, but exact closed-contract verification failed: ${message(error)}. The durable completion intent remains; inspect Beads and run interlock reconcile.`);
  }
  try { store.acknowledgeCompletion(event.id); } catch (error) {
    throw new Error(`Beads issue ${command.beadId} closed, but local completion acknowledgement failed: ${message(error)}. Run interlock reconcile; it will only release the exact closed contract.`);
  }
  return `Completed ${command.beadId} and released its Interlock lease.`;
}

function release(command: Extract<Command, { name: "release" }>, beads: BeadsClient, store: LeaseStore): string {
  const { metadata, owner } = preflightActiveContract(beads, store, command.beadId);
  store.releaseForRecovery({ workContractId: metadata.contractId, owner, reason: command.reason });
  try { reconcileLifecycle(store, beads); } catch (error) { throw pendingRecoveryError(command.beadId, error); }
  return `Released ${command.beadId}, reopened it, and cleared its Interlock assignment.`;
}

function reconcile(beads: BeadsClient, store: LeaseStore): string {
  const processed = reconcileLifecycle(store, beads);
  return processed === 0 ? "Reconciliation found no pending lifecycle events." : `Reconciled ${processed} lifecycle event(s).`;
}

function reconcileLifecycle(store: LeaseStore, beads: BeadsClient): number {
  store.reconcileStaleSessions();
  let processed = 0;
  const failures: string[] = [];
  for (const event of store.completionEvents()) {
    try {
      recoverCompletedContract(beads, event);
      store.acknowledgeCompletion(event.id);
      processed += 1;
    } catch (error) {
      failures.push(`completion ${event.owner.beadId}: ${message(error)}`);
    }
  }
  for (const event of store.recoveryEvents()) {
    try {
      recoverBead(beads, event);
      store.acknowledgeRecovery(event.id);
      processed += 1;
    } catch (error) {
      failures.push(`recovery ${event.owner.beadId}: ${message(error)}`);
    }
  }
  if (failures.length > 0 || store.hasPendingLifecycleWork()) {
    throw new Error(`Lifecycle recovery remains pending: ${failures.join("; ") || "an event was retained"}. Inspect Beads and local state. Do not claim new work until reconciliation succeeds.`);
  }
  return processed;
}

function recoverCompletedContract(beads: BeadsClient, event: CompletionEvent): void {
  const issue = beads.getIssue(event.owner.beadId);
  if (!isExactClosedContract(issue, event.owner.beadId, event.owner, metadataForEvent(event))) {
    throw new Error(`observed Beads state is not the exact closed completion contract ${event.workContractId}; manual review is required`);
  }
}

function board(
  command: Extract<Command, { name: "status"; all: true }>,
  beads: BeadsClient,
  readerFactory: (repositoryPath: string) => LeaseReader,
  clock: (() => number) | undefined,
): string {
  const databasePath = existingLeaseDatabasePath(command.repositoryPath);
  const reader = existsSync(databasePath) ? readerFactory(command.repositoryPath) : undefined;
  try {
    return JSON.stringify(readInterlockBoard(beads, reader, { workspace: command.repositoryPath, clock }));
  } finally { reader?.close(); }
}

function recoverBead(beads: BeadsClient, event: RecoveryEvent): void {
  const issue = beads.getIssue(event.owner.beadId);
  const marker: InterlockRecoveryMarker = { eventId: event.id, contractId: event.workContractId };
  if (hasRecoveryResult(issue, event.owner.beadId, marker)) return;
  if (!isActiveMatchingRecovery(issue, event)) {
    throw new Error(`observed Beads state does not match recovery event ${event.id}; manual review is required`);
  }
  beads.recover(event.owner.beadId, marker);
  if (!hasRecoveryResult(beads.getIssue(event.owner.beadId), event.owner.beadId, marker)) {
    throw new Error(`Beads recovery for event ${event.id} did not produce the exact acknowledged state; the event remains pending`);
  }
}

function hasRecoveryResult(issue: BeadsIssue, beadId: string, marker: InterlockRecoveryMarker): boolean {
  if (issue.metadataMalformed || issue.metadata === undefined) return false;
  const observed = interlockRecoveryMarker(issue.metadata);
  return issue.id === beadId && issue.status === "open" && issue.assignee === undefined && !Object.hasOwn(issue.metadata, "interlock")
    && observed?.eventId === marker.eventId && observed.contractId === marker.contractId;
}

function isActiveMatchingRecovery(issue: BeadsIssue, event: RecoveryEvent): boolean {
  return isExactActiveContract(issue, event.owner.beadId, event.owner, metadataForEvent(event));
}

function isActiveMatchingContract(issue: BeadsIssue, beadId: string, owner: LeaseOwner, metadata: InterlockMetadata): boolean {
  return issue.status === "in_progress" && sameContract(issue, beadId, owner, metadata.contractId, normalizedMetadataPaths(metadata), metadata);
}

function isExactActiveContract(issue: BeadsIssue, beadId: string, owner: LeaseOwner, expected: InterlockMetadata): boolean {
  if (issue.metadataMalformed || issue.metadata === undefined) return false;
  const observed = interlockMetadata(issue.metadata);
  return observed !== undefined && isActiveMatchingContract(issue, beadId, owner, observed) && sameMetadata(observed, expected);
}

function isExactClosedContract(issue: BeadsIssue, beadId: string, owner: LeaseOwner, expected: InterlockMetadata): boolean {
  if (issue.metadataMalformed || issue.metadata === undefined) return false;
  const observed = interlockMetadata(issue.metadata);
  return observed !== undefined && issue.status === "closed" && sameContract(issue, beadId, owner, expected.contractId, expected.paths, observed)
    && sameMetadata(observed, expected);
}

function sameContract(issue: BeadsIssue, beadId: string, owner: LeaseOwner, contractId: string, paths: string[], metadata: InterlockMetadata): boolean {
  const normalizedPaths = normalizedMetadataPaths(metadata);
  return issue.id === beadId && metadata.contractId === contractId && metadata.actor === owner.actor && metadata.session.pid === owner.process.pid
    && metadata.session.startedAt === owner.process.startedAt && issue.assignee === owner.actor
    && samePaths(metadata.paths, normalizedPaths) && samePaths(paths, normalizedPaths);
}

function sameMetadata(left: InterlockMetadata, right: InterlockMetadata): boolean {
  return left.contractId === right.contractId && left.actor === right.actor && left.session.pid === right.session.pid
    && left.session.startedAt === right.session.startedAt && samePaths(left.paths, right.paths)
    && left.leaseHealth.status === right.leaseHealth.status && left.leaseHealth.heartbeatAt === right.leaseHealth.heartbeatAt;
}

function normalizedMetadataPaths(metadata: InterlockMetadata): string[] {
  try { return normalizeLeasePaths(metadata.paths); } catch { return []; }
}

function pendingRecoveryError(beadId: string, error: unknown): Error {
  return new Error(`Beads recovery remains pending for ${beadId}: ${message(error)}. Corrective action: inspect the Beads issue and Interlock lifecycle event, then run interlock reconcile. Do not claim new work until reconciliation succeeds.`);
}

function preflightActiveContract(beads: BeadsClient, store: LeaseStore, beadId: string): { metadata: InterlockMetadata; owner: LeaseOwner; lease: LeaseState } {
  const issue = beads.getIssue(beadId);
  const observed = issue.metadata === undefined ? undefined : interlockMetadata(issue.metadata);
  if (observed === undefined || !isActiveMatchingContract(issue, beadId, ownerFromMetadata(beadId, observed), observed)) {
    throw new Error(`Beads issue ${beadId} is not an active matching Interlock contract; local and Beads state were not changed`);
  }
  const lease = store.getWorkContract(observed.contractId);
  if (lease === undefined) throw new Error(`Interlock work contract ${observed.contractId} does not exist locally`);
  if (!lease.remoteConfirmed) throw new Error(`Interlock work contract ${observed.contractId} is not remotely confirmed`);
  if (lease.completing) throw new Error(`Interlock work contract ${observed.contractId} is already completing`);
  const expected = metadataFor(lease.workContractId, lease.owner.actor, lease.owner.process, lease.paths, lease.heartbeatAt);
  if (!isExactActiveContract(issue, beadId, lease.owner, expected)) {
    throw new Error(`Interlock work contract ${observed.contractId} does not exactly match its confirmed local lease metadata; local/Beads drift detected and local and Beads state were not changed`);
  }
  return { metadata: expected, owner: lease.owner, lease };
}

function statusDrift(issue: BeadsIssue, metadata: InterlockMetadata | undefined, lease: LeaseState | undefined, beadId: string): string | undefined {
  if (issue.metadataMalformed || issue.metadata === undefined) return "Beads metadata is malformed";
  if (!Object.hasOwn(issue.metadata, "interlock")) return lease === undefined ? "Beads metadata is absent" : "local-only contract; Beads metadata is absent";
  if (metadata === undefined) return "Beads metadata is malformed";
  if (issue.id !== beadId) return "remote contract issue ID mismatch";
  if (issue.status !== "in_progress") return `remote contract is inactive (${issue.status})`;
  if (issue.assignee !== metadata.actor) return `remote contract is reassigned (${issue.assignee ?? "unassigned"})`;
  if (lease === undefined) return "remote-only active contract";
  const owner = ownerFromMetadata(beadId, metadata);
  if (lease.workContractId !== metadata.contractId || !lease.remoteConfirmed || lease.completing || !sameOwner(lease.owner, owner)
    || !samePaths(lease.paths, normalizedMetadataPaths(metadata))) return "local/Beads scope or owner mismatch";
  if (lease.heartbeatAt !== metadata.leaseHealth.heartbeatAt) return "local/Beads heartbeat metadata mismatch";
  return undefined;
}

function renderStatusDiagnostic(issue: BeadsIssue, error: unknown, paths: string[], drift: string | undefined): string {
  return [
    `Work contract: ${issue.id} — ${issue.title}`,
    `Contract diagnostic: ${message(error)}`,
    `Owned paths: ${paths.length === 0 ? "none" : paths.join(", ")}`,
    `Lease health: ${drift === undefined ? "not leased" : `drift (${drift})`}`,
  ].join("\n");
}

type SavedContract = Pick<CompletionEvent, "workContractId" | "owner" | "paths" | "heartbeatAt">;

function metadataForEvent(event: SavedContract): InterlockMetadata {
  return metadataFor(event.workContractId, event.owner.actor, event.owner.process, event.paths, event.heartbeatAt);
}
function ownerFromMetadata(beadId: string, metadata: InterlockMetadata): LeaseOwner { return { actor: metadata.actor, beadId, process: metadata.session }; }
function metadataFor(contractId: string, actor: string, session: ProcessIdentity, paths: string[], heartbeatAt: number): InterlockMetadata {
  return { contractId, actor, session: { pid: session.pid, startedAt: session.startedAt }, paths: [...paths], leaseHealth: { status: "fresh", heartbeatAt } };
}
function sameOwner(left: LeaseOwner, right: LeaseOwner): boolean {
  return left.actor === right.actor && left.beadId === right.beadId && left.process.pid === right.process.pid && left.process.startedAt === right.process.startedAt;
}
function samePaths(left: string[], right: string[]): boolean { return left.length === right.length && left.every((path, index) => path === right[index]); }

function parseCommand(argv: string[]): Command {
  const [name, ...rest] = argv;
  if (name === undefined) throw new Error(usage());
  const parsed = parseFlags(rest, name === "status" ? ["all", "json"] : []);
  const repositoryPath = resolve(single(parsed, "repo") ?? process.cwd());
  if (name === "reconcile") { requirePositionals(parsed, 0, name); requireOnly(parsed, ["repo"]); return { name, repositoryPath }; }
  if (name === "claim") {
    const beadId = parsed.positionals[0];
    requirePositionals(parsed, 1, name);
    requireOnly(parsed, ["actor", "session-pid", "path", "repo"]);
    const sessionPid = Number(single(parsed, "session-pid"));
    if (!Number.isSafeInteger(sessionPid) || sessionPid <= 0) throw new Error("--session-pid must be a positive integer");
    const paths = values(parsed, "path");
    if (paths.length === 0) throw new Error("claim requires at least one --path");
    return { name, beadId, actor: required(parsed, "actor"), sessionPid, paths, repositoryPath };
  }
  if (name === "status") {
    requireOnly(parsed, ["repo", "all", "json"]);
    const all = single(parsed, "all") !== undefined;
    const json = single(parsed, "json") !== undefined;
    if (all) {
      if (!json) throw new Error("status --all requires --json");
      requirePositionals(parsed, 0, name);
      return { name, all: true, beadId: undefined, repositoryPath, json: true };
    }
    const beadId = parsed.positionals[0];
    requirePositionals(parsed, 1, name);
    if (beadId === undefined) throw new Error(`${name} requires a Beads issue ID`);
    return { name, all: false, beadId, repositoryPath, json };
  }
  const beadId = parsed.positionals[0];
  requirePositionals(parsed, 1, name);
  if (name === "heartbeat" || name === "complete") { requireOnly(parsed, ["repo"]); return { name, beadId, repositoryPath }; }
  if (name === "release") { requireOnly(parsed, ["reason", "repo"]); return { name, beadId, reason: required(parsed, "reason"), repositoryPath }; }
  throw new Error(`Unknown command: ${name}\n${usage()}`);
}

interface ParsedFlags { positionals: string[]; flags: Map<string, string[]>; }
function parseFlags(values: string[], booleanFlags: string[] = []): ParsedFlags {
  const flags = new Map<string, string[]>(); const positionals: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const name = value.slice(2);
    if (name === "" || name.includes("=")) throw new Error(`Invalid option: ${value}`);
    if (booleanFlags.includes(name)) {
      flags.set(name, [...(flags.get(name) ?? []), "true"]);
      continue;
    }
    const flagValue = values[++index];
    if (flagValue === undefined || flagValue.startsWith("--")) throw new Error(`Option ${value} requires a value`);
    flags.set(name, [...(flags.get(name) ?? []), flagValue]);
  }
  return { positionals, flags };
}
function requireOnly(parsed: ParsedFlags, allowed: string[]): void { for (const name of parsed.flags.keys()) if (!allowed.includes(name)) throw new Error(`Unknown option: --${name}`); }
function requirePositionals(parsed: ParsedFlags, count: number, command: string): void {
  if (parsed.positionals.length !== count) throw new Error(`${command} requires ${count === 0 ? "no arguments" : "a Beads issue ID"}`);
}
function values(parsed: ParsedFlags, name: string): string[] { return parsed.flags.get(name) ?? []; }
function single(parsed: ParsedFlags, name: string): string | undefined {
  const found = values(parsed, name); if (found.length > 1) throw new Error(`Option --${name} may only be specified once`); return found[0];
}
function required(parsed: ParsedFlags, name: string): string {
  const value = single(parsed, name); if (value === undefined || value.trim() === "") throw new Error(`Option --${name} is required`); return value;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function usage(): string {
  return ["Usage:", "  interlock claim <bead-id> --actor <actor> --session-pid <pid> --path <path> [--path <path>] [--repo <repo>]",
    "  interlock status <bead-id> [--json] [--repo <repo>]", "  interlock status --all --json [--repo <repo>]", "  interlock heartbeat <bead-id> [--repo <repo>]",
    "  interlock complete <bead-id> [--repo <repo>]", "  interlock release <bead-id> --reason <reason> [--repo <repo>]",
    "  interlock reconcile [--repo <repo>]", ...coordinationUsage()] .join("\n");
}
