import type { BeadsIssue, InterlockMetadata, ValidatedIssue } from "./issue.js";

export class IssueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueValidationError";
  }
}

export function validateIssue(issue: BeadsIssue): ValidatedIssue {
  const value = section(issue.description, "Value");
  const work = section(issue.description, "Work");
  const out = section(issue.description, "Out") ?? "None stated.";
  const acceptanceCriteria = issue.acceptanceCriteria.trim();

  if (value === undefined) {
    throw new IssueValidationError(`Beads issue ${issue.id} must include a non-empty Value: section`);
  }
  if (work === undefined) {
    throw new IssueValidationError(`Beads issue ${issue.id} must include a non-empty Work: section`);
  }
  if (acceptanceCriteria === "") {
    throw new IssueValidationError(`Beads issue ${issue.id} must include acceptance criteria`);
  }

  return { issue, value, work, out, acceptanceCriteria };
}

export function interlockMetadata(metadata: Record<string, unknown>): InterlockMetadata | undefined {
  const value = metadataValue(metadata.interlock);
  if (!isRecord(value) || !hasOnlyKeys(value, ["contractId", "actor", "session", "paths", "leaseHealth"])
    || !nonEmpty(value.contractId) || !nonEmpty(value.actor)
    || !validSession(value.session)
    || !validPaths(value.paths)
    || !validLeaseHealth(value.leaseHealth)) {
    return undefined;
  }

  return {
    contractId: value.contractId,
    actor: value.actor,
    session: { pid: value.session.pid, startedAt: value.session.startedAt },
    paths: [...value.paths],
    leaseHealth: { status: "fresh", heartbeatAt: value.leaseHealth.heartbeatAt },
  };
}

export function interlockRecoveryMarker(metadata: Record<string, unknown>): { eventId: number; contractId: string } | undefined {
  const value = metadataValue(metadata["interlock.recovery"]);
  if (!isRecord(value) || Object.keys(value).length !== 2 || !("eventId" in value) || !("contractId" in value)
    || !positiveInteger(value.eventId) || !nonEmpty(value.contractId)) {
    return undefined;
  }
  return { eventId: value.eventId, contractId: value.contractId };
}

function metadataValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function section(description: string, name: string): string | undefined {
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${name}:\\s*`, "i").test(line));
  if (start === -1) {
    return undefined;
  }

  const content = [lines[start]!.replace(new RegExp(`^${name}:\\s*`, "i"), "")];
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z][^:\n]*:\s*/.test(line)) {
      break;
    }
    content.push(line);
  }
  const value = content.join("\n").trim();
  return value === "" ? undefined : value;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSession(value: unknown): value is InterlockMetadata["session"] {
  return isRecord(value) && hasOnlyKeys(value, ["pid", "startedAt"]) && positiveInteger(value.pid) && nonEmpty(value.startedAt);
}
function validPaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((path) => typeof path === "string");
}
function validLeaseHealth(value: unknown): value is InterlockMetadata["leaseHealth"] {
  return isRecord(value) && hasOnlyKeys(value, ["status", "heartbeatAt"]) && value.status === "fresh" && nonNegativeSafeInteger(value.heartbeatAt);
}
