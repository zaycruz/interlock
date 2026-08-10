import { spawnSync } from "node:child_process";

import type { ProcessIdentity, ProcessInspector, ProcessStatus } from "./types.js";

export function currentProcessIdentity(): ProcessIdentity {
  const start = processStart(process.pid);
  if (start.status !== "available" || start.startedAt === undefined) {
    throw new Error(`Could not determine start time for process ${process.pid}`);
  }

  return { pid: process.pid, startedAt: start.startedAt };
}

export const inspectProcess: ProcessInspector = (identity): ProcessStatus => {
  const start = processStart(identity.pid);
  if (start.status === "unknown") {
    return "unknown";
  }
  if (start.startedAt === undefined) {
    return "dead";
  }
  return start.startedAt === identity.startedAt ? "alive" : "mismatched";
};

function processStart(pid: number): { status: "available"; startedAt: string | undefined } | { status: "unknown" } {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined) {
    return { status: "unknown" };
  }

  const startedAt = result.stdout.trim();
  return { status: "available", startedAt: startedAt === "" ? undefined : startedAt };
}
