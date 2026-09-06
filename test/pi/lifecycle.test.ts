import assert from "node:assert/strict";
import { currentProcessIdentity } from "../../src/core/process-identity.js";
import test from "node:test";
import { installInterlock, type PiHost, type PiContext } from "../../src/pi/index.js";

function harness() {
  const events = new Map<string, (event: { reason?: string }, ctx: PiContext) => Promise<void>>();
  const commands = new Map<string, (args: string, ctx: PiContext) => Promise<void>>();
  const calls: string[][] = [];
  const notices: string[] = [];
  const timeouts: number[] = [];
  const context: string[] = [];
  let tasks: unknown[] = [];
  let failure = "";
  const host: PiHost = {
    sendMessage: (message, options) => {
      assert.deepEqual(options, { deliverAs: "nextTurn", triggerTurn: false });
      context.push(message.content);
    },
    on: (name, handler) => { events.set(name, handler); },
    registerCommand: (name, spec) => { commands.set(name, spec.handler); },
    exec: async (_command, args, options) => {
      timeouts.push(options.timeout);
      calls.push(args);
      if (failure && args.includes(failure)) return { code: 1, stdout: "", stderr: "operation failed", killed: false };
      return { code: 0, stdout: JSON.stringify({ ok: true, tasks, task: tasks[0] ?? {} }), stderr: "", killed: false };
    },
  };
  const ctx: PiContext = { cwd: "/tmp", sessionManager: { getSessionId: () => "session-a" }, ui: { notify: (text) => { notices.push(text); } } };
  installInterlock(host, { env: { INTERLOCK_PANE_TOKEN: "injected-token", INTERLOCK_CLI: "interlock" }, heartbeatMs: 10 });
  return { calls, timeouts, notices, context, events, commands, ctx, tasks: (value: unknown[]) => { tasks = value; }, fail: (value: string) => { failure = value; } };
}

// A reload must not drop the task that the replacement extension must resume.
test("reload preserves ownership and settled does not complete work", async () => {
  const h = harness();
  await h.events.get("session_start")!({}, h.ctx);
  await h.events.get("agent_settled")!({}, h.ctx);
  await h.events.get("session_shutdown")!({ reason: "reload" }, h.ctx);
  assert(h.calls.some((args) => args[0] === "task" && args[1] === "resume"));
  assert(h.calls.some((args) => args.includes("idle")));
  assert(!h.calls.some((args) => args.includes("complete") || args.includes("release")));
  assert(!h.events.has("agent_end"));
});

// A shared pane cannot authorize this extension to release another process's work.
test("shutdown releases only a task owned by this Pi process", async () => {
  const h = harness();
  h.tasks([{ id: "own", claimer: "pi:session-a", execution: { checks: [], contractId: "contract-own", process: currentProcessIdentity(), phase: "active" } }, { id: "foreign", claimer: "pi:session-a", execution: { checks: [], contractId: "contract-own", process: { pid: process.pid + 1 }, phase: "active" } }]);
  await h.events.get("session_start")!({}, h.ctx);
  await h.events.get("session_shutdown")!({ reason: "quit" }, h.ctx);
  const releases = h.calls.filter((args) => args[1] === "release");
  assert.equal(releases.length, 1);
  assert.equal(releases[0][2], "own");
  assert.equal(releases[0][releases[0].indexOf("--contract-id") + 1], "contract-own");
});

// A failed host command must leave ownership to explicit recovery.
test("failed release reports diagnostics and shutdown stops background work", async () => {
  const h = harness();
  h.tasks([{ id: "own", claimer: "pi:session-a", execution: { checks: [], contractId: "contract-own", process: currentProcessIdentity(), phase: "active" } }]);
  await h.events.get("session_start")!({}, h.ctx);
  h.fail("release");
  await h.events.get("session_shutdown")!({ reason: "quit" }, h.ctx);
  const count = h.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.calls.length, count);
  assert(h.notices.some((text) => text.includes("operation failed")));
});

