import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { parseVerificationChecks, runVerificationChecks } from "../../src/contracts/verification.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "interlock-verification-"));
  directories.push(directory);
  return directory;
}

test("verification executes the captured command in the worktree and records observed evidence", () => {
  const directory = repository();
  writeFileSync(join(directory, "answer.txt"), "42");
  const checks = parseVerificationChecks([{ criterion: "The answer is 42", command: [process.execPath, "-e", "if(require('fs').readFileSync('answer.txt','utf8')!=='42') process.exit(1); console.log('answer verified')"] }]);
  const results = runVerificationChecks(directory, checks);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.passed, true);
  assert.equal(results[0]?.exitCode, 0);
  assert.equal(results[0]?.criterion, "The answer is 42");
  assert.match(results[0]!.output, /answer verified/);
  assert.deepEqual(results[0]?.command, checks[0]?.command);
  assert.equal(results[0]?.source, "interlock-executed");
});

test("verification records a failed command and still evaluates the remaining criteria", () => {
  const checks = parseVerificationChecks([
    { criterion: "First condition", command: [process.execPath, "-e", "console.error('condition failed'); process.exit(7)"] },
    { criterion: "Second condition", command: [process.execPath, "-e", "console.log('second checked')"] },
  ]);
  const results = runVerificationChecks(repository(), checks);
  assert.equal(results[0]?.passed, false);
  assert.equal(results[0]?.exitCode, 7);
  assert.match(results[0]!.output, /condition failed/);
  assert.equal(results[1]?.passed, true);
});

test("verification bounds a stuck command and reports timeout as failure", () => {
  const checks = parseVerificationChecks([{ criterion: "Terminates", command: [process.execPath, "-e", "setInterval(()=>{},1000)"], timeoutMs: 100 }]);
  const [result] = runVerificationChecks(repository(), checks);
  assert.equal(result?.passed, false);
  assert.match(result?.error ?? "", /timed out|ETIMEDOUT/);
});

test("a missing executable cannot be recorded as successful verification", () => {
  const checks = parseVerificationChecks([{ criterion: "Runs", command: ["/interlock-missing-executable"] }]);
  const [result] = runVerificationChecks(repository(), checks);
  assert.equal(result?.passed, false);
  assert.match(result?.error ?? "", /ENOENT/);
});

test("verification rejects absent, ambiguous, duplicate and unbounded check specifications", () => {
  for (const value of [undefined, [], [{ criterion: "", command: ["node"] }], [{ criterion: "One", command: "node test" }], [{ criterion: "One", command: [] }], [{ criterion: "One", command: ["node"], timeoutMs: 0 }], [{ criterion: "One", command: ["node"], timeoutMs: 300001 }], [{ criterion: "One", command: ["node"], shell: true }]]) {
    assert.throws(() => parseVerificationChecks(value), /verification/i);
  }
  assert.throws(() => parseVerificationChecks([{ criterion: "One", command: ["node"] }, { criterion: "One", command: ["node"] }]), /duplicate/i);
});

test("shell metacharacters remain literal command arguments", () => {
  const checks = parseVerificationChecks([{ criterion: "Argument safety", command: [process.execPath, "-e", "console.log(process.argv[1])", "$(touch unexpected); && echo injected"] }]);
  const [result] = runVerificationChecks(repository(), checks);
  assert.equal(result?.passed, true);
  assert.equal(result?.output.trim(), "$(touch unexpected); && echo injected");
});

test("timed-out verification stops descendants before they can write after the check", async () => {
  const directory = repository();
  const descendant = "setTimeout(()=>require('fs').writeFileSync('late.txt','leaked'),600)";
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}); setInterval(()=>{},1000)`;
  const checks = parseVerificationChecks([{ criterion: "No leaked work", command: [process.execPath, "-e", parent], timeoutMs: 100 }]);
  assert.equal(runVerificationChecks(directory, checks)[0]?.passed, false);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(directory, "late.txt")), false);
});

test("verification rejects NUL in executables and arguments", () => {
  assert.throws(() => parseVerificationChecks([{ criterion: "NUL executable", command: ["node\0"] }]), /verification/i);
  assert.throws(() => parseVerificationChecks([{ criterion: "NUL argument", command: ["node", "\0"] }]), /verification/i);
});

test("excessive command output fails verification and keeps evidence within 64 KiB", () => {
  const checks = parseVerificationChecks([{ criterion: "Bounded output", command: [process.execPath, "-e", "process.stdout.write('x'.repeat(1024*1024))"] }]);
  const [result] = runVerificationChecks(repository(), checks);
  assert.equal(result?.passed, false);
  assert.match(result?.error ?? "", /output/i);
  assert.ok(Buffer.byteLength(result!.output) <= 64 * 1024);
});

test("verification stops its command when the calling agent process dies", async () => {
  const directory = repository();
  const moduleUrl = new URL("../../src/contracts/verification.js", import.meta.url).href;
  const command = "require('fs').writeFileSync('started','yes'); setTimeout(()=>require('fs').writeFileSync('orphan-write','leaked'),1000)";
  const script = `import {runVerificationChecks} from ${JSON.stringify(moduleUrl)}; runVerificationChecks(${JSON.stringify(directory)}, [{criterion:'Owner lifetime',command:[process.execPath,'-e',${JSON.stringify(command)}],timeoutMs:10000}]);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(join(directory, "started")); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(join(directory, "started")), "verification command started");
    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(existsSync(join(directory, "orphan-write")), false);
  } finally { owner.kill("SIGKILL"); }
});
