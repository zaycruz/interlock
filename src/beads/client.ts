import { spawnSync } from "node:child_process";

import type { BeadsDependency, BeadsIssue, InterlockMetadata, InterlockRecoveryMarker } from "../contracts/index.js";

export class BeadsCommandError extends Error {
  constructor(readonly command: string[], message: string) {
    super(`Beads command failed (${command.join(" ")}): ${message}`);
    this.name = "BeadsCommandError";
  }
}

export interface BeadsClient {
  getIssue(id: string): BeadsIssue;
  dependencies(id: string): BeadsDependency[];
  dependents(id: string): BeadsDependency[];
  claim(id: string, actor: string, metadata: InterlockMetadata): void;
  heartbeat(id: string, metadata: InterlockMetadata): void;
  close(id: string): void;
  recover(id: string, marker: InterlockRecoveryMarker): void;
}

export class ChildProcessBeadsClient implements BeadsClient {
  constructor(private readonly repositoryPath: string) {}

  getIssue(id: string): BeadsIssue {
    const issues = parseJson(this.run(["show", id, "--json"]));
    if (!Array.isArray(issues) || issues.length !== 1) throw new BeadsCommandError(["show", id, "--json"], "expected one issue in JSON output");
    return asIssue(issues[0]);
  }

  dependencies(id: string): BeadsDependency[] { return this.relationships(["dep", "list", id, "--json"]); }
  dependents(id: string): BeadsDependency[] { return this.relationships(["dep", "list", id, "--direction", "up", "--json"]); }

  claim(id: string, actor: string, metadata: InterlockMetadata): void {
    this.run(["update", id, "--claim", "--assignee", actor, "--set-metadata", `interlock=${JSON.stringify(metadata)}`]);
  }

  heartbeat(id: string, metadata: InterlockMetadata): void {
    this.run(["update", id, "--set-metadata", `interlock=${JSON.stringify(metadata)}`]);
  }

  close(id: string): void { this.run(["close", id, "--reason", "Completed through Interlock"]); }

  recover(id: string, marker: InterlockRecoveryMarker): void {
    this.run([
      "update", id,
      "--status", "open",
      "--assignee", "",
      "--unset-metadata", "interlock",
      "--set-metadata", `interlock.recovery=${JSON.stringify(marker)}`,
    ]);
  }

  private relationships(args: string[]): BeadsDependency[] {
    const values = parseJson(this.run(args));
    if (!Array.isArray(values)) throw new BeadsCommandError(args, "expected an array in JSON output");
    return values.map(asDependency);
  }

  private run(args: string[]): string {
    const result = spawnSync("bd", args, { cwd: this.repositoryPath, encoding: "utf8", windowsHide: true });
    if (result.error !== undefined) throw new BeadsCommandError(args, result.error.message);
    if (result.status !== 0 || result.signal !== null) {
      throw new BeadsCommandError(args, result.stderr.trim() || `exit status ${result.status ?? `signal ${result.signal}`}`);
    }
    return result.stdout;
  }
}

function parseJson(output: string): unknown {
  try { return JSON.parse(output); } catch (error) {
    throw new BeadsCommandError([], `invalid JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function asIssue(value: unknown): BeadsIssue {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.description !== "string" || typeof value.status !== "string") {
    throw new BeadsCommandError(["show", "--json"], "issue JSON is missing id, title, description, or status");
  }
  const assignee = value.assignee;
  if (assignee !== undefined && assignee !== null && typeof assignee !== "string") {
    throw new BeadsCommandError(["show", "--json"], "issue JSON has an invalid assignee");
  }
  const metadataMalformed = Object.hasOwn(value, "metadata") && !isRecord(value.metadata);
  const metadata = metadataMalformed ? undefined : (isRecord(value.metadata) ? value.metadata : {});
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    acceptanceCriteria: typeof value.acceptance_criteria === "string" ? value.acceptance_criteria : "",
    status: value.status,
    assignee: typeof assignee === "string" ? assignee : undefined,
    metadata,
    metadataMalformed,
  };
}

function asDependency(value: unknown): BeadsDependency {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.status !== "string") {
    throw new BeadsCommandError(["dep", "list", "--json"], "dependency JSON is missing id, title, or status");
  }
  return { id: value.id, title: value.title, status: value.status };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
