// U2: the MCP front door. The server wraps the public coordination CLI — the
// same runCoordinationCli the shell front door calls — so every write keeps
// the same token auth, boundary checks, state machine, and audit trail as the
// CLI (R3). Tests drive the server through the MCP protocol (client SDK over
// an in-memory transport), never through internal functions, and cross-check
// results against the raw CLI (R8 cross-host parity).
import assert from "node:assert/strict";
import { readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { runCli } from "../../src/cli/index.js";
import { createInterlockMcpServer } from "../../src/mcp/server.js";
import type { McpConfig } from "../../src/mcp/config.js";

const stateDirs: string[] = [];
const originalEnv = { stateDir: process.env.INTERLOCK_STATE_DIR, token: process.env.INTERLOCK_PANE_TOKEN };

afterEach(() => {
  restoreEnv();
  while (stateDirs.length > 0) rmSync(stateDirs.pop()!, { recursive: true, force: true });
});

function restoreEnv(): void {
  if (originalEnv.stateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
  else process.env.INTERLOCK_STATE_DIR = originalEnv.stateDir;
  if (originalEnv.token === undefined) delete process.env.INTERLOCK_PANE_TOKEN;
  else process.env.INTERLOCK_PANE_TOKEN = originalEnv.token;
}

function isolatedState(): string {
  const directory = mkdtempSync(join(tmpdir(), "interlock-mcp-test-"));
  stateDirs.push(directory);
  process.env.INTERLOCK_STATE_DIR = directory;
  return directory;
}

// JSON cross-checks: narrow once through these guards, then read typed fields.
function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value as unknown[];
}

function cliJson(result: ReturnType<typeof runCli>): Record<string, unknown> {
  assert.equal(result.exitCode, 0, result.stderr);
  return record(JSON.parse(result.stdout));
}

// Boot a pod with the given members; return one MCP config per pane.
function bootPod(pod: string, members: string[]): Record<string, McpConfig> {
  const directory = process.env.INTERLOCK_STATE_DIR!;
  const orchestrator = String(cliJson(runCli(["orchestrator", "init"])).token);
  const template = join(directory, `template-${pod}.json`);
  writeFileSync(template, JSON.stringify({ members, leader: members[0], succession: [...members] }));
  const created = cliJson(runCli(["pod", "create", "--name", pod, "--template", template, "--orchestrator-token", orchestrator]));
  const rawTokens = record(created.tokens);
  const tokens: Record<string, string> = {};
  for (const [member, token] of Object.entries(rawTokens)) if (typeof token === "string") tokens[member] = token;
  const configs: Record<string, McpConfig> = {};
  for (const member of members) configs[member] = { pane: member, token: tokens[member], stateDir: directory };
  return configs;
}

async function connect(config: McpConfig): Promise<Client> {
  const client = new Client({ name: "interlock-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createInterlockMcpServer(config);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function toolText(result: CallToolResult): string {
  const first = result.content[0];
  assert.ok(first !== undefined && first.type === "text");
  return first.text;
}

function payload(result: CallToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, "call must succeed: " + toolText(result));
  return record(JSON.parse(toolText(result)));
}

function errorText(result: CallToolResult): string {
  assert.equal(result.isError, true, "call must fail: " + toolText(result));
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

// R2: exactly five tools; anything the MCP surface does not expose, the agent
// does not do.
test("the registry lists exactly the five coordination tools", async () => {
  isolatedState();
  const configs = bootPod("eng", ["wT:p1", "wT:p4"]);
  const client = await connect(configs["wT:p1"]!);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["inbox_claim", "inbox_close", "inbox_list", "inbox_summary", "message_send"]);
});

// R3/R8: the MCP answer is the CLI answer — same bytes, same state.
test("inbox_list returns exactly what the CLI inbox --json returns", async () => {
  const directory = isolatedState();
  const configs = bootPod("eng", ["wT:p1", "wT:p4"]);
  runCli(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "ready", "--token", configs["wT:p1"]!.token!]);

  const client = await connect(configs["wT:p4"]!);
  const viaMcp = payload(await callTool(client, "inbox_list", {}));
  const viaCli = cliJson(runCli(["inbox", "--pane", "wT:p4", "--json", "--token", configs["wT:p4"]!.token!]));
  assert.deepEqual(viaMcp.messages, viaCli.messages);
  assert.equal(process.env.INTERLOCK_STATE_DIR, directory, "the server must not leak env mutation");
});

test("message_send, inbox_claim, and inbox_close mutate state identically to the CLI", async () => {
  isolatedState();
  const configs = bootPod("eng", ["wT:p1", "wT:p4"]);

  const client = await connect(configs["wT:p4"]!);
  const sender = await connect(configs["wT:p1"]!);
  const sent = payload(await callTool(sender, "message_send", { to: "wT:p4", text: "review the plan" }));
  const id = record(sent.message).id;
  assert.equal(id, 1);

  const claimed = payload(await callTool(client, "inbox_claim", { message: id }));
  assert.equal(record(claimed.message).state, "claimed");
  const closed = payload(await callTool(client, "inbox_close", { message: id }));
  assert.equal(record(closed.message).state, "closed");

  // Same shape through the raw CLI on the same state dir.
  const listed = cliJson(runCli(["inbox", "--pane", "wT:p4", "--all", "--json", "--token", configs["wT:p4"]!.token!]));
  const final = list(listed.messages).map(record).find((candidate) => candidate.id === id)!;
  assert.equal(final.state, "closed");
});

// The engine enforces that only the addressed pane may reply; the test must
// follow the protocol the tools document.
test("message_send replies on a thread and the parent hands back", async () => {
  isolatedState();
  const configs = bootPod("eng", ["wT:p1", "wT:p4"]);
  const recipient = await connect(configs["wT:p4"]!);
  const sender = await connect(configs["wT:p1"]!);
  const sent = payload(await callTool(recipient, "message_send", { to: "wT:p1", text: "question" }));
  const id = record(sent.message).id;
  const replied = payload(await callTool(sender, "message_send", { reply_to: id, text: "answered" }));
  const reply = record(replied.message);
  assert.equal(reply.replyTo, id);
  assert.equal(reply.threadId, id);
  assert.equal(reply.toPane, "wT:p4", "the reply routes back to the thread's sender");
});

test("inbox_summary counts pending and lists digests without message bodies", async () => {
  isolatedState();
  const configs = bootPod("eng", ["wT:p1", "wT:p4"]);
  const sender = await connect(configs["wT:p1"]!);
  await callTool(sender, "message_send", { to: "wT:p4", text: "QWERTY-body-must-not-leak" });
  // Idle fires the agent-idle digest the recipient has not drained.
  runCli(["session", "set", "--pane", "wT:p4", "--state", "idle", "--token", configs["wT:p4"]!.token!]);

  const client = await connect(configs["wT:p4"]!);
  const summary = payload(await callTool(client, "inbox_summary", {}));
  assert.equal(summary.pending, 1);
  const digests = list(summary.digests).map(record);
  assert.equal(digests.length, 1);
  assert.equal(digests[0]!.reason, "agent-idle");
  assert.deepEqual(digests[0]!.messageIds, [1]);
  const raw = JSON.stringify(summary);
  assert.equal(raw.includes("QWERTY-body-must-not-leak"), false, "summary is pointer-shaped: counts, ids, files — never bodies");
});

// AE3: a failed call changes nothing, byte for byte — including the pending
// files from U1.
function snapshotTree(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[relative(directory, full)] = readFileSync(full).toString("base64");
    }
  };
  walk(directory);
  return files;
}

