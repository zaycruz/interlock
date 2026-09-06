import { existsSync } from "node:fs";
import type { BeadsClient } from "../beads/index.js";
import { interlockMetadata, renderWorkContract, validateIssue, type BeadsIssue, type InterlockMetadata, type WorkContract } from "../contracts/index.js";
import { DEFAULT_STALE_AFTER_MS, existingLeaseDatabasePath, type LeaseReader, type LeaseState } from "../core/index.js";
import { readInterlockBoard, readInterlockSnapshot } from "./snapshot.js";
import { ownerFromMetadata, sameOwner, samePaths, normalizedMetadataPaths, message } from "./contract-validation.js";
import type { LeaseCommand } from "./lease-commands.js";

export function status(command: Extract<LeaseCommand, { name: "status"; all: false }>, beads: BeadsClient,
  readerFactory: (repositoryPath: string) => LeaseReader, clock: (() => number) | undefined): string {
  const issue = beads.getIssue(command.beadId);
  const metadata = issue.metadata === undefined ? undefined : interlockMetadata(issue.metadata);
  const databasePath = existingLeaseDatabasePath(command.repositoryPath);
  const reader = existsSync(databasePath) ? readerFactory(command.repositoryPath) : undefined;
  try {
    const lease = reader?.getWorkContractByBeadId(command.beadId);
    const drift = statusDrift(issue, metadata, lease, command.beadId);
    const paths = statusPaths(lease, metadata);
    try {
      const validatedIssue = validateIssue(issue);
      return renderWorkContract({
        issue: validatedIssue,
        paths,
        upstream: beads.dependencies(command.beadId),
        downstream: beads.dependents(command.beadId),
        leaseHealth: statusLeaseHealth(drift, lease, clock),
        drift,
      });
    } catch (error) {
      return renderStatusDiagnostic(issue, error, paths, drift);
    }
  } finally { reader?.close(); }
}

export function snapshot(
  command: Extract<LeaseCommand, { name: "status"; all: false }>,
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

export function board(
  command: Extract<LeaseCommand, { name: "status"; all: true }>,
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

function statusDrift(issue: BeadsIssue, metadata: InterlockMetadata | undefined, lease: LeaseState | undefined, beadId: string): string | undefined {
  if (issue.metadataMalformed || issue.metadata === undefined) return "Beads metadata is malformed";
  if (!Object.hasOwn(issue.metadata, "interlock")) return lease === undefined ? "Beads metadata is absent" : "local-only contract; Beads metadata is absent";
  if (metadata === undefined) return "Beads metadata is malformed";
  if (issue.id !== beadId) return "remote contract issue ID mismatch";
  if (issue.status !== "in_progress") return `remote contract is inactive (${issue.status})`;
  if (issue.assignee !== metadata.actor) return `remote contract is reassigned (${issue.assignee ?? "unassigned"})`;
  return localLeaseDrift(lease, metadata, beadId);
}

function renderStatusDiagnostic(issue: BeadsIssue, error: unknown, paths: string[], drift: string | undefined): string {
  return [
    `Work contract: ${issue.id} — ${issue.title}`,
    `Contract diagnostic: ${message(error)}`,
    `Owned paths: ${paths.length === 0 ? "none" : paths.join(", ")}`,
    `Lease health: ${drift === undefined ? "not leased" : `drift (${drift})`}`,
  ].join("\n");
}

function localLeaseDrift(lease: LeaseState | undefined, metadata: InterlockMetadata, beadId: string): string | undefined {
  if (lease === undefined) return "remote-only active contract";
  const owner = ownerFromMetadata(beadId, metadata);
  if (lease.workContractId !== metadata.contractId || !lease.remoteConfirmed || lease.completing || !sameOwner(lease.owner, owner)
    || !samePaths(lease.paths, normalizedMetadataPaths(metadata))) return "local/Beads scope or owner mismatch";
  if (lease.heartbeatAt !== metadata.leaseHealth.heartbeatAt) return "local/Beads heartbeat metadata mismatch";
  return undefined;
}

function statusPaths(lease: LeaseState | undefined, metadata: InterlockMetadata | undefined): string[] {
  return lease?.paths ?? metadata?.paths ?? [];
}

function statusLeaseHealth(drift: string | undefined, lease: LeaseState | undefined, clock: (() => number) | undefined): WorkContract["leaseHealth"] {
  if (drift !== undefined || lease === undefined) return undefined;
  return { status: (clock ?? Date.now)() - lease.heartbeatAt > DEFAULT_STALE_AFTER_MS ? "expired" : "fresh", heartbeatAt: lease.heartbeatAt };
}
