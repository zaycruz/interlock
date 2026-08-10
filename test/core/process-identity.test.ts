import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { currentProcessIdentity, inspectProcess } from "../../src/core/index.js";

test("uses a strong identity for the current Linux process", { skip: process.platform !== "linux" }, () => {
  const identity = currentProcessIdentity();

  assert.match(identity.startedAt, /^linux:\d+$/);
  assert.equal(inspectProcess(identity), "alive");
});

test("treats only the normal Darwin no-process ps result as dead", { skip: process.platform !== "darwin" }, () => {
  withFakePs("#!/bin/sh\nexit 1\n", () => {
    assert.equal(inspectProcess({ pid: 99_998, startedAt: "ps:irrelevant" }), "dead");
  });
});

test("retains Darwin leases when ps inspection is invalid, signaled, malformed, locale-dependent, or unavailable", { skip: process.platform !== "darwin" }, () => {
  for (const script of [
    "#!/bin/sh\nprintf 'ps: Invalid process id: 999999\\n' >&2\nexit 1\n",
    "#!/bin/sh\nkill -TERM $$\n",
    "#!/bin/sh\nprintf 'not a process start\\n'\nexit 1\n",
    "#!/bin/sh\nprintf 'Lun Jan  1 00:00:00 2026\\n'\n",
  ]) {
    withFakePs(script, () => {
      assert.equal(inspectProcess({ pid: 99_998, startedAt: "ps:irrelevant" }), "unknown");
    });
  }

  withFakePs("#!/bin/sh\nexit 1\n", () => {
    assert.equal(inspectProcess({ pid: 0, startedAt: "ps:irrelevant" }), "unknown");
  });

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "/interlock-missing-ps";
    assert.equal(inspectProcess({ pid: 99_998, startedAt: "ps:irrelevant" }), "unknown");
  } finally {
    process.env.PATH = originalPath;
  }
});

function withFakePs(script: string, run: () => void): void {
  const directory = mkdtempSync(join(tmpdir(), "interlock-fake-ps-"));
  const commandPath = join(directory, "ps");
  const originalPath = process.env.PATH;

  try {
    writeFileSync(commandPath, script, { mode: 0o755 });
    chmodSync(commandPath, 0o755);
    process.env.PATH = directory;
    run();
  } finally {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
}
