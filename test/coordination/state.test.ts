import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { coordinationLockPath, coordinationStatePath, emptyCoordinationState, withCoordinationLock, writeCoordinationState } from "../../src/coordination/state.js";

const stateDirs: string[] = [];
const originalStateDir = process.env.INTERLOCK_STATE_DIR;
const originalLockTimeout = process.env.INTERLOCK_COORDINATION_LOCK_TIMEOUT_MS;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalStateDir;
  if (originalLockTimeout === undefined) delete process.env.INTERLOCK_COORDINATION_LOCK_TIMEOUT_MS;
  else process.env.INTERLOCK_COORDINATION_LOCK_TIMEOUT_MS = originalLockTimeout;
  while (stateDirs.length > 0) rmSync(stateDirs.pop()!, { recursive: true, force: true });
});

function isolatedState(): string {
  const directory = mkdtempSync(join(tmpdir(), "interlock-lock-test-"));
  stateDirs.push(directory);
  process.env.INTERLOCK_STATE_DIR = directory;
  return directory;
}

test("a stale-looking live lock owner is never broken and its token remains intact", () => {
  isolatedState();
  const lock = coordinationLockPath();
  const owner = JSON.stringify({ token: "live-holder", pid: process.pid, acquiredAt: Date.now() - 60_000 });
  writeFileSync(lock, owner);
  process.env.INTERLOCK_COORDINATION_LOCK_TIMEOUT_MS = "25";

  assert.throws(() => withCoordinationLock(() => undefined), /lock timeout/);
  assert.equal(readFileSync(lock, "utf8"), owner);
});

test("a lock owned by a dead process is reclaimed without leaving a lock behind", () => {
  isolatedState();
  writeFileSync(coordinationLockPath(), JSON.stringify({ token: "dead-holder", pid: 2147483647, acquiredAt: Date.now() - 60_000 }));

  withCoordinationLock((state) => { state.lastWatchAt = new Date().toISOString(); });
  assert.equal(readFileSync(coordinationStatePath(), "utf8").includes("lastWatchAt"), true);
  assert.throws(() => readFileSync(coordinationLockPath(), "utf8"), /ENOENT/);
});

test("writing state removes stale temporary files left by crashed writers", () => {
  const directory = isolatedState();
  const litter = join(directory, "state.json.tmp.99999");
  writeFileSync(litter, "{}");

  writeCoordinationState(emptyCoordinationState());
  assert.equal(existsSync(litter), false);
  assert.equal(existsSync(coordinationStatePath()), true);
});
