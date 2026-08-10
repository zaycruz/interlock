import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, test } from "node:test";

import {
  LeaseCollisionError,
  LeaseOwnershipError,
  LeasePathError,
  openLeaseStore,
  type ProcessInspector,
} from "../../src/core/index.js";
import { createLinkedWorktree, createTestRepository, type TestRepository } from "../helpers/git-repository.js";

const repositories: TestRepository[] = [];

afterEach(() => {
  while (repositories.length > 0) {
    repositories.pop()?.remove();
  }
});

function repository(): TestRepository {
  const testRepository = createTestRepository();
  repositories.push(testRepository);
  return testRepository;
}

function inspector(status: ReturnType<ProcessInspector>): ProcessInspector {
  return () => status;
}

const owner = {
  actor: "pi-lease-core",
  beadId: "il-4xl.1",
  process: { pid: 101, startedAt: "process-101" },
};

const otherOwner = {
  actor: "pi-other",
  beadId: "il-4xl.2",
  process: { pid: 202, startedAt: "process-202" },
};

test("acquires normalized repository-relative paths in the Git common directory", () => {
  const testRepository = repository();
  const store = openLeaseStore(testRepository.path, { processInspector: inspector("alive") });

  const lease = store.acquire({
    workContractId: "contract-1",
    owner,
    paths: ["src//core/lease-store.ts", "test/core/lease-store.test.ts"],
  });

  assert.deepEqual(lease.paths, ["src/core/lease-store.ts", "test/core/lease-store.test.ts"]);
  assert.equal(lease.owner.actor, owner.actor);
  assert.equal(lease.owner.beadId, owner.beadId);
  assert.match(store.databasePath, /\.git\/interlock\/leases\.sqlite$/);

  const linkedWorktree = createLinkedWorktree(testRepository);
  repositories.push(linkedWorktree);
  const linkedStore = openLeaseStore(linkedWorktree.path, { processInspector: inspector("alive") });
  assert.equal(linkedStore.databasePath, store.databasePath);
  assert.throws(
    () => linkedStore.acquire({
      workContractId: "contract-2",
      owner: otherOwner,
      paths: ["src/core/lease-store.ts"],
    }),
    LeaseCollisionError,
  );

  linkedStore.close();
  store.close();
});

test("rejects absolute paths, traversal, trailing separators, globs, and duplicate normalized paths", () => {
  const testRepository = repository();
  const store = openLeaseStore(testRepository.path, { processInspector: inspector("alive") });

  for (const paths of [
    ["/tmp/file.ts"],
    ["C:\\tmp\\file.ts"],
    ["C:tmp\\file.ts"],
    ["src/../file.ts"],
    ["src/directory/"],
    ["src\\directory\\"],
    ["src/*.ts"],
    ["src//file.ts", "src/file.ts"],
  ]) {
    assert.throws(
      () => store.acquire({ workContractId: crypto.randomUUID(), owner, paths }),
      LeasePathError,
    );
  }

  store.close();
});

test("canonicalizes case aliases on a case-insensitive Git repository", () => {
  const testRepository = repository();
  execFileSync("git", ["-C", testRepository.path, "config", "core.ignorecase", "true"]);

  const store = openLeaseStore(testRepository.path, { processInspector: inspector("alive") });
  store.acquire({ workContractId: "contract-1", owner, paths: ["src/core/lease-store.ts"] });

  assert.throws(
    () => store.acquire({
      workContractId: "contract-2",
      owner: otherOwner,
      paths: ["SRC/CORE/LEASE-STORE.TS"],
    }),
    LeaseCollisionError,
  );
  store.close();
});

test("rejects a live collision with the current owner and Beads issue", () => {
  const testRepository = repository();
  const store = openLeaseStore(testRepository.path, { processInspector: inspector("alive") });
  store.acquire({ workContractId: "contract-1", owner, paths: ["src/core/lease-store.ts"] });

  assert.throws(
    () => store.acquire({
      workContractId: "contract-2",
      owner: otherOwner,
      paths: ["src/core/lease-store.ts"],
    }),
    (error: unknown) => {
      assert.ok(error instanceof LeaseCollisionError);
      assert.deepEqual(error.collisions, [{
        path: "src/core/lease-store.ts",
        workContractId: "contract-1",
        actor: owner.actor,
        beadId: owner.beadId,
      }]);
      return true;
    },
  );

  store.close();
});

