import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { runCoordinationCli, coordinationStatePath } from "@raava-solutions/interlock/coordination";
import { createSpaceAdapter } from "../src/index.js";

const stateDirs: string[] = [];
const originalStateDir = process.env.INTERLOCK_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalStateDir;
  while (stateDirs.length > 0) rmSync(stateDirs.pop()!, { recursive: true, force: true });
});

function isolatedState(): void {
  const directory = mkdtempSync(join(tmpdir(), "interlock-plugin-herdr-test-"));
  stateDirs.push(directory);
  process.env.INTERLOCK_STATE_DIR = directory;
}

function nativeJson(argv: string[]): any {
  const result = runCoordinationCli(argv);
  if (result === null) throw new Error(`Interlock did not recognize ${argv[0]}`);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("herdr adapter delegates pane-shaped calls to the Interlock public coordination surface", () => {
  isolatedState();
  const adapter = createSpaceAdapter();
  const orchestrator = nativeJson(["orchestrator", "init"]).token as string;
  const template = join(process.env.INTERLOCK_STATE_DIR!, "template-eng.json");
  writeFileSync(template, JSON.stringify({ members: ["wT:p1", "wT:p4"], leader: "wT:p1", succession: ["wT:p1", "wT:p4"] }));
  const created = nativeJson(["pod", "create", "--name", "eng", "--template", template, "--orchestrator-token", orchestrator]);
  const p1Token = created.tokens["wT:p1"] as string;
  const p4Token = created.tokens["wT:p4"] as string;

  adapter.session({ pane: "wT:p4", token: p4Token, state: "busy" });
  const sent = adapter.send({ fromPane: "wT:p1", toPane: "wT:p4", token: p1Token, text: "branch is ready", workspace: "wT" });
  assert.equal(sent.message.toPane, "wT:p4");
  assert.equal(nativeJson(["inbox", "--pane", "wT:p4", "--token", p4Token, "--json"]).messages[0].text, "branch is ready");

  const idle = adapter.session({ pane: "wT:p4", token: p4Token, state: "idle" });
  assert.equal(idle.digests.length, 1);
  assert.equal(adapter.watch().digested, 0);

  const inbox = adapter.inbox({ pane: "wT:p4", token: p4Token });
  assert.equal(inbox.messages[0].id, sent.message.id);
  assert.equal(inbox.digests[0].messageIds[0], sent.message.id);
  assert.equal(readFileSync(coordinationStatePath(), "utf8").includes("branch is ready"), true);
});

test("herdr adapter forwards a leader channel for cross-pod sends", () => {
  isolatedState();
  const adapter = createSpaceAdapter();
  const orchestrator = nativeJson(["orchestrator", "init"]).token as string;
  const engTemplate = join(process.env.INTERLOCK_STATE_DIR!, "template-eng.json");
  const opsTemplate = join(process.env.INTERLOCK_STATE_DIR!, "template-ops.json");
  writeFileSync(engTemplate, JSON.stringify({ members: ["wT:p1"], leader: "wT:p1", succession: ["wT:p1"] }));
  writeFileSync(opsTemplate, JSON.stringify({ members: ["wQ:p1"], leader: "wQ:p1", succession: ["wQ:p1"] }));
  const eng = nativeJson(["pod", "create", "--name", "eng", "--template", engTemplate, "--orchestrator-token", orchestrator]);
  const ops = nativeJson(["pod", "create", "--name", "ops", "--template", opsTemplate, "--orchestrator-token", orchestrator]);
  const channel = nativeJson(["pod", "channel", "open", "--pod", "eng", "--to-pod", "ops", "--member", "wT:p1", "--token", eng.tokens["wT:p1"], "--topic", "release"]);

  const sent = adapter.send({ fromPane: "wT:p1", toPane: "wQ:p1", token: eng.tokens["wT:p1"], text: "ready", channel: channel.channel.id });

  assert.equal(sent.message.toPane, "wQ:p1");
  assert.equal(nativeJson(["inbox", "--pane", "wQ:p1", "--token", ops.tokens["wQ:p1"], "--json"]).messages[0].text, "ready");
});
