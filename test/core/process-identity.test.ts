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

test("treats failed or malformed ps inspection as unknown", { skip: process.platform === "linux" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "interlock-fake-ps-"));
  const commandPath = join(directory, "ps");
  const originalPath = process.env.PATH;

  try {
    for (const script of [
      "#!/bin/sh\nexit 1\n",
      "#!/bin/sh\nkill -TERM $$\n",
      "#!/bin/sh\nprintf 'not a process start\\n'\n",
    ]) {
      writeFileSync(commandPath, script, { mode: 0o755 });
      chmodSync(commandPath, 0o755);
      process.env.PATH = directory;

      assert.equal(inspectProcess({ pid: process.pid, startedAt: "ps:irrelevant" }), "unknown");
    }

    process.env.PATH = join(directory, "missing");
    assert.equal(inspectProcess({ pid: process.pid, startedAt: "ps:irrelevant" }), "unknown");
  } finally {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
