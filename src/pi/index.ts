import { fileURLToPath } from "node:url";
import { currentProcessIdentity } from "../core/process-identity.js";

export interface PiContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}
export interface PiHost {
  sendMessage(message: { customType: string; content: string; display: boolean }, options: { deliverAs: "nextTurn"; triggerTurn: false }): void;
  on(name: string, handler: (event: { reason?: string }, context: PiContext) => Promise<void>): void;
  registerCommand(name: string, spec: { description: string; handler(args: string, context: PiContext): Promise<void> }): void;
  exec(command: string, args: string[], options: { cwd: string; timeout: number }): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;
}
interface OwnedTask { id: string; claimer: string; execution: { contractId: string; process: { pid: number; startedAt: string }; phase: string }; }

export function installInterlock(pi: PiHost, options: { env?: NodeJS.ProcessEnv; heartbeatMs?: number } = {}): void {
  const env = options.env ?? process.env;
  const identity = currentProcessIdentity();
  let sessionId = "";
  let pane = "";
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();

  function publish(context: unknown): void {
    pi.sendMessage({ customType: "interlock", content: JSON.stringify(context), display: true }, { deliverAs: "nextTurn", triggerTurn: false });
  }

  async function call(ctx: PiContext, args: string[]): Promise<unknown> {
    let timeout = 30_000;
    if (args[0] === "task" && ["complete", "release", "resolve"].includes(args[1])) {
      const observed = await call(ctx, ["task", "inspect", args[2]]);
      const budget = verificationBudget(observed);
      timeout = budget.timeout;
      if (budget.contractId && !args.includes("--contract-id")) args = [...args, "--contract-id", budget.contractId];
    }
    const prefix = env.INTERLOCK_CLI ? [] : [fileURLToPath(new URL("../cli/main.js", import.meta.url))];
    const result = await pi.exec(env.INTERLOCK_CLI ?? process.execPath, [...prefix, ...args, "--pane", pane], { cwd: ctx.cwd, timeout });
    if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || `Interlock exited with ${result.code}`);
    return JSON.parse(result.stdout);
  }
  function serialize(ctx: PiContext, action: () => Promise<void>): Promise<void> {
    queue = queue.then(action).catch((error: unknown) => { ctx.ui.notify(`Interlock: ${error instanceof Error ? error.message : String(error)}`, "error"); });
    return queue;
  }
  async function owned(ctx: PiContext): Promise<OwnedTask[]> {
    const result = await call(ctx, ["task", "resume"]);
    if (typeof result !== "object" || result === null || !("tasks" in result) || !Array.isArray(result.tasks)) throw new Error("Invalid task resume response");
    return result.tasks.filter((task: unknown): task is OwnedTask => {
      if (typeof task !== "object" || task === null) return false;
      const candidate = task as Partial<OwnedTask>;
      return typeof candidate.id === "string" && candidate.claimer === pane && candidate.execution?.process?.pid === identity.pid && candidate.execution.process.startedAt === identity.startedAt && candidate.execution.phase === "active" && typeof candidate.execution.contractId === "string";
    });
  }
  function schedule(ctx: PiContext): void {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void serialize(ctx, async () => {
        if (!running) return;
        for (const task of await owned(ctx)) await call(ctx, ["task", "heartbeat", task.id, "--contract-id", task.execution.contractId]);
      }).then(() => schedule(ctx));
    }, options.heartbeatMs ?? 30_000);
    timer.unref();
  }
  pi.on("session_start", (_event, ctx) => serialize(ctx, async () => {
    if (!env.INTERLOCK_PANE_TOKEN) throw new Error("Set INTERLOCK_PANE_TOKEN before starting Pi.");
    sessionId = ctx.sessionManager.getSessionId();
    pane = env.INTERLOCK_PANE ?? `pi:${sessionId}`;
    if (!env.INTERLOCK_PANE) await call(ctx, ["session", "register"]);
    const context = await call(ctx, ["task", "resume"]);
    running = true;
    publish(context);
    ctx.ui.notify(`Interlock: ${pane}. Use /interlock-resume to read context.`, "info");
    schedule(ctx);
  }));
  pi.on("agent_settled", (_event, ctx) => serialize(ctx, async () => {
    if (running) await call(ctx, ["session", "set", "--state", "idle"]);
  }));
  pi.on("session_shutdown", (event, ctx) => {
    running = false;
    clearTimeout(timer);
    return serialize(ctx, async () => {
      running = false;
      clearTimeout(timer);
      if (!pane || !["quit", "new", "resume", "fork"].includes(event.reason ?? "") || ctx.sessionManager.getSessionId() !== sessionId) return;
      for (const task of await owned(ctx)) await call(ctx, ["task", "release", task.id, "--contract-id", task.execution.contractId, "--reason", `Pi session ${event.reason ?? "shutdown"}`]);
    });
  });

  const commands: Record<string, { description: string; args(input: string): string[] }> = {
    resume: { description: "Read task ownership, checkpoints, and discussion.", args: () => ["task", "resume"] },
    claim: { description: "Claim one task for this Pi process: /interlock-claim <task-id>.", args: (id) => ["task", "claim", identifier(id), "--session-pid", String(process.pid)] },
    release: { description: "Release a task: /interlock-release <task-id>.", args: (id) => ["task", "release", identifier(id), "--reason", "Explicit Pi command"] },
    heartbeat: { description: "Refresh an owned task: /interlock-heartbeat <task-id>.", args: (id) => ["task", "heartbeat", identifier(id)] },
    complete: { description: "Complete with evidence: /interlock-complete <task-id> <JSON result>.", args: completionArgs },
    inspect: { description: "Read a task contract: /interlock-inspect <task-id>.", args: (id) => ["task", "inspect", identifier(id)] },
  };
  for (const [name, spec] of Object.entries(commands)) {
    pi.registerCommand(`interlock-${name}`, { description: spec.description, handler: (args, ctx) => serialize(ctx, async () => {
      if (!running) throw new Error("Interlock startup failed. Check the diagnostic and reload Pi.");
      const result = await call(ctx, spec.args(args.trim()));
      if (["resume", "inspect", "claim"].includes(name)) publish(result);
      ctx.ui.notify(JSON.stringify(result), "info");
    }) });
  }
}
function identifier(input: string): string {
  if (!/^[A-Za-z0-9:._-]+$/.test(input) || input.includes("..")) throw new Error("Supply one valid task ID.");
  return input;
}
export default installInterlock;

