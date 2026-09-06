import { execFileSync } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import { z } from "zod";
import { ChildProcessBeadsClient, type BeadsClient } from "../beads/index.js";
import { validateIssue, interlockMetadata, type BeadsIssue } from "../contracts/index.js";
import { parseVerificationChecks } from "../contracts/verification.js";
import { normalizeLeasePaths, existingLeaseDatabasePath, SqliteLeaseReader } from "../core/index.js";
import type { TaskContract } from "./linked-types.js";

export function canonicalRepository(repositoryPath: string): string {
  return realpathSync(execFileSync("git", ["-C", repositoryPath, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
}

export function assertAcceptanceCoverage(acceptance: string, checks: TaskContract["checks"]): void {
  const criteria = acceptance.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim()).filter(Boolean);
  if (criteria.length !== checks.length || criteria.some((criterion) => !checks.some((check) => check.criterion === criterion))) {
    throw new Error("verification checks must cover each nonempty acceptance line exactly; criterion excludes its bullet marker");
  }
}

export function readTaskContract(workspace: string, input: unknown, client?: BeadsClient): { contract: TaskContract; title: string; businessValue: string } {
  const request = z.object({ beadId: z.string().trim().min(1), paths: z.array(z.string()).min(1), checks: z.unknown() }).strict().parse(input);
  assertNoLocalContract(workspace, request.beadId);
  const beads = client ?? new ChildProcessBeadsClient(workspace);
  const observed = beads.getIssue(request.beadId);
  if (observed.id !== request.beadId) throw new Error("Beads returned a different issue ID");
  assertRemoteCanLink(observed);
  const issue = validateIssue(observed);
  const checks = parseVerificationChecks(request.checks);
  assertAcceptanceCoverage(issue.acceptanceCriteria, checks);
  return { contract: { repositoryId: canonicalRepository(workspace), beadId: request.beadId, paths: normalizeLeasePaths(request.paths), checks }, title: issue.issue.title, businessValue: issue.value };
}


export function canonicalWorkspace(repositoryPath: string): string {
  return realpathSync(execFileSync("git", ["-C", repositoryPath, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
}


function assertNoLocalContract(workspace: string, beadId: string): void {
  if (!existsSync(existingLeaseDatabasePath(workspace))) return;
  const reader = new SqliteLeaseReader(workspace);
  try {
    const lease = reader.getWorkContractByBeadId(beadId);
    const pending = reader.pendingLifecycleForBead(beadId);
    const contractId = lease?.workContractId ?? pending[0]?.contractId;
    if (contractId) throw new Error(`cannot link existing local contract ${contractId}; inspect legacy status and resolve its lifecycle first`);
  } finally { reader.close(); }
}

function assertRemoteCanLink(observed: BeadsIssue): void {
  const active = observed.metadata && interlockMetadata(observed.metadata);
  if (observed.status !== "open" || observed.assignee !== undefined || active !== undefined || observed.metadataMalformed || (observed.metadata !== undefined && Object.hasOwn(observed.metadata, "interlock"))) throw new Error(`cannot link an active or terminal Beads issue; existing contract ${active?.contractId ?? "none"}; inspect legacy status and release it before linking`);
}
