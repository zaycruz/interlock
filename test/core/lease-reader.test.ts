import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterEach, test } from "node:test";

import { existingLeaseDatabasePath, openLeaseReader, openLeaseStore, type LeaseStore } from "../../src/core/index.js";
import { createTestRepository, type TestRepository } from "../helpers/git-repository.js";

const repositories: TestRepository[] = [];
const owner = { actor: "reader-agent", beadId: "il-reader", process: { pid: 808, startedAt: "reader-start" } };

afterEach(() => { while (repositories.length > 0) repositories.pop()?.remove(); });

function repository(): TestRepository {
  const value = createTestRepository();
  repositories.push(value);
  return value;
}

function confirmed(store: LeaseStore): void {
  store.acquire({ workContractId: "reader-contract", owner, paths: ["src/reader.ts"] });
  store.markRemoteAttempted({ workContractId: "reader-contract", owner });
  store.confirmRemote({ workContractId: "reader-contract", owner });
}

test("read-only lease reader returns an existing contract without exposing mutation methods", () => {
  const repo = repository();
  const store = openLeaseStore(repo.path, { clock: () => 100 });
  confirmed(store);
  store.close();

  const reader = openLeaseReader(repo.path);
  assert.deepEqual(reader.getWorkContractByBeadId(owner.beadId), {
    workContractId: "reader-contract",
    owner,
    paths: ["src/reader.ts"],
    acquiredAt: 100,
    heartbeatAt: 100,
    remoteAttempted: true,
    remoteConfirmed: true,
    completing: false,
  });
  reader.close();
});

test("read-only lease reader lists contracts in deterministic work-contract order", () => {
  const repo = repository();
  const store = openLeaseStore(repo.path, { clock: () => 100 });
  store.acquire({
    workContractId: "contract-z",
    owner: { actor: "agent-z", beadId: "bead-z", process: { pid: 809, startedAt: "z-start" } },
    paths: ["src/z.ts"],
  });
  store.acquire({
    workContractId: "contract-a",
    owner: { actor: "agent-a", beadId: "bead-a", process: { pid: 810, startedAt: "a-start" } },
    paths: ["src/a.ts"],
  });
  store.close();

  const reader = openLeaseReader(repo.path);
  assert.deepEqual(reader.listWorkContracts().map((contract) => contract.workContractId), ["contract-a", "contract-z"]);
  reader.close();
});

test("opening the read-only reader is not a creation path", () => {
  const repo = repository();
  const databasePath = existingLeaseDatabasePath(repo.path);
  assert.equal(existsSync(databasePath), false);
  assert.throws(() => openLeaseReader(repo.path), /cannot open database|unable to open database|no such file|unable to open database file/i);
  assert.equal(existsSync(databasePath), false);
});
