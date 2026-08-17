import { execFileSync } from "node:child_process";

import { normalizeLeasePaths } from "../core/index.js";

export function assertStagedPathsAreOwned(repositoryPath: string, ownedPaths: string[]): void {
  const owned = new Set(normalizeLeasePaths(ownedPaths));
  const changed = stagedPaths(repositoryPath);
  const outOfScope = changed.filter((path) => !owned.has(normalizeLeasePaths([path])[0]));
  if (outOfScope.length > 0) throw new Error(`Staged paths are outside this work contract: ${outOfScope.join(", ")}`);
}

export function stagedPaths(repositoryPath: string): string[] {
  const output = execFileSync("git", [
    "-C", repositoryPath, "diff", "--cached", "--name-status", "-z", "--find-renames", "--find-copies", "--find-copies-harder",
  ], { encoding: "utf8" });
  const tokens = output.split("\0");
  tokens.pop();
  const paths: string[] = [];

  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (status === undefined || status === "") throw new Error("Git returned malformed staged diff data");
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    for (let offset = 0; offset < pathCount; offset += 1) {
      const path = tokens[index++];
      if (path === undefined || path === "") throw new Error("Git returned malformed staged diff paths");
      paths.push(path);
    }
  }
  return paths;
}
