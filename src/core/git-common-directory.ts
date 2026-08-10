import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { assertSupportedPlatform } from "./platform.js";

export function leaseDatabasePath(repositoryPath: string): string {
  return join(interlockDirectory(repositoryPath), "leases.sqlite");
}

export function isCaseInsensitiveFilesystem(repositoryPath: string): boolean {
  try {
    return probeCaseInsensitiveFilesystem(gitOutput(repositoryPath, ["rev-parse", "--show-toplevel"]));
  } catch {
    return true;
  }
}

function probeCaseInsensitiveFilesystem(directory: string): boolean {
  const probeName = `.case-sensitivity-${process.pid}-${randomUUID()}`;
  const probePath = join(directory, probeName);

  try {
    writeFileSync(probePath, "");
    try {
      statSync(join(directory, probeName.toUpperCase()));
      return true;
    } catch (error: unknown) {
      return errorCode(error) === "ENOENT" ? false : true;
    }
  } catch {
    return true;
  } finally {
    try {
      rmSync(probePath, { force: true });
    } catch {
      // The probe result is already conservative; cleanup failure must not change it.
    }
  }
}

function interlockDirectory(repositoryPath: string): string {
  assertSupportedPlatform();
  const repositoryRoot = gitOutput(repositoryPath, ["rev-parse", "--show-toplevel"]);
  const commonDirectory = gitOutput(repositoryRoot, ["rev-parse", "--git-common-dir"]);
  const directory = resolve(repositoryRoot, commonDirectory, "interlock");

  mkdirSync(directory, { recursive: true });
  return directory;
}

function gitOutput(repositoryPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" }).trim();
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
