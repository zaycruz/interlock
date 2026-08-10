import { posix, win32 } from "node:path";

import { LeasePathError } from "./errors.js";
import { isCaseInsensitiveGitRepository } from "./git-common-directory.js";

const GLOB_CHARACTER = /[*?\[\]{}]/;

export function normalizeLeasePaths(repositoryPath: string, paths: string[]): string[] {
  if (paths.length === 0) {
    throw new LeasePathError("At least one path is required");
  }

  const canonicalizeCase = isCaseInsensitiveGitRepository(repositoryPath);
  const normalizedPaths = paths.map((path) => normalizeLeasePath(path, canonicalizeCase)).sort();
  for (let index = 1; index < normalizedPaths.length; index += 1) {
    if (normalizedPaths[index] === normalizedPaths[index - 1]) {
      throw new LeasePathError(`Duplicate path: ${normalizedPaths[index]}`);
    }
  }

  return normalizedPaths;
}

function normalizeLeasePath(value: string, canonicalizeCase: boolean): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LeasePathError("Each path must be a non-empty string");
  }
  if (value.includes("\0")) {
    throw new LeasePathError("Paths must not contain null bytes");
  }
  if (posix.isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new LeasePathError(`Path must be repository-relative: ${value}`);
  }
  if (GLOB_CHARACTER.test(value)) {
    throw new LeasePathError(`Path must not contain glob characters: ${value}`);
  }
  if (value.endsWith("/") || value.endsWith("\\")) {
    throw new LeasePathError(`Path must not end with a directory separator: ${value}`);
  }

  const portablePath = value.replaceAll("\\", "/");
  if (portablePath.split("/").includes("..")) {
    throw new LeasePathError(`Path must not contain traversal: ${value}`);
  }

  const normalizedPath = posix.normalize(portablePath);
  if (normalizedPath === "." || normalizedPath.startsWith("../")) {
    throw new LeasePathError(`Path must be repository-relative: ${value}`);
  }

  return canonicalizeCase ? normalizedPath.toLowerCase() : normalizedPath;
}