test("heartbeats only the owning work contract", () => {
  const testRepository = repository();
  let now = 100;
  const store = openLeaseStore(testRepository.path, {
    clock: () => now,
    processInspector: inspector("alive"),
  });
  const acquired = store.acquire({ workContractId: "contract-1", owner, paths: ["src/core/lease-store.ts"] });

  now = 200;
  const heartbeated = store.heartbeat({ workContractId: "contract-1", owner });
  assert.equal(heartbeated.heartbeatAt, 200);
  assert.equal(acquired.heartbeatAt, 100);

  assert.throws(
    () => store.heartbeat({ workContractId: "contract-1", owner: otherOwner }),
    LeaseOwnershipError,
  );
  store.close();
});

test("reads a complete work contract with its leased paths", () => {
  const testRepository = repository();
  const store = openLeaseStore(testRepository.path, {
    clock: () => 100,
    processInspector: inspector("alive"),
  });
  store.acquire({
    workContractId: "contract-1",
    owner,
    paths: ["src/core/lease-store.ts", "test/core/lease-store.test.ts"],
  });

  assert.deepEqual(store.getWorkContract("contract-1"), {
    workContractId: "contract-1",
    owner,
    paths: ["src/core/lease-store.ts", "test/core/lease-store.test.ts"],
    acquiredAt: 100,
    heartbeatAt: 100,
  });
  store.close();
});

test("releases every path in an owned work contract", () => {
  const testRepository = repository();
  const store = openLeaseStore(testRepository.path, { processInspector: inspector("alive") });
  store.acquire({
    workContractId: "contract-1",
    owner,
    paths: ["src/core/lease-store.ts", "test/core/lease-store.test.ts"],
  });

  const released = store.release({ workContractId: "contract-1", owner });

  assert.deepEqual(released.paths, ["src/core/lease-store.ts", "test/core/lease-store.test.ts"]);
  assert.equal(store.getWorkContract("contract-1"), undefined);
  store.close();
});

test("reclaims a heartbeat-expired lease only when its recorded process is verified dead", () => {
  const testRepository = repository();
  let now = 100;
  const store = openLeaseStore(testRepository.path, {
    clock: () => now,
    staleAfterMs: 50,
    processInspector: (process) => process.pid === owner.process.pid ? "dead" : "alive",
  });
  store.acquire({ workContractId: "contract-1", owner, paths: ["src/core/lease-store.ts"] });

  now = 200;
  const reconciliation = store.reconcileStaleSessions();

  assert.deepEqual(reconciliation.released, [{
    workContractId: "contract-1",
    paths: ["src/core/lease-store.ts"],
    processStatus: "dead",
    heartbeatState: "expired",
  }]);
  assert.equal(store.getWorkContract("contract-1"), undefined);
  store.close();
});

test("reclaims a dead collision while atomically acquiring a new contract", () => {
  const testRepository = repository();
  let now = 100;
  const store = openLeaseStore(testRepository.path, {
    clock: () => now,
    staleAfterMs: 50,
    processInspector: (process) => process.pid === owner.process.pid ? "mismatched" : "alive",
  });
  store.acquire({ workContractId: "contract-1", owner, paths: ["src/core/lease-store.ts"] });

  now = 200;
  const lease = store.acquire({
    workContractId: "contract-2",
    owner: otherOwner,
    paths: ["src/core/lease-store.ts"],
  });

  assert.equal(lease.workContractId, "contract-2");
  assert.equal(store.getWorkContract("contract-1"), undefined);
  store.close();
});

test("retains an expired lease when process identity is ambiguous", () => {
  const testRepository = repository();
  let now = 100;
  const store = openLeaseStore(testRepository.path, {
    clock: () => now,
    staleAfterMs: 50,
    processInspector: inspector("ambiguous"),
  });
  store.acquire({ workContractId: "contract-1", owner, paths: ["src/core/lease-store.ts"] });

  now = 200;
  const reconciliation = store.reconcileStaleSessions();

  assert.deepEqual(reconciliation.released, []);
  assert.deepEqual(reconciliation.retained, [{
    workContractId: "contract-1",
    processStatus: "ambiguous",
    heartbeatState: "expired",
  }]);
  assert.notEqual(store.getWorkContract("contract-1"), undefined);
  store.close();
});

test("does not reclaim a process that cannot be verified solely because its heartbeat is expired", () => {
  const testRepository = repository();
  let now = 100;
  const store = openLeaseStore(testRepository.path, {
    clock: () => now,
    staleAfterMs: 50,
    processInspector: inspector("unknown"),
  });
  store.acquire({ workContractId: "contract-1", owner, paths: ["src/core/lease-store.ts"] });

  now = 200;
  const reconciliation = store.reconcileStaleSessions();

  assert.deepEqual(reconciliation.released, []);
  assert.deepEqual(reconciliation.retained, [{
    workContractId: "contract-1",
    processStatus: "unknown",
    heartbeatState: "expired",
  }]);
  store.close();
});