test("authentication failures return the CLI error and change no state bytes", async () => {
  const directory = isolatedState();
  const configs = bootPod("eng", ["wT:p1", "wT:p4"]);
  const token = configs["wT:p1"]!.token!;
  runCli(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "seed", "--token", token]);

  const cases: { label: string; config: McpConfig }[] = [
    { label: "missing token", config: { pane: "wT:p4", stateDir: directory } },
    { label: "wrong token", config: { pane: "wT:p4", token: "wrong-token-wrong-token", stateDir: directory } },
    { label: "unregistered pane", config: { pane: "wT:p9", token, stateDir: directory } },
  ];
  for (const testCase of cases) {
    const before = snapshotTree(directory);
    const client = await connect(testCase.config);
    const listed = await callTool(client, "inbox_list", {});
    assert.ok(errorText(listed).trim().length > 0, testCase.label + ": error must carry the CLI stderr");
    assert.deepEqual(snapshotTree(directory), before, testCase.label + ": state bytes unchanged");
    const sent = await callTool(client, "message_send", { to: "wT:p1", text: "should not land" });
    assert.ok(errorText(sent).trim().length > 0, testCase.label + ": send error must carry the CLI stderr");
    assert.deepEqual(snapshotTree(directory), before, testCase.label + ": send changed nothing");
  }
});

// Error parity: what the CLI prints, the tool surfaces — no second error model.
test("tool errors carry the CLI stderr text verbatim", async () => {
  isolatedState();
  const configs = bootPod("eng", ["wT:p1", "wT:p4"]);
  const cliFailure = runCli(["inbox", "claim", "--message", "99", "--pane", "wT:p4", "--token", configs["wT:p4"]!.token!]);
  assert.notEqual(cliFailure.exitCode, 0);

  const client = await connect(configs["wT:p4"]!);
  const text = errorText(await callTool(client, "inbox_claim", { message: 99 }));
  assert.ok(text.includes("unknown message #99"), text);
});

// AE7 baseline: the compiled bin completes a real stdio handshake and answers
// tools/list, so any stdio host (Codex, Claude Code, OMP) can wire it.
test("the stdio bin answers initialize and tools/list", async () => {
  const directory = isolatedState();
  const configs = bootPod("eng", ["wT:p1", "wT:p4"]);
  runCli(["send", "--from-pane", "wT:p1", "--to-pane", "wT:p4", "--text", "seed over stdio", "--token", configs["wT:p1"]!.token!]);
  restoreEnv(); // the child gets its own env below; this process must stay clean

  const binPath = fileURLToPath(new URL("../../src/mcp/main.js", import.meta.url));
  const client = new Client({ name: "interlock-stdio-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, INTERLOCK_PANE: "wT:p4", INTERLOCK_PANE_TOKEN: configs["wT:p4"]!.token!, INTERLOCK_STATE_DIR: directory },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 5);
  const body = payload(await callTool(client, "inbox_list", {}));
  assert.equal(list(body.messages).length, 1, "the seeded send is visible over stdio");
  await client.close();
});
