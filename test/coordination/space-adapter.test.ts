import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../../src/cli/index.js";
import { createSpaceAdapter, coordinationStatePath } from "../../src/coordination/index.js";

const stateDirs: string[] = [];
const originalStateDir = process.env.INTERLOCK_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalStateDir;
  while (stateDirs.length > 0) rmSync(stateDirs.pop()!, { recursive: true, force: true });
});

function isolatedState(): void {
  const directory = mkdtempSync(join(tmpdir(), "interlock-space-adapter-test-"));
  stateDirs.push(directory);
  process.env.INTERLOCK_STATE_DIR = directory;
}

function nativeJson(argv: string[]): any {
  const result = runCli(argv);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("space.js operations delegate to one Interlock coordination state", () => {
  isolatedState();
  const adapter = createSpaceAdapter();

  adapter.session({ pane: "wT:p4", state: "busy" });
  const sent = adapter.send({ fromPane: "wT:p1", toPane: "wT:p4", text: "branch is ready", workspace: "wT" });
  assert.equal(sent.message.toPane, "wT:p4");
  assert.equal(nativeJson(["inbox", "--pane", "wT:p4", "--json"]).messages[0].text, "branch is ready");

  const idle = adapter.session({ pane: "wT:p4", state: "idle" });
  assert.equal(idle.digests.length, 1);
  assert.equal(adapter.watch().digested, 0);

  const inbox = adapter.inbox({ pane: "wT:p4" });
  assert.equal(inbox.messages[0].id, sent.message.id);
  assert.equal(inbox.digests[0].messageIds[0], sent.message.id);
  assert.equal(readFileSync(coordinationStatePath(), "utf8").includes("branch is ready"), true);

  const reply = adapter.send({ fromPane: "wT:p4", toPane: "wT:p1", reply: sent.message.id, text: "ack" });
  assert.equal(reply.message.replyTo, sent.message.id);
  assert.equal(reply.message.toPane, "wT:p1");
  assert.equal(nativeJson(["inbox", "--pane", "wT:p1", "--json"]).messages[0].text, "ack");
});
