import type { ProcessIdentity } from "../core/types.js";
import type { VerificationCheck, VerificationResult } from "../contracts/verification.js";

export interface TaskContract {
  repositoryId: string;
  beadId: string;
  paths: string[];
  checks: VerificationCheck[];
}
export interface TaskResult {
  source: "agent-declared";
  summary: string;
  artifacts: string[];
}
export interface TaskExecution {
  contractId: string;
  process: ProcessIdentity;
  actor: string;
  workspace: string;
  acceptance: string;
  checks: VerificationCheck[];
  paths: string[];
  phase: "claim-pending" | "active" | "completion-pending" | "release-pending" | "done" | "released";
  claimedAt: string;
  result?: TaskResult;
  verification?: VerificationResult[];
  releaseReason?: string;
}
