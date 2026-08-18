import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { assertSupportedPlatform } from "./platform.js";
import type { ProcessIdentity, ProcessInspector, ProcessStatus } from "./types.js";

interface AvailableProcessStart {
  status: "available";
  precision: "strong" | "weak";
  startedAt: string;
}

type ProcessStart = AvailableProcessStart | { status: "dead" } | { status: "unknown" };

const PS_LSTART = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s{1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

export function currentProcessIdentity(): ProcessIdentity {
  return processIdentityFor(process.pid);
}

export function processIdentityFor(pid: number): ProcessIdentity {
  const start = processStart(pid);
  if (start.status !== "available") {
    throw new Error(`Could not determine a live stable identity for process ${pid}`);
  }

  return { pid, startedAt: start.startedAt };
}

export function sessionProcessIdentityFor(pid: number): ProcessIdentity {
  assertSupportedPlatform();
  if (!isCallerOrAncestor(pid)) {
    throw new Error(`--session-pid ${pid} is not the calling process or an ancestor of it`);
  }

  return processIdentityFor(pid);
}

function isCallerOrAncestor(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return false;
  }

  const seen = new Set<number>();
  let current: number | undefined = process.pid;
  while (current !== undefined && current > 1 && !seen.has(current)) {
    if (current === pid) {
      return true;
    }
    seen.add(current);
    current = parentProcessId(current);
  }

  return false;
}

function parentProcessId(pid: number): number | undefined {
  return process.platform === "linux" ? linuxParentProcessId(pid) : psParentProcessId(pid);
}

function linuxParentProcessId(pid: number): number | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }

  const closingName = stat.lastIndexOf(")");
  const fields = closingName === -1 ? [] : stat.slice(closingName + 1).trim().split(/\s+/);
  const ppid = fields[1];
  if (ppid === undefined || !/^\d+$/.test(ppid)) {
    return undefined;
  }

  return Number(ppid);
}

function psParentProcessId(pid: number): number | undefined {
  const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    windowsHide: true,
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0 || result.stderr !== "") {
    return undefined;
  }

  const ppid = result.stdout.trim();
  if (!/^\d+$/.test(ppid)) {
    return undefined;
  }

  return Number(ppid);
}

export const inspectProcess: ProcessInspector = (identity): ProcessStatus => {
  const start = processStart(identity.pid);
  if (start.status === "unknown" || start.status === "dead") {
    return start.status;
  }
  if (start.startedAt !== identity.startedAt) {
    return "mismatched";
  }
  return start.precision === "strong" ? "alive" : "ambiguous";
};

function processStart(pid: number): ProcessStart {
  assertSupportedPlatform();

  const existence = processExistence(pid);
  if (existence === "absent") {
    return { status: "dead" };
  }
  if (existence === "unknown") {
    return { status: "unknown" };
  }

  return process.platform === "linux" ? linuxProcessStart(pid) : psProcessStart(pid);
}

function processExistence(pid: number): "present" | "absent" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return "unknown";
  }

  try {
    process.kill(pid, 0);
    return "present";
  } catch (error: unknown) {
    return errorCode(error) === "ESRCH" ? "absent" : "unknown";
  }
}

function linuxProcessStart(pid: number): ProcessStart {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return { status: "unknown" };
  }

  const closingName = stat.lastIndexOf(")");
  const fields = closingName === -1 ? [] : stat.slice(closingName + 1).trim().split(/\s+/);
  const startedAt = fields[19];
  if (startedAt === undefined || !/^\d+$/.test(startedAt)) {
    return { status: "unknown" };
  }

  return { status: "available", precision: "strong", startedAt: `linux:${startedAt}` };
}

function psProcessStart(pid: number): ProcessStart {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: "unknown" };
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    windowsHide: true,
  });
  if (result.error !== undefined || result.signal !== null) {
    return { status: "unknown" };
  }

  if (result.status !== 0 || result.stderr !== "") {
    return { status: "unknown" };
  }

  const startedAt = result.stdout.trim();
  if (!PS_LSTART.test(startedAt)) {
    return { status: "unknown" };
  }

  return { status: "available", precision: "weak", startedAt: `ps:${startedAt}` };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
