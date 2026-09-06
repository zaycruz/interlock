// U2: the tool layer. Each handler maps an MCP tool call onto the public
// coordination CLI (runCoordinationCli) — the same entry the shell front door
// uses — so auth, boundary enforcement, state transitions, and audit stay in
// exactly one place (R3). There is deliberately no second error model here:
// non-zero exit becomes an MCP tool error carrying the CLI's stderr text
// verbatim.
import { z } from "zod";

import { runCoordinationCli } from "../coordination/index.js";
import type { McpConfig } from "./config.js";

// Structurally a subset of the SDK's CallToolResult (which demands a string
// index signature); kept here so handlers stay SDK-agnostic.
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
export type ToolHandler = (args: Record<string, unknown>) => ToolResult;


// The token travels to the engine the same way it does for a shell agent:
// the engine's INTERLOCK_PANE_TOKEN fallback (never argv — argv is world-
// readable via ps). The write is scoped to the synchronous call and restored
// so the server never leaks one pane's identity into another's process env.
// INVARIANT: `run` MUST stay synchronous end-to-end. process.env is
// process-global; an async handler that awaits inside this window would let
// a concurrent tools/call observe or overwrite another pane's env.
function withPaneEnv<T>(config: McpConfig, run: () => T): T {
  const savedToken = process.env.INTERLOCK_PANE_TOKEN;
  const savedStateDir = process.env.INTERLOCK_STATE_DIR;
  if (config.token !== undefined) process.env.INTERLOCK_PANE_TOKEN = config.token;
  if (config.stateDir !== undefined) process.env.INTERLOCK_STATE_DIR = config.stateDir;
  try {
    return run();
  } finally {
    if (savedToken === undefined) delete process.env.INTERLOCK_PANE_TOKEN;
    else process.env.INTERLOCK_PANE_TOKEN = savedToken;
    if (savedStateDir === undefined) delete process.env.INTERLOCK_STATE_DIR;
    else process.env.INTERLOCK_STATE_DIR = savedStateDir;
  }
}

// Seam for the token-argv regression test: every engine call flows through
// this indirection so a test can capture the exact argv arrays the server
// produces and assert none carries --token. Tests restore the real runner.
export const engineRunner: { run: typeof runCoordinationCli } = { run: runCoordinationCli };

export function invoke(config: McpConfig, argv: string[]): ToolResult {
  const result = withPaneEnv(config, () => engineRunner.run(argv));
  if (result === null) throw new Error("not a coordination command: " + argv.join(" "));
  if (result.exitCode !== 0) return { isError: true, content: [{ type: "text", text: result.stderr.trim() === "" ? "coordination CLI failed" : result.stderr.trim() }] };
  const structuredContent = z.record(z.string(), z.unknown()).parse(JSON.parse(result.stdout));
  return { content: [{ type: "text", text: result.stdout }], structuredContent };
}

function textArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function optionalTextArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

// inbox --json is the whole truth for the pane: messages plus digest
// deliveries plus any repaired redeliveries. The tool passes it through
// unchanged so the MCP answer is the CLI answer (R8).
function inboxListHandler(config: McpConfig): ToolHandler {
  return (args) => {
    const argv = ["inbox", "--pane", config.pane, "--json"];
    const thread = numberArg(args, "thread");
    const task = optionalTextArg(args, "task");
    if (thread !== undefined) argv.push("--thread", String(thread));
    if (task !== undefined) argv.push("--task", task);
    return invoke(config, argv);
  };
}

function inboxSummaryHandler(config: McpConfig): ToolHandler {
  return () => {
    const result = invoke(config, ["inbox", "summary", "--pane", config.pane]);
    if (result.isError) return result;
    const parsed = z.object({ pending: z.object({ total: z.number() }) }).passthrough().parse(result.structuredContent);
    const structuredContent = { ...parsed, pending: parsed.pending.total };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  };
}

function inboxMutationHandler(config: McpConfig, action: "claim" | "close"): ToolHandler {
  return (args) => {
    const id = numberArg(args, "message");
    if (id === undefined) throw new Error("message must be a positive integer");
    return invoke(config, ["inbox", action, "--message", String(id), "--pane", config.pane]);
  };
}

