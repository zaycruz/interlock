import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { stagedPaths } from "../../src/cli/staged-paths.js";
import { createTestRepository, type TestRepository } from "../helpers/git-repository.js";

const repositories: TestRepository[] = [];
afterEach(() => { while (repositories.length > 0) repositories.pop()?.remove(); });
function repository(files: Record<string, string>): TestRepository {
  const repo = createTestRepository(); repositories.push(repo);
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(repo.path, path), contents);
  execFileSync("git", ["-C", repo.path, "add", "."]);
  execFileSync("git", ["-C", repo.path, "-c", "user.name=Interlock", "-c", "user.email=interlock@example.test", "commit", "-m", "base", "--quiet"]);
  return repo;
}

test("lists staged add, modify, and delete paths", () => {
  const repo = repository({ "modify.ts": "before\n", "delete.ts": "delete\n" });
  writeFileSync(join(repo.path, "add.ts"), "add\n");
  writeFileSync(join(repo.path, "modify.ts"), "after\n");
  execFileSync("git", ["-C", repo.path, "rm", "--quiet", "delete.ts"]);
  execFileSync("git", ["-C", repo.path, "add", "add.ts", "modify.ts"]);
  assert.deepEqual(new Set(stagedPaths(repo.path)), new Set(["add.ts", "modify.ts", "delete.ts"]));
});

test("lists both sides of a staged rename", () => {
  const repo = repository({ "before.ts": "rename content\n" });
  execFileSync("git", ["-C", repo.path, "mv", "before.ts", "after.ts"]);
  execFileSync("git", ["-C", repo.path, "add", "-A"]);
  assert.deepEqual(stagedPaths(repo.path), ["before.ts", "after.ts"]);
});

test("lists both sides of a detected staged copy", () => {
  const repo = repository({ "source.ts": "copy content\n" });
  writeFileSync(join(repo.path, "copy.ts"), "copy content\n");
  execFileSync("git", ["-C", repo.path, "add", "copy.ts"]);
  assert.deepEqual(stagedPaths(repo.path), ["source.ts", "copy.ts"]);
});
