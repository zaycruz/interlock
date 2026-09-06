import { z } from "zod";
import { invoke, type ToolSpec } from "./tools.js";

const name = z.string().min(1);
const channelId = z.number().int().positive();
const pod = z.object({
  name, createdAt: z.string(), leader: name, succession: z.array(name),
  status: z.enum(["open", "closed"]), closedAt: z.string().nullable(),
});
const member = z.object({
  member: name, pod: name, role: z.enum(["leader", "worker"]),
  process: z.object({ pid: z.number().int().positive(), startedAt: z.string() }).nullable(),
  registeredAt: z.string(), diedAt: z.string().nullable(), doneAt: z.string().nullable(),
});
const channel = z.object({
  id: channelId, fromPod: name, toPod: name, topic: z.string(),
  openedAt: z.string(), closedAt: z.string().nullable(), messageCount: z.number().int().nonnegative(),
});

export const COORDINATION_TOOL_SPECS: ToolSpec[] = [
  {
    name: "pod_list",
    description: "Discover local pods and their leaders. Inspect a pod to find member names and roles. This view contains no credentials.",
    schema: {}, outputSchema: { ok: z.boolean(), pods: z.array(pod) }, readOnly: true,
    handler: (config) => () => invoke(config, ["pod", "list", "--json"]),
  },
  {
    name: "pod_inspect",
    description: "Discover a pod's recipients, roles, and process identities. Use member names as message recipients. This view contains no credentials.",
    schema: { pod: name }, outputSchema: { ok: z.boolean(), pod, members: z.array(member) }, readOnly: true,
    handler: (config) => (args) => invoke(config, ["pod", "show", `--pod=${args.pod}`, "--json"]),
  },
  {
    name: "channel_list",
    description: "Find leader channels and their open or closed state. Filter by pod when needed.",
    schema: { pod: name.optional() }, outputSchema: { ok: z.boolean(), channels: z.array(channel) }, readOnly: true,
    handler: (config) => (args) => invoke(config, ["pod", "channel", "list", "--json", ...(args.pod === undefined ? [] : [`--pod=${args.pod}`])]),
  },
  {
    name: "channel_open",
    description: "Open a channel from your pod to another pod. Only the active pod leader can open it. Use the returned channel ID for messages between leaders.",
    schema: { pod: name, to_pod: name, topic: z.string().trim().min(1).max(140) },
    outputSchema: { ok: z.boolean(), channel },
    handler: (config) => (args) => invoke(config, ["pod", "channel", "open", `--pod=${args.pod}`, `--to-pod=${args.to_pod}`, `--topic=${args.topic}`, "--member", config.pane]),
  },
  {
    name: "channel_close",
    description: "Close a leader channel after its discussion finishes. Only a current leader at either endpoint can close it.",
    schema: { channel: channelId }, outputSchema: { ok: z.boolean(), channel },
    handler: (config) => (args) => invoke(config, ["pod", "channel", "close", `--channel=${args.channel}`, "--member", config.pane]),
  },
];