function completionArgs(input: string): string[] {
  const split = input.indexOf(" ");
  if (split < 0) throw new Error("Supply a task ID and a JSON result.");
  const id = identifier(input.slice(0, split));
  const result: unknown = JSON.parse(input.slice(split + 1));
  if (typeof result !== "object" || result === null) throw new Error("Supply a JSON result object.");
  return ["task", "complete", id, "--result", JSON.stringify(result)];
}

function verificationBudget(response: unknown): { timeout: number; contractId?: string } {
  if (typeof response !== "object" || response === null || !("task" in response)) throw new Error("Invalid task inspection response.");
  const task = response.task as { execution?: { contractId: string; checks: { timeoutMs: number }[] } };
  if (!task.execution) return { timeout: 30_000 };
  const { checks, contractId } = task.execution;
  if (!Array.isArray(checks) || typeof contractId !== "string") throw new Error("Invalid captured verification budget.");
  return { timeout: capturedCheckTimeout(checks), contractId };
}

function capturedCheckTimeout(checks: { timeoutMs: number }[]): number {
  let timeout = 30_000;
  for (const check of checks) {
    if (!Number.isInteger(check.timeoutMs) || check.timeoutMs <= 0 || check.timeoutMs > 300_000) throw new Error("Invalid captured check timeout.");
    // Allow the verification supervisor to stop descendants before Pi stops the CLI.
    timeout += check.timeoutMs + 5_000;
  }
  if (timeout > 2_147_483_647) throw new Error("Captured verification exceeds the Pi timer limit.");
  return timeout;
}
