import { DEFAULT_STALE_AFTER_MS } from "../core/lease-store.js";
import { normalizeLeasePaths } from "../core/paths.js";
import type { LeaseState } from "../core/types.js";
import type { BeadsIssue } from "./issue.js";
import { interlockMetadata } from "./validation.js";

/**
 * A bounded, read-only view of one Beads issue and its local Interlock lease.
 * Beads is the issue authority. The local lease only supplements the view and
 * can produce a drift diagnostic; it never changes the authority.
 */
export interface InterlockSnapshot {
  /** Beads issue identifier. */
  id: string;
  /** Beads issue title. */
  title: string;
  /** True for a non-closed Beads assignment or active validated Interlock metadata. */
  claimed: boolean;
  /** Current assignee, Interlock actor, or local lease actor, in that order. */
  owner: string | null;
  /** Interlock actor from validated remote metadata or the local lease. */
  agent: string | null;
  /** Resolved repository path supplied by the caller. */
  workspace: string;
  /** Beads status, without a second status vocabulary. */
  stage: string;
  /** A concrete local/remote or metadata diagnostic; normal states are null. */
  blocker: string | null;
  /** Newest validated remote or local heartbeat in ISO UTC form. */
  lastProgressAt: string | null;
  /** True only when an active item has exceeded the configured stale threshold. */
  stale: boolean;
  /** True only when Beads status is exactly closed. */
  terminal: boolean;
  /** Stable source semantics: "beads" means the issue payload is authoritative. */
  source: "beads" | null;
  /** The Beads adapter exposes no stable issue revision, so this is null. */
  revision: string | null;
}

export interface InterlockSnapshotOptions {
  workspace: string;
  clock?: () => number;
  staleAfterMs?: number;
}

export function buildInterlockSnapshot(
  issue: BeadsIssue,
  lease: LeaseState | undefined,
  options: InterlockSnapshotOptions,
): InterlockSnapshot {
  const terminal = issue.status === "closed";
  const metadata = issue.metadata === undefined ? undefined : interlockMetadata(issue.metadata);
  const hasInterlockMetadata = issue.metadata !== undefined && Object.hasOwn(issue.metadata, "interlock");
  const activeAssignment = !terminal && isNonEmpty(issue.assignee);
  const activeMetadata = !terminal && issue.status === "in_progress" && metadata !== undefined;
  const claimed = activeAssignment || activeMetadata;
  const heartbeatAt = newestHeartbeat(metadata?.leaseHealth.heartbeatAt, lease?.heartbeatAt);
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new RangeError("staleAfterMs must be a non-negative finite number");

  return {
    id: issue.id,
    title: issue.title,
    claimed,
    owner: firstNonEmpty(issue.assignee, metadata?.actor, lease?.owner.actor),
    agent: firstNonEmpty(metadata?.actor, lease?.owner.actor),
    workspace: options.workspace,
    stage: issue.status,
    blocker: snapshotBlocker(issue, metadata, lease, hasInterlockMetadata, terminal),
    lastProgressAt: heartbeatAt === undefined ? null : new Date(heartbeatAt).toISOString(),
    stale: claimed && !terminal && heartbeatAt !== undefined && (options.clock ?? Date.now)() - heartbeatAt > staleAfterMs,
    terminal,
    source: "beads",
    revision: null,
  };
}

function snapshotBlocker(
  issue: BeadsIssue,
  metadata: ReturnType<typeof interlockMetadata>,
  lease: LeaseState | undefined,
  hasInterlockMetadata: boolean,
  terminal: boolean,
): string | null {
  if (issue.metadataMalformed) return "Beads metadata is malformed";
  if (hasInterlockMetadata && metadata === undefined) return "Beads metadata is malformed";
  if (!hasInterlockMetadata) return lease === undefined ? null : "local-only contract; Beads metadata is absent";
  if (metadata === undefined) return "Beads metadata is malformed";
  if (terminal) return lease === undefined ? null : "closed Beads issue retains a local Interlock contract";
  if (issue.status !== "in_progress") return `remote contract is inactive (${issue.status})`;
  if (issue.assignee !== metadata.actor) return `remote contract is reassigned (${issue.assignee ?? "unassigned"})`;
  if (lease === undefined) return "remote-only active contract";
  if (lease.workContractId !== metadata.contractId || !lease.remoteConfirmed || lease.completing
    || lease.owner.actor !== metadata.actor || lease.owner.beadId !== issue.id
    || lease.owner.process.pid !== metadata.session.pid || lease.owner.process.startedAt !== metadata.session.startedAt
    || !samePaths(lease.paths, normalizedMetadataPaths(metadata))) {
    return "local/Beads scope or owner mismatch";
  }
  if (lease.heartbeatAt !== metadata.leaseHealth.heartbeatAt) return "local/Beads heartbeat metadata mismatch";
  return null;
}

function normalizedMetadataPaths(metadata: NonNullable<ReturnType<typeof interlockMetadata>>): string[] {
  try { return normalizeLeasePaths(metadata.paths); } catch { return []; }
}

function newestHeartbeat(...values: Array<number | undefined>): number | undefined {
  const valid = values.filter(isReliableTimestamp);
  return valid.length === 0 ? undefined : Math.max(...valid);
}

function isReliableTimestamp(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  return values.find(isNonEmpty) ?? null;
}

function isNonEmpty(value: string | undefined): value is string { return typeof value === "string" && value.trim() !== ""; }
function samePaths(left: string[], right: string[]): boolean { return left.length === right.length && left.every((path, index) => path === right[index]); }
