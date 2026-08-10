import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { currentProcessIdentity, inspectProcess } from "../../src/core/index.js";

test("uses a strong identity for the current Linux process", { skip: process.platform !== "linux" }, () => {
  const identity = currentProcessIdentity();

  assert.match(identity.startedAt, /^linux:\d+$/);
  assert.equal(inspectProcess(identity), "alive");
});

test("classifies an absent Darwin PID as dead from the signal-zero probe", { skip: process.platform !== "darwin" }, () => {
  assert.equal(inspectProcess({ pid: 99_998, startedAt: "ps:irrelevant" }), "dead");
});

test("runs Darwin ps with the C locale", { skip: process.platform !== "darwin" }, () => {
  withFakePs(
    "#!/bin/sh\nprintf '%s' \"$LC_ALL\" > \"$INTERLOCK_TEST_LOCALE_PATH\"\nprintf 'Mon Jan  1 00:00:00 2026\\n'\n",
    (directory) => {
      process.env.INTERLOCK_TEST_LOCALE_PATH = join(directory, "locale");
      assert.deepEqual(currentProcessIdentity(), { pid: process.pid, startedAt: "ps:Mon Jan  1 00:00:00 2026" });
      assert.equal(readFileSync(process.env.INTERLOCK_TEST_LOCALE_PATH, "utf8"), "C");
    },
  );
});

test("retains Darwin leases when ps identity inspection is silent, invalid, signaled, malformed, locale-dependent, or unavailable", { skip: process.platform !== "darwin" }, () => {
  for (const script of [
    "#!/bin/sh\nexit 1\n",
    "#!/bin/sh\nprintf 'ps: Invalid process id: 999999\\n' >&2\nexit 1\n",
    "#!/bin/sh\nkill -TERM $$\n",
    "#!/bin/sh\nprintf 'not a process start\\n'\nexit 1\n",
    "#!/bin/sh\nprintf 'Lun Jan  1 00:00:00 2026\\n'\n",
  ]) {
    withFakePs(script, () => {
      assert.equal(inspectProcess({ pid: process.pid, startedAt: "ps:irrelevant" }), "unknown");
    });
  }

  withFakePs("#!/bin/sh\nexit 1\n", () => {
    assert.equal(inspectProcess({ pid: 0, startedAt: "ps:irrelevant" }), "unknown");
  });

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "/interlock-missing-ps";
    assert.equal(inspectProcess({ pid: process.pid, startedAt: "ps:irrelevant" }), "unknown");
  } finally {
    process.env.PATH = originalPath;
  }
});

function withFakePs(script: string, run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "interlock-fake-ps-"));
  const commandPath = join(directory, "ps");
  const originalPath = process.env.PATH;
  const originalLocalePath = process.env.INTERLOCK_TEST_LOCALE_PATH;

  try {
    writeFileSync(commandPath, script, { mode: 0o755 });
    chmodSync(commandPath, 0o755);
    process.env.PATH = directory;
    run(directory);
  } finally {
    process.env.PATH = originalPath;
    process.env.INTERLOCK_TEST_LOCALE_PATH = originalLocalePath;
    rmSync(directory, { recursive: true, force: true });
  }
}
