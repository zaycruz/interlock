import { spawn } from "node:child_process";

// A separate supervisor preserves the synchronous application boundary while
// it terminates the command's process group and drains bounded output.
const specification = JSON.parse(process.argv[2]!) as { command: string[]; timeoutMs: number };
const ownerPid = process.ppid;
const OUTPUT_LIMIT = 64 * 1024;
const chunks: Buffer[] = [];
let storedBytes = 0;
let failure: string | undefined;
let groupStopped = false;
const child = spawn(specification.command[0]!, specification.command.slice(1), {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});

function stopGroup(): void {
  if (child.pid === undefined || groupStopped) return;
  try { process.kill(-child.pid, "SIGKILL"); groupStopped = true; }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      failure = `${failure ?? ""} verification cleanup failed: ${String(error)}`.trim();
    }
  }
}

function collect(chunk: Buffer): void {
  const remaining = OUTPUT_LIMIT - storedBytes;
  const retained = chunk.subarray(0, remaining);
  chunks.push(retained);
  storedBytes += retained.length;
  if (chunk.length > remaining) {
    failure = "verification output exceeded 64 KiB";
    stopGroup();
  }
}

const timer = setTimeout(() => {
  failure = `verification timed out after ${specification.timeoutMs} ms`;
  stopGroup();
}, specification.timeoutMs);

function stopAbandonedCommand(): void {
  failure = "verification owner stopped";
  stopGroup();
}

// The command must not keep writing after the agent that requested it exits.
const ownerTimer = setInterval(() => {
  if (process.ppid !== ownerPid) stopAbandonedCommand();
}, 100);
process.on("SIGTERM", stopAbandonedCommand);
process.on("SIGINT", stopAbandonedCommand);
process.stdout.on("error", () => { stopAbandonedCommand(); });

child.stdout.on("data", collect);
child.stderr.on("data", collect);
child.on("error", (error) => { failure = error.message; });
child.on("exit", stopGroup);
child.on("close", (code, signal) => {
  clearTimeout(timer);
  clearInterval(ownerTimer);
  let output = Buffer.concat(chunks).toString("utf8");
  while (Buffer.byteLength(output) > OUTPUT_LIMIT) output = output.slice(0, -1);
  process.stdout.write(JSON.stringify({
    passed: code === 0 && failure === undefined,
    exitCode: code,
    signal,
    output,
    ...(failure === undefined ? {} : { error: failure }),
  }));
});
