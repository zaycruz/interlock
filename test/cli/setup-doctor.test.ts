import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../../src/cli/index.js";

function usableHost() {
  const calls: string[] = [];
  let active = false;
  let consent: unknown;
  return {
    calls,
    dependencies: {
      engineVersion: "0.0.4",
      minimumHerdrVersion: "1.2.0",
      stateDirectory: () => "/state/interlock",
      inspectStateDirectory: () => "healthy" as const,
      resolveCommand: () => "/usr/local/bin/herdr",
      plugin: () => ({ path: "/plugins/interlock-herdr", version: "0.0.4" }),
      readConsent: () => consent as undefined,
      writeConsent: (record: unknown) => { consent = record; },
      removeConsent: () => { consent = undefined; },
      isTty: () => true,
      prompt: () => "yes",
      clock: () => new Date("2026-08-19T12:00:00.000Z"),
      execute: (command: string, args: string[]) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (args[0] === "--version") return { exitCode: 0, stdout: "herdr 1.2.3\n", stderr: "" };
        if (args[1] === "link") active = true;
        if (args[1] === "unlink") active = false;
        if (args[1] === "list") return { exitCode: 0, stdout: active ? "@raava-solutions/interlock-plugin-herdr 0.0.4\n" : "", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

test("doctor reports an absent optional herdr host without failing", () => {
  const result = runCli(["doctor"], {
    setupDoctor: {
      engineVersion: "0.0.4",
      stateDirectory: () => "/state/interlock",
      inspectStateDirectory: () => "healthy",
      resolveCommand: () => undefined,
      plugin: () => undefined,
      readConsent: () => undefined,
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /engine: 0\.0\.4/);
  assert.match(result.stdout, /state directory: \/state\/interlock \(healthy\)/);
  assert.match(result.stdout, /herdr: not detected/);
});

test("setup --yes echoes the link command, verifies activation, and records consent last", () => {
  const host = usableHost();
  const result = runCli(["setup", "--yes"], { setupDoctor: host.dependencies });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\$ herdr plugin link \/plugins\/interlock-herdr/);
  assert.doesNotMatch(result.stdout, /Will run: npm install/);
  assert.deepEqual(host.calls, [
    "herdr --version",
    "herdr plugin list",
    "herdr plugin link /plugins/interlock-herdr",
    "herdr plugin list",
  ]);
});

test("setup refuses a non-TTY prompt unless --yes is explicit", () => {
  const host = usableHost();
  host.dependencies.isTty = () => false;
  const result = runCli(["setup"], { setupDoctor: host.dependencies });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /pass --yes/);
  assert.deepEqual(host.calls, ["herdr --version", "herdr plugin list"]);
});

test("setup --remove uses herdr unlink and removes only Interlock's consent record", () => {
  const host = usableHost();
  const installed = runCli(["setup", "--yes"], { setupDoctor: host.dependencies });
  assert.equal(installed.exitCode, 0);
  host.calls.length = 0;

  const removed = runCli(["setup", "--remove"], { setupDoctor: host.dependencies });
  assert.equal(removed.exitCode, 0);
  assert.match(removed.stdout, /\$ herdr plugin unlink \/plugins\/interlock-herdr/);
  assert.match(removed.stdout, /npm uninstall -g @raava-solutions\/interlock-plugin-herdr/);
  assert.deepEqual(host.calls, ["herdr --version", "herdr plugin unlink /plugins/interlock-herdr"]);
});

test("doctor fails with the exact reason when herdr is below the compatibility floor", () => {
  const result = runCli(["doctor"], {
    setupDoctor: {
      engineVersion: "0.0.4", minimumHerdrVersion: "1.2.0", stateDirectory: () => "/state/interlock",
      inspectStateDirectory: () => "healthy", resolveCommand: () => "/usr/local/bin/herdr", plugin: () => undefined,
      readConsent: () => undefined,
      execute: () => ({ exitCode: 0, stdout: "herdr 1.1.9\n", stderr: "" }),
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /herdr not usable: version 1\.1\.9 is below required 1\.2\.0/);
});

test("doctor reports an invalid consent record as unhealthy without throwing", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "interlock-doctor-"));
  try {
    writeFileSync(join(stateDirectory, "herdr-consent.json"), "not json");
    const result = runCli(["doctor"], {
      setupDoctor: { stateDirectory: () => stateDirectory, resolveCommand: () => undefined, plugin: () => undefined },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /state directory: .*invalid consent record/);
    assert.match(result.stdout, /consent record: absent/);
  } finally { rmSync(stateDirectory, { recursive: true, force: true }); }
});

test("setup --remove clears Interlock consent when herdr is no longer usable", () => {
  let removed = false;
  const result = runCli(["setup", "--remove"], {
    setupDoctor: {
      resolveCommand: () => undefined,
      removeConsent: () => { removed = true; },
      stateDirectory: () => "/state/interlock",
      inspectStateDirectory: () => "healthy",
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(removed, true);
  assert.match(result.stdout, /herdr not detected; skipped plugin unlink/);
  assert.match(result.stdout, /Removed Interlock's consent record/);
});