// Claim identity must survive the CLI subprocess; completion must remain explicit.
test("explicit claim binds the host PID and complete passes one JSON argument", async () => {
  const h = harness();
  await h.events.get("session_start")!({}, h.ctx);
  await h.commands.get("interlock-claim")!("work-1", h.ctx);
  const claim = h.calls.find((args) => args[1] === "claim")!;
  assert.equal(claim[claim.indexOf("--session-pid") + 1], String(process.pid));
  const result = { summary: "Implemented", artifacts: ["path with spaces"] };
  await h.commands.get("interlock-complete")!(`work-1 ${JSON.stringify(result)}`, h.ctx);
  const complete = h.calls.find((args) => args[1] === "complete")!;
  assert.deepEqual(JSON.parse(complete[complete.indexOf("--result") + 1]), result);
  await h.events.get("session_shutdown")!({ reason: "reload" }, h.ctx);
});

// PID reuse and unfinished completion must not turn session cleanup into a release.
test("shutdown preserves pending completion and mismatched process identities", async () => {
  const h = harness();
  const identity = currentProcessIdentity();
  h.tasks([
    { id: "pending", claimer: "pi:session-a", execution: { checks: [], contractId: "contract-own", process: identity, phase: "completion-pending" } },
    { id: "reused", claimer: "pi:session-a", execution: { checks: [], contractId: "contract-own", process: { ...identity, startedAt: "old" }, phase: "active" } },
  ]);
  await h.events.get("session_start")!({}, h.ctx);
  await h.events.get("session_shutdown")!({ reason: "new" }, h.ctx);
  assert(!h.calls.some((args) => args[1] === "release"));
});

// Leases need renewal between host events, and shutdown must stop renewal.
test("timer renews durable own claims and stops on reload", async () => {
  const h = harness();
  h.tasks([{ id: "own", claimer: "pi:session-a", execution: { checks: [], contractId: "contract-own", process: currentProcessIdentity(), phase: "active" } }]);
  await h.events.get("session_start")!({}, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 35));
  await h.events.get("session_shutdown")!({ reason: "reload" }, h.ctx);
  assert(h.calls.some((args) => args[1] === "heartbeat" && args[2] === "own"));
  const count = h.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(h.calls.length, count);
});

// Resumed agents need the durable checkpoint in model context without a new turn.
test("startup and explicit discovery queue task context without credentials", async () => {
  const h = harness();
  h.tasks([{ id: "work", checkpoint: "Run the acceptance check", contract: { paths: ["src/main.ts"] } }]);
  await h.events.get("session_start")!({}, h.ctx);
  await h.commands.get("interlock-resume")!("", h.ctx);
  await h.commands.get("interlock-inspect")!("work", h.ctx);
  assert.equal(h.context.length, 3);
  assert(h.context.every((text) => text.includes("Run the acceptance check") && text.includes("src/main.ts")));
  assert(h.context.every((text) => !text.includes("injected-token")));
  await h.events.get("session_shutdown")!({ reason: "reload" }, h.ctx);
});

// Pi must permit the full captured check sequence and its process cleanup budget.
test("completion and pending release use captured verification timeouts", async () => {
  const h = harness();
  h.tasks([{ id: "work", execution: { contractId: "captured", checks: [{ timeoutMs: 300_000 }, { timeoutMs: 45_000 }], phase: "completion-pending" } }]);
  await h.events.get("session_start")!({}, h.ctx);
  await h.commands.get("interlock-complete")!('work {"summary":"done","artifacts":["result"]}', h.ctx);
  await h.commands.get("interlock-release")!("work", h.ctx);
  for (const operation of ["complete", "release"]) {
    const index = h.calls.findIndex((args) => args[1] === operation);
    assert.equal(h.timeouts[index], 385_000);
    assert.equal(h.calls[index][h.calls[index].indexOf("--contract-id") + 1], "captured");
  }
  for (let index = 0; index < h.calls.length; index += 1) {
    if (!["complete", "release"].includes(h.calls[index][1])) assert.equal(h.timeouts[index], 30_000);
  }
  await h.events.get("session_shutdown")!({ reason: "reload" }, h.ctx);
});
