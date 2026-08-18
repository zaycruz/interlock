import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { ChildProcessBeadsClient } from "../../src/beads/index.js";
import { runCli } from "../../src/cli/index.js";
import { interlockMetadata, type BeadsIssue, type InterlockMetadata } from "../../src/contracts/index.js";
import { openLeaseStore } from "../../src/core/index.js";
import { createTestRepository, type TestRepository } from "../helpers/git-repository.js";

const repositories: TestRepository[] = [];

afterEach(() => {
  while (repositories.length > 0) {
    repositories.pop()?.remove();
  }
});

function repository(): TestRepository {
  const value = createTestRepository();
  repositories.push(value);
  exec(value.path, ["init", "--non-interactive", "--skip-hooks", "--skip-agents", "--prefix", "interlocktest", "--quiet"]);
  assert.equal(existsSync(join(value.path, "AGENTS.md")), false);
  // bd init auto-stages its .beads housekeeping files and clears the index
  // only through a bootstrap commit that needs a resolvable git identity.
  // Where that identity is missing (Linux CI runners), the commit fails and
  // the staged set stays polluted. The work contract judges agent-staged
  // paths, not bd bookkeeping, so unstage whatever init left behind.
  execFileSync("git", ["-C", value.path, "reset", "--quiet"]);
  return value;
}

function createIssue(repositoryPath: string, title: string): string {
  const id = exec(repositoryPath, [
    "create", title,
    "--description", "Value: Keep lifecycle data correct.\n\nWork: Exercise the real Beads client.",
    "--acceptance", "Tests prove the real Beads integration.",
    "--silent",
  ]).trim();
  return id;
}

function exec(repositoryPath: string, args: string[]): string {
  return execFileSync("bd", args, { cwd: repositoryPath, encoding: "utf8" });
}

function metadataOf(issue: BeadsIssue): Record<string, unknown> {
  if (issue.metadata === undefined) assert.fail("expected object metadata");
  return issue.metadata;
}

function show(repositoryPath: string, id: string): Record<string, unknown> {
  const values = JSON.parse(exec(repositoryPath, ["show", id, "--json"])) as unknown;
  assert.ok(Array.isArray(values));
  assert.equal(values.length, 1);
  assert.equal(typeof values[0], "object");
  assert.notEqual(values[0], null);
  return values[0] as Record<string, unknown>;
}

test("runCli completes a real Beads and SQLite lifecycle in a disposable repository", () => {
  const testRepository = repository();
  const target = createIssue(testRepository.path, "CLI lifecycle issue");
  writeFileSync(join(testRepository.path, "owned.ts"), "export const owned = true;\n");
  const dependencies = {
    processIdentityFor: (pid: number) => ({ pid, startedAt: "stable-session" }),
    lifecycleProcessor: () => ({ pid: 902, startedAt: "stable-command" }),
  };
  const claim = runCli(["claim", target, "--actor", "integration-agent", "--session-pid", "901", "--path", "owned.ts", "--repo", testRepository.path], dependencies);
  assert.equal(claim.exitCode, 0, claim.stderr);
  const client = new ChildProcessBeadsClient(testRepository.path);
  const claimed = client.getIssue(target);
  assert.equal(claimed.metadataMalformed, false);
  const claimedMetadata = metadataOf(claimed);
  const contract = interlockMetadata(claimedMetadata);
  assert.equal(claimed.status, "in_progress"); assert.equal(claimed.assignee, "integration-agent");
  assert.notEqual(contract, undefined);

  execFileSync("git", ["-C", testRepository.path, "add", "owned.ts"]);
  const heartbeat = runCli(["heartbeat", target, "--repo", testRepository.path], dependencies);
  assert.equal(heartbeat.exitCode, 0, heartbeat.stderr);
  const heartbeated = client.getIssue(target);
  assert.equal(heartbeated.metadataMalformed, false);
  const heartbeatedMetadata = metadataOf(heartbeated);
  assert.equal(interlockMetadata(heartbeatedMetadata)?.contractId, contract?.contractId);

  const complete = runCli(["complete", target, "--repo", testRepository.path], dependencies);
  assert.equal(complete.exitCode, 0, complete.stderr);
  const completed = client.getIssue(target);
  assert.equal(completed.status, "closed"); assert.equal(completed.assignee, "integration-agent");
  const store = openLeaseStore(testRepository.path);
  assert.equal(store.getWorkContract(contract!.contractId), undefined);
  assert.deepEqual(store.completionEvents(), []);
  store.close();
});

test("ChildProcessBeadsClient parses real issue relationships and applies the one-call recovery marker transition", () => {
  const testRepository = repository();
  const upstream = createIssue(testRepository.path, "Upstream issue");
  const target = createIssue(testRepository.path, "Target issue");
  const downstream = createIssue(testRepository.path, "Downstream issue");
  exec(testRepository.path, ["dep", "add", target, upstream]);
  exec(testRepository.path, ["dep", "add", downstream, target]);
  exec(testRepository.path, ["update", target, "--metadata", JSON.stringify({ custom: "preserve", nested: { retained: true } })]);

  const client = new ChildProcessBeadsClient(testRepository.path);
  const issue = client.getIssue(target);
  assert.equal(issue.id, target);
  assert.equal(issue.acceptanceCriteria, "Tests prove the real Beads integration.");
  assert.deepEqual(client.dependencies(target), [{ id: upstream, title: "Upstream issue", status: "open" }]);
  assert.deepEqual(client.dependents(target), [{ id: downstream, title: "Downstream issue", status: "open" }]);

  const metadata: InterlockMetadata = {
    contractId: "contract-1",
    actor: "integration-agent",
    session: { pid: 123, startedAt: "integration-start" },
    paths: ["src/owned.ts"],
    leaseHealth: { status: "fresh", heartbeatAt: 100 },
  };
  client.claim(target, "integration-agent", metadata);

  const claimed = client.getIssue(target);
  assert.equal(claimed.metadataMalformed, false);
  const claimedMetadata = metadataOf(claimed);
  assert.equal(claimedMetadata.custom, "preserve");
  assert.deepEqual(claimedMetadata.nested, { retained: true });
  assert.deepEqual(interlockMetadata(claimedMetadata), metadata);
  const rawClaimed = show(testRepository.path, target);
  assert.equal(rawClaimed.status, "in_progress");
  assert.equal(rawClaimed.assignee, "integration-agent");

  client.recover(target, { eventId: 7, contractId: "contract-1" });

  const cleaned = client.getIssue(target);
  assert.equal(cleaned.metadataMalformed, false);
  const cleanedMetadata = metadataOf(cleaned);
  assert.equal(cleanedMetadata.custom, "preserve");
  assert.deepEqual(cleanedMetadata.nested, { retained: true });
  assert.equal(interlockMetadata(cleanedMetadata), undefined);
  assert.deepEqual(JSON.parse(cleanedMetadata["interlock.recovery"] as string), { eventId: 7, contractId: "contract-1" });
  const rawCleaned = show(testRepository.path, target);
  assert.equal(rawCleaned.status, "open");
  assert.equal(rawCleaned.assignee, undefined);
});
