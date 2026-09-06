import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { runCli } from "../../src/cli/index.js";
import { createInterlockMcpServer } from "../../src/mcp/server.js";

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function cli(argv: string[]): Record<string, unknown> {
  const result = runCli(argv);
  assert.equal(result.exitCode, 0, result.stderr);
  return record(JSON.parse(result.stdout));
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return record(result.structuredContent);
}
async function setup(t: TestContext): Promise<{ directory: string; first: Client; second: Client }> {
  const directory = mkdtempSync(join(tmpdir(), "interlock-mcp-work-"));
  const previous = process.env.INTERLOCK_STATE_DIR;
  process.env.INTERLOCK_STATE_DIR = join(directory, "coordination");
  t.after(() => {
    if (previous === undefined) delete process.env.INTERLOCK_STATE_DIR;
    else process.env.INTERLOCK_STATE_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const token = String(cli(["orchestrator", "init"]).token);
  const template = join(directory, "pod.json");
  writeFileSync(template, JSON.stringify({ members: ["agent-a", "agent-b"], leader: "agent-a", succession: ["agent-a", "agent-b"] }));
  const tokens = record(cli(["pod", "create", "--name", "delivery", "--template", template, "--orchestrator-token", token]).tokens);
  async function connect(pane: string): Promise<Client> {
    const client = new Client({ name: "interlock-workflow-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createInterlockMcpServer({ pane, token: String(tokens[pane]), stateDir: process.env.INTERLOCK_STATE_DIR }, [], "1");
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    t.after(() => client.close());
    await client.listTools();
    return client;
  }
  return { directory, first: await connect("agent-a"), second: await connect("agent-b") };
}

function git(repository: string, args: string[]): void {
  execFileSync("git", ["-C", repository, ...args], { stdio: "pipe" });
}
function bead(repository: string, args: string[]): string {
  return execFileSync("bd", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("MCP clients coordinate and complete linked work with observed evidence and no task CLI fallback", async (t) => {
  const { directory, first, second } = await setup(t);
  git(directory, ["init", "--quiet"]);
  git(directory, ["config", "user.name", "Interlock Test"]);
  git(directory, ["config", "user.email", "interlock@example.test"]);
  bead(directory, ["init", "--non-interactive", "--skip-hooks", "--skip-agents", "--prefix", "interlocktest", "--quiet"]);
  git(directory, ["reset", "--quiet"]);
  const criterion = "The result file contains 42.";
  const beadId = bead(directory, ["create", "Verified answer", "--description", "Value: Produce a correct answer.\n\nWork: Write answer.txt.", "--acceptance", criterion, "--silent"]);
  const contract = { beadId, paths: ["answer.txt"], checks: [{ criterion,
    command: [process.execPath, "-e", "if(require('fs').readFileSync('answer.txt','utf8')!=='42') process.exit(1); console.log('verified 42')"] }] };
  await call(first, "task_create", { id: "answer", title: "Answer", value: "Correct answer", workspace: directory, contract });
  const claimed = record((await call(first, "task_claim", { id: "answer" })).task);
  assert.equal(claimed.claimer, "agent-a");
  const staleHeartbeat = await first.callTool({ name: "task_heartbeat", arguments: { id: "answer", contract_id: "previous-execution" } });
  assert.equal(staleHeartbeat.isError, true);
  const contractId = record(claimed.execution).contractId;
  await call(first, "task_heartbeat", { id: "answer", contract_id: contractId });
  const collision = await second.callTool({ name: "task_claim", arguments: { id: "answer" } });
  assert.equal(collision.isError, true);
  await call(first, "task_checkpoint", { id: "answer", text: "Need confirmation before writing the result." });
  const request = { to: "agent-b", task: "answer", request_id: "confirm-answer-1", text: "Confirm the expected answer." };
  const original = record((await call(first, "message_send", request)).message);
  const retry = record((await call(first, "message_send", request)).message);
  assert.equal(retry.id, original.id);
  await call(second, "inbox_claim", { message: original.id });
  await call(second, "message_send", { reply_to: original.id, request_id: "confirm-answer-reply-1", text: "The answer must be 42." });
  const resumed = await call(first, "task_resume", { id: "answer" });
  assert.ok(Array.isArray(resumed.messages) && resumed.messages.length >= 1);
  writeFileSync(join(directory, "answer.txt"), "42");
  git(directory, ["add", "answer.txt"]);
  const completed = record((await call(first, "task_complete", { id: "answer", result: { summary: "Produced the verified answer.", artifacts: ["answer.txt"] } })).task);
  assert.equal(completed.stage, "done");
  const execution = record(completed.execution);
  assert.equal(execution.phase, "done");
  assert.ok(Array.isArray(execution.verification));
  const evidence = record(execution.verification[0]);
  assert.equal(evidence.passed, true);
  assert.equal(evidence.source, "interlock-executed");
  const issue = JSON.parse(bead(directory, ["show", beadId, "--json"]));
  assert.equal(issue[0].status, "closed");
});

test("MCP task correction requires current revision and creator authority", async (t) => {
  const { first, second } = await setup(t);
  const created = record((await call(first, "task_create", { id: "draft", title: "Draft", value: "Coordinate a decision" })).task);
  const denied = await second.callTool({ name: "task_update", arguments: { id: "draft", revision: created.revision, title: "Hijacked" } });
  assert.equal(denied.isError, true);
  const updated = record((await call(first, "task_update", { id: "draft", revision: created.revision, title: "Corrected" })).task);
  assert.equal(updated.title, "Corrected");
  const stale = await first.callTool({ name: "task_withdraw", arguments: { id: "draft", revision: created.revision, reason: "Obsolete" } });
  assert.equal(stale.isError, true);
  const withdrawn = record((await call(first, "task_withdraw", { id: "draft", revision: updated.revision, reason: "The decision is no longer needed." })).task);
  assert.equal(withdrawn.stage, "closed");
  await call(first, "task_create", { id: "decision", title: "Decision", value: "Agree on the next step" });
  await call(first, "task_claim", { id: "decision" });
  const completed = await call(first, "task_complete", { id: "decision", result: { summary: "Decision recorded", artifacts: ["discussion"] } });
  assert.equal(record(completed.task).stage, "done");
  assert.deepEqual(record(completed.task).result, { source: "agent-declared", summary: "Decision recorded", artifacts: ["discussion"] });
  assert.ok(Array.isArray(completed.digests));
});
