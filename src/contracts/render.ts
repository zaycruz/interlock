import type { BeadsDependency, WorkContract } from "./issue.js";

export function renderWorkContract(contract: WorkContract): string {
  const { issue } = contract;
  return [
    `Work contract: ${issue.issue.id} — ${issue.issue.title}`,
    `Summary: ${oneSentence(issue.value)}`,
    "",
    `Value: ${issue.value}`,
    `Work boundary: ${issue.work}`,
    `Non-goals / Out: ${issue.out}`,
    `Owned paths: ${list(contract.paths)}`,
    `Upstream dependencies: ${dependencies(contract.upstream)}`,
    `Downstream dependencies: ${dependencies(contract.downstream)}`,
    `Acceptance criteria: ${issue.acceptanceCriteria}`,
    `Lease health: ${contract.drift === undefined ? leaseHealth(contract.leaseHealth) : `drift (${contract.drift})`}`,
  ].join("\n");
}

function leaseHealth(health: WorkContract["leaseHealth"]): string {
  if (health === undefined) return "not leased";
  const timestamp = new Date(health.heartbeatAt).toISOString();
  return health.status === "expired" ? `expired (heartbeat ${timestamp})` : `leased (heartbeat ${timestamp})`;
}

function oneSentence(value: string): string {
  const sentence = value.match(/^(.+?[.!?])(?:\s|$)/)?.[1];
  return sentence ?? value.replace(/\s+/g, " ");
}

function list(paths: string[]): string {
  return paths.length === 0 ? "none" : paths.join(", ");
}

function dependencies(values: BeadsDependency[]): string {
  return values.length === 0 ? "none" : values.map((value) => `${value.id} (${value.status}) — ${value.title}`).join("; ");
}
