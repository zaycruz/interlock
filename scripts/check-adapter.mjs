import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(join(tmpdir(), "interlock-adapter-check-"));

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: stage, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Adapter check failed: ${result.signal ?? result.status}`);
}

try {
  const source = join(root, "packages/interlock-plugin-herdr");
  for (const entry of ["src", "test", "package.json", "tsconfig.json", "herdr-plugin.toml"]) {
    cpSync(join(source, entry), join(stage, entry), { recursive: true });
  }
  const modules = join(stage, "node_modules");
  mkdirSync(join(modules, "@raava-solutions"), { recursive: true });
  symlinkSync(root, join(modules, "@raava-solutions/interlock"), "dir");
  symlinkSync(join(root, "node_modules/@types"), join(modules, "@types"), "dir");
  run([join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"]);
  const tests = readdirSync(join(stage, "dist/test")).filter((name) => name.endsWith(".test.js"));
  if (tests.length === 0) throw new Error("No adapter tests found.");
  run(["--test", ...tests.map((name) => join(stage, "dist/test", name))]);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
