import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestRepository {
  path: string;
  remove(): void;
}

export function createTestRepository(): TestRepository {
  const path = mkdtempSync(join(tmpdir(), "interlock-lease-core-"));
  execFileSync("git", ["init", "--quiet", path]);

  return {
    path,
    remove: () => rmSync(path, { recursive: true, force: true }),
  };
}

export function createLinkedWorktree(repository: TestRepository): TestRepository {
  const path = mkdtempSync(join(tmpdir(), "interlock-lease-core-worktree-"));
  rmSync(path, { recursive: true, force: true });
  execFileSync("git", ["-C", repository.path, "-c", "user.name=Interlock Test", "-c", "user.email=interlock@example.test", "commit", "--quiet", "--allow-empty", "-m", "test repository"]);
  execFileSync("git", ["-C", repository.path, "worktree", "add", "--quiet", "--detach", path, "HEAD"]);

  return {
    path,
    remove: () => {
      execFileSync("git", ["-C", repository.path, "worktree", "remove", "--force", path]);
      rmSync(path, { recursive: true, force: true });
    },
  };
}
