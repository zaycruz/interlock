import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function leaseDatabasePath(repositoryPath: string): string {
  const repositoryRoot = gitOutput(repositoryPath, ["rev-parse", "--show-toplevel"]);
  const commonDirectory = gitOutput(repositoryRoot, ["rev-parse", "--git-common-dir"]);
  const databasePath = resolve(repositoryRoot, commonDirectory, "interlock", "leases.sqlite");

  mkdirSync(dirname(databasePath), { recursive: true });
  return databasePath;
}

function gitOutput(repositoryPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" }).trim();
}
