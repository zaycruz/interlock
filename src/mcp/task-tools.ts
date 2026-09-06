import { z } from "zod";

import { invoke, type ToolHandler, type ToolSpec } from "./tools.js";
import type { McpConfig } from "./config.js";

const id = z.string().min(1).describe("Interlock task ID");
const revision = z.number().int().positive().describe("Current task revision from task_inspect");
const contractId = z.string().min(1).optional().describe("Expected execution contract ID. Reject the operation if ownership has changed.");
const contract = z.object({
  beadId: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  checks: z.array(z.object({
    criterion: z.string().min(1).describe("Exact acceptance item from the Beads issue"),
    command: z.array(z.string().min(1)).min(1),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
  }).strict()).min(1),
}).strict();
const taskOutput = { ok: z.boolean(), task: z.record(z.string(), z.unknown()), digests: z.array(z.record(z.string(), z.unknown())).optional() };

function taskHandler(action: string, flags: Readonly<Record<string, string>> = {}): (config: McpConfig) => ToolHandler {
  return (config) => (args) => {
    const argv = ["task", action];
    if (action !== "add" && typeof args.id === "string") argv.push(args.id);
    argv.push("--pane", config.pane, "--json");
    if (typeof args.contract_id === "string") argv.push("--contract-id", args.contract_id);
    if (action === "claim") argv.push("--session-pid", String(process.pid));
    for (const [argument, flag] of Object.entries(flags)) {
      const value = args[argument];
      if (value === undefined) continue;
      const serialized = typeof value === "object" ? JSON.stringify(value) : String(value);
      argv.push(`--${flag}=${serialized}`);
    }
    return invoke(config, argv);
  };
}

export const TASK_TOOL_SPECS: ToolSpec[] = [
  {
    name: "task_create",
    description: "Create useful work. Link coding work to its Beads issue, exact paths, and verification commands. A coordination-only task grants no file ownership.",
    schema: { id, title: z.string().min(1).describe("Required for coordination-only work. Linked work uses its Beads title.").optional(), value: z.string().min(1).describe("Required for coordination-only work. Linked work uses its Beads value.").optional(), workspace: z.string().min(1).optional(), contract: contract.optional(), owner: z.string().min(1).optional() },
    outputSchema: taskOutput,
    handler: taskHandler("add", { id: "id", title: "title", value: "value", workspace: "workspace", contract: "contract", owner: "owner-pane" }),
  },
  {
    name: "task_list",
    description: "Discover tasks and their current ownership. Inspect a task before claiming it.",
    schema: {},
    outputSchema: { ok: z.boolean(), tasks: z.array(z.record(z.string(), z.unknown())) },
    readOnly: true,
    handler: taskHandler("list"),
  },
  {
    name: "task_inspect",
    description: "Read a task's contract, ownership, execution state, and evidence. Inspection does not change ownership or reconcile pending operations.",
    schema: { id },
    outputSchema: taskOutput,
    readOnly: true,
    handler: taskHandler("inspect"),
  },
  {
    name: "task_resume",
    description: "Restore your owned work and authorized task messages after a restart or context reset. Omit id to see all your tasks.",
    schema: { id: id.optional() },
    outputSchema: { ok: z.boolean(), tasks: z.array(z.record(z.string(), z.unknown())), messages: z.array(z.record(z.string(), z.unknown())) },
    readOnly: true,
    handler: taskHandler("resume"),
  },
  {
    name: "task_update",
    description: "Correct eligible open work using its current revision. Active acceptance and path scope cannot be rewritten.",
    schema: { id, revision, title: z.string().min(1).optional(), value: z.string().min(1).optional(), workspace: z.string().min(1).optional(), contract: contract.optional(), owner: z.string().min(1).optional() },
    outputSchema: taskOutput,
    handler: taskHandler("update", { revision: "revision", title: "title", value: "value", workspace: "workspace", contract: "contract", owner: "owner-pane" }),
  },
  {
    name: "task_withdraw",
    description: "Withdraw obsolete open work with a reason and its current revision. Preserve its history.",
    schema: { id, revision, reason: z.string().min(1) },
    outputSchema: taskOutput,
    handler: taskHandler("withdraw", { revision: "revision", reason: "reason" }),
  },
  {
    name: "task_claim",
    description: "Claim exclusive task ownership. Coding work also acquires exact-path leases and captures acceptance checks. The server supplies its own process identity.",
    schema: { id },
    outputSchema: taskOutput,
    handler: taskHandler("claim"),
  },
  {
    name: "task_progress",
    description: "Report progress on your claimed task. This does not establish acceptance.",
    schema: { id },
    outputSchema: taskOutput,
    handler: taskHandler("progress"),
  },
  {
    name: "task_checkpoint",
    description: "Save the current finding and next action so another session can resume your task.",
    schema: { id, text: z.string().min(1) },
    outputSchema: taskOutput,
    handler: taskHandler("checkpoint", { text: "text" }),
  },
  {
    name: "task_block",
    description: "Record why your task cannot continue. State what must happen next in the reason.",
    schema: { id, reason: z.string().min(1) },
    outputSchema: taskOutput,
    handler: taskHandler("block", { reason: "reason" }),
  },
  {
    name: "task_heartbeat",
    description: "Renew your task's active linked lease. Do this at natural work seams while you own the task.",
    schema: { id, contract_id: contractId },
    outputSchema: taskOutput,
    handler: taskHandler("heartbeat"),
  },
  {
    name: "task_release",
    description: "Release your task and exact linked lease with a reason. Preserve its checkpoint for the next owner.",
    schema: { id, contract_id: contractId, reason: z.string().min(1) },
    outputSchema: taskOutput,
    handler: taskHandler("release", { reason: "reason" }),
  },
  {
    name: "task_complete",
    description: "Submit your result and artifact references. Interlock executes the captured acceptance checks and rejects missing evidence, failed checks, drift, or out-of-scope staged changes.",
    schema: { id, contract_id: contractId, result: z.object({ summary: z.string().min(1), artifacts: z.array(z.string().min(1)).min(1) }).strict() },
    outputSchema: taskOutput,
    handler: taskHandler("complete", { result: "result" }),
  },
  {
    name: "task_recover",
    description: "Recover a task whose captured execution process is verified dead. Quiet or unverifiable processes remain protected.",
    schema: { id, contract_id: contractId },
    outputSchema: taskOutput,
    handler: taskHandler("recover"),
  },
  {
    name: "task_resolve",
    description: "Resolve a pending linked operation against its exact durable contract. Ambiguous ownership remains protected.",
    schema: { id, contract_id: contractId },
    outputSchema: taskOutput,
    handler: taskHandler("resolve"),
  },
];
