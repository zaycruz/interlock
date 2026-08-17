import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { assertSupportedPlatform } from "./platform.js";

export function leaseDatabasePath(repositoryPath: string): string {
  const directory = interlockDirectory(repositoryPath);
  mkdirSync(directory, { recursive: true });
  return join(directory, "leases.sqlite");
}

export function existingLeaseDatabasePath(repositoryPath: string): string {
  return join(interlockDirectory(repositoryPath), "leases.sqlite");
}

function interlockDirectory(repositoryPath: string): string {
  assertSupportedPlatform();
  const repositoryRoot = gitOutput(repositoryPath, ["rev-parse", "--show-toplevel"]);
  const commonDirectory = gitOutput(repositoryRoot, ["rev-parse", "--git-common-dir"]);
  return resolve(repositoryRoot, commonDirectory, "interlock");
}

function gitOutput(repositoryPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" }).trim();
}
