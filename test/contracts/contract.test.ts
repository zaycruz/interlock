import assert from "node:assert/strict";
import test from "node:test";

import { IssueValidationError, interlockMetadata, renderWorkContract, validateIssue, type BeadsIssue } from "../../src/contracts/index.js";

const issue: BeadsIssue = {
  id: "il-1",
  title: "Build lease command",
  description: "Value: Agents avoid accidental file collisions.\n\nWork: Add the local lease command only.\n\nOut: Do not add network coordination.",
  acceptanceCriteria: "The CLI prints a contract.",
  status: "open",
  assignee: undefined,
  metadata: {},
  metadataMalformed: false,
};

test("validates required issue sections and renders every contract field", () => {
  const contract = renderWorkContract({
    issue: validateIssue(issue),
    paths: ["src/cli/run.ts"],
    upstream: [{ id: "il-0", title: "Core", status: "closed" }],
    downstream: [{ id: "il-2", title: "Extension", status: "open" }],
    leaseHealth: { status: "fresh", heartbeatAt: 0 },
    drift: undefined,
  });

  assert.match(contract, /Work contract: il-1 — Build lease command/);
  assert.match(contract, /Summary: Agents avoid accidental file collisions\./);
  assert.match(contract, /Value: Agents avoid accidental file collisions\./);
  assert.match(contract, /Work boundary: Add the local lease command only\./);
  assert.match(contract, /Non-goals \/ Out: Do not add network coordination\./);
  assert.match(contract, /Owned paths: src\/cli\/run.ts/);
  assert.match(contract, /Upstream dependencies: il-0 \(closed\) — Core/);
  assert.match(contract, /Downstream dependencies: il-2 \(open\) — Extension/);
  assert.match(contract, /Acceptance criteria: The CLI prints a contract\./);
  assert.match(contract, /Lease health: leased \(heartbeat 1970-01-01T00:00:00\.000Z\)/);
});

test("renders an expired lease health with its heartbeat timestamp", () => {
  const contract = renderWorkContract({
    issue: validateIssue(issue), paths: [], upstream: [], downstream: [],
    leaseHealth: { status: "expired", heartbeatAt: 0 }, drift: undefined,
  });
  assert.match(contract, /Lease health: expired \(heartbeat 1970-01-01T00:00:00\.000Z\)/);
});

test("keeps multi-line contract sections until the next section heading", () => {
  const validated = validateIssue({
    ...issue,
    description: "Value: First value line.\nSecond value line.\n\nWork: First work line.\nSecond work line.\n\nOut: None.",
  });
  assert.equal(validated.value, "First value line.\nSecond value line.");
  assert.equal(validated.work, "First work line.\nSecond work line.");
});

test("rejects issues missing Value, Work, or acceptance criteria", () => {
  for (const invalid of [
    { ...issue, description: "Work: work", acceptanceCriteria: "yes" },
    { ...issue, description: "Value: value", acceptanceCriteria: "yes" },
    { ...issue, acceptanceCriteria: "" },
  ]) {
    assert.throws(() => validateIssue(invalid), IssueValidationError);
  }
});

test("rejects unsafe or non-integral Interlock heartbeat metadata", () => {
  const base = {
    contractId: "contract-1", actor: "agent", session: { pid: 1, startedAt: "start" }, paths: ["src/owned.ts"],
    leaseHealth: { status: "fresh", heartbeatAt: 1 },
  };
  for (const heartbeatAt of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(interlockMetadata({ interlock: { ...base, leaseHealth: { status: "fresh", heartbeatAt } } }), undefined);
  }
  assert.equal(interlockMetadata({ interlock: { ...base, extra: true } }), undefined);
  assert.deepEqual(interlockMetadata({ interlock: base }), base);
});
