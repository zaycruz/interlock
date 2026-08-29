// U3: the packaged surface. `npm pack` ships the interlock-mcp bin only if
// package.json points at the compiled entry and the entry survives the build.
// This test runs after `npm run build` (the test script builds first), so it
// can assert the shipped shape directly.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
// The test runs from dist/test/mcp/, so the package root is three levels up.
const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));


function packageJson(): { bin: Record<string, string>; files: string[] } {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { bin: Record<string, string>; files: string[] };
}

test("interlock-mcp resolves to the compiled MCP entry inside the packaged files", () => {
  const pkg = packageJson();
  assert.equal(pkg.bin["interlock-mcp"], "./dist/src/mcp/main.js");
  assert.ok(pkg.files.includes("dist/src"), "the pack files list must cover the bin target");
  const target = join(packageRoot, pkg.bin["interlock-mcp"]!);
  assert.ok(existsSync(target), "the build must produce the bin target: " + pkg.bin["interlock-mcp"]);
  assert.ok(readFileSync(target, "utf8").startsWith("#!/usr/bin/env node"), "the bin entry needs the node shebang");
});
