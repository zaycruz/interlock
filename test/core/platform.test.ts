import assert from "node:assert/strict";
import { test } from "node:test";

import { UnsupportedPlatformError, assertSupportedPlatform } from "../../src/core/index.js";

test("rejects a runtime platform outside Interlock V1 support", () => {
  assert.throws(
    () => assertSupportedPlatform("win32"),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedPlatformError);
      assert.equal(error.message, "Interlock V1 supports macOS and Linux only; received win32.");
      return true;
    },
  );
});

test("accepts each supported Interlock V1 runtime platform", () => {
  assert.doesNotThrow(() => assertSupportedPlatform("darwin"));
  assert.doesNotThrow(() => assertSupportedPlatform("linux"));
});