function messageSendHandler(config: McpConfig): ToolHandler {
  return (args) => {
    // `--text=` (equals form) so a body that itself starts with `--` is
    // delivered verbatim instead of being re-classified as a CLI flag.
    const argv = ["send", "--from-pane", config.pane, "--text=" + textArg(args, "text")];
    const to = optionalTextArg(args, "to");
    if (to !== undefined) argv.push("--to-pane", to);
    const replyTo = numberArg(args, "reply_to");
    if (replyTo !== undefined) argv.push("--reply", String(replyTo));
    const channel = numberArg(args, "channel");
    if (channel !== undefined) argv.push("--channel", String(channel));
    const task = optionalTextArg(args, "task");
    if (task !== undefined) argv.push("--task", task);
    const requestId = optionalTextArg(args, "request_id");
    if (requestId !== undefined) argv.push("--request-id", requestId);
    return invoke(config, argv);
  };
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  readOnly?: boolean;
  handler: (config: McpConfig) => ToolHandler;
}

// The five-tool surface (R2). Descriptions carry the protocol the agent must
// follow — claim before acting, close only after replying — because the
// description is the only always-visible documentation on a host that renders
// no richer guidance.
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "inbox_list",
    description: "List this pane's pending coordination messages (queued and claimed) plus delivered digests. Pull-based: call it at natural seams, not on every step.",
    schema: { thread: z.number().int().positive().optional(), task: z.string().min(1).optional() },
    outputSchema: { ok: z.boolean(), pane: z.string(), messages: z.array(z.record(z.string(), z.unknown())), digests: z.array(z.record(z.string(), z.unknown())), redelivered: z.array(z.number()) },
    handler: inboxListHandler,
  },
  {
    name: "inbox_summary",
    description: "Cheap pending-work check for this pane: how many messages are pending and which digest files exist. Returns no message bodies. Read a digest file only when the summary says work is waiting.",
    schema: {},
    outputSchema: { ok: z.boolean(), pane: z.string(), pending: z.number(), digests: z.array(z.record(z.string(), z.unknown())), digestTotal: z.number(), digestsTruncated: z.boolean() },
    readOnly: true,
    handler: inboxSummaryHandler,
  },
  {
    name: "inbox_claim",
    description: "Claim a pending message by id before acting on it. Claimed still counts as pending: the sender expects a reply and a close.",
    schema: { message: z.number().int().positive().describe("message id from inbox_list") },
    outputSchema: { ok: z.boolean(), message: z.record(z.string(), z.unknown()) },
    handler: (config) => inboxMutationHandler(config, "claim"),
  },
  {
    name: "inbox_close",
    description: "Mark a handled message closed after you have replied (message_send with reply_to). Close only when the thread is actually done.",
    schema: { message: z.number().int().positive().describe("message id to close") },
    outputSchema: { ok: z.boolean(), message: z.record(z.string(), z.unknown()) },
    handler: (config) => inboxMutationHandler(config, "close"),
  },
  {
    name: "message_send",
    description: "Send a message to another pane, or reply to a thread with reply_to (this hands the thread back to the original sender). Sends are quiet: no interrupt is delivered.",
    schema: {
      to: z.string().min(1).describe("recipient pane (omit when reply_to is set; the reply routes to the thread's sender)").optional(),
      text: z.string().min(1).describe("message body"),
      task: z.string().min(1).describe("task ID for durable work context").optional(),
      request_id: z.string().min(1).describe("Stable sender request ID. Reuse it only to retry the identical send.").optional(),
      reply_to: z.number().int().positive().describe("message id of the message being answered").optional(),
      channel: z.number().int().positive().describe("leader channel id, for channel sends only").optional(),
    },
    outputSchema: { ok: z.boolean(), message: z.record(z.string(), z.unknown()), digests: z.array(z.record(z.string(), z.unknown())), deduplicated: z.boolean() },
    handler: messageSendHandler,
  },
];
