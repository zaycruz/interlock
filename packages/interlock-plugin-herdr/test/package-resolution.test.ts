import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

test("the setup-doctor createRequire resolution path finds a linked plugin manifest", () => {
  const consumer = mkdtempSync(join(tmpdir(), "interlock-plugin-consumer-"));
  directories.push(consumer);
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const scope = join(consumer, "node_modules", "@raava-solutions");
  mkdirSync(scope, { recursive: true });
  symlinkSync(pluginRoot, join(scope, "interlock-plugin-herdr"), "dir");

  const require = createRequire(join(consumer, "consumer.cjs"));
  const manifest = require.resolve("@raava-solutions/interlock-plugin-herdr/package.json");

  assert.equal(dirname(manifest), pluginRoot);
});
