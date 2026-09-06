#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Use the installed artifact to prove task control, recovery, and retry behavior.
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = join(source, '.omx/evidence/dogfood', new Date().toISOString().replaceAll(':', '-'));
assert.ok(evidence.startsWith('/Volumes/RTL-2TB/'), 'Dogfood artifacts must stay on RTL-2TB');
mkdirSync(evidence, { recursive: true });
const environment = { ...process.env, TMPDIR: evidence, npm_config_cache: join(evidence, 'npm-cache'),
  INTERLOCK_STATE_DIR: join(evidence, 'coordination'), BD_NON_INTERACTIVE: '1' };
delete environment.INTERLOCK_PANE;
delete environment.INTERLOCK_PANE_TOKEN;
const report = { startedAt: new Date().toISOString(), evidence, steps: [], smokes: [],
  limitations: ['Scripted protocol dogfood with separate MCP server processes. This does not measure autonomous model reasoning or long-running production reliability.'], metrics: {} };
const connections = new Set();
const execute = promisify(execFile);
let executable;
let installed;
let Client;
let StdioClientTransport;
let tokens;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /token/i.test(key) ? '[redacted]' : redact(item)]));
  return value;
}

function save() {
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(redact(report), null, 2));
}

function record(step) {
  report.steps.push(step);
  save();
}

async function run(command, args, cwd = source, options = {}) {
  const start = performance.now();
  let result;
  try {
    result = { ...await execute(command, args, { cwd, env: environment, timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024, ...options }), exitCode: 0 };
  } catch (error) {
    result = { stdout: error.stdout ?? '', stderr: error.stderr ?? String(error), exitCode: error.code, signal: error.signal };
  }
  const safeArgs = args.map((value, index) => args[index - 1]?.includes('token') ? '[redacted]' : value);
  let output = result.stdout;
  try { output = redact(JSON.parse(output)); } catch { /* Non-JSON commands retain their text. */ }
  record({ command, args: safeArgs, cwd, ...result, stdout: output, elapsedMs: performance.now() - start });
  return result;
}

async function required(command, args, cwd, options) {
  const result = await run(command, args, cwd, options);
  assert.equal(result.exitCode, 0, `${command} ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

async function cli(args, cwd = source, extra = {}) {
  return required(process.execPath, [executable, ...args], cwd, { env: { ...environment, ...extra } });
}

async function git(directory, args) { return required('git', ['-C', directory, ...args]); }
async function bead(directory, args) { return required('bd', args, directory); }

async function initializeRepository(index) {
  const directory = join(evidence, `repository-${index}`);
  mkdirSync(directory);
  await git(directory, ['init', '--quiet']);
  await git(directory, ['config', 'user.name', 'Interlock Dogfood']);
  await git(directory, ['config', 'user.email', 'dogfood@example.invalid']);
  writeFileSync(join(directory, 'seed.txt'), 'disposable repository\n');
  await git(directory, ['add', 'seed.txt']);
  await git(directory, ['commit', '--quiet', '-m', 'Establish disposable dogfood baseline']);
  await bead(directory, ['init', '--non-interactive', '--skip-hooks', '--skip-agents', '--prefix', `dogfood${index}`, '--quiet']);
  await git(directory, ['reset', '--quiet']);
  return directory;
}

async function issue(directory, title, criterion, path) {
  return bead(directory, ['create', title, '--description', `Value: Prove local agent coordination.\n\nWork: Produce ${path}.`, '--acceptance', criterion, '--silent']);
}

async function cliSmoke(directory, index) {
  const beadId = await issue(directory, 'CLI smoke', 'The smoke file contains 42.', 'smoke.txt');
  await cli(['claim', beadId, '--actor', 'dogfood-cli', '--session-pid', String(process.pid), '--path', 'smoke.txt', '--repo', directory]);
  await cli(['heartbeat', beadId, '--repo', directory]);
  const active = JSON.parse(await cli(['status', '--all', '--json', '--repo', directory]));
  assert.equal(active.length, 1);
  if (index === 1) {
    const worktree = join(evidence, 'second-worktree');
    await git(directory, ['worktree', 'add', '--quiet', '-b', 'dogfood-collision', worktree]);
    const competing = await issue(directory, 'Collision smoke', 'The smoke file contains 42.', 'smoke.txt');
    const conflict = await run(process.execPath, [executable, 'claim', competing, '--actor', 'dogfood-other',
      '--session-pid', String(process.pid), '--path', 'smoke.txt', '--repo', worktree]);
    assert.notEqual(conflict.exitCode, 0);
    assert.match(conflict.stderr, /lease|owned|conflict/i);
    const ownership = JSON.parse(await cli(['status', '--all', '--json', '--repo', worktree]));
    assert.equal(ownership.length, 1);
    report.worktreeCollision = { directory, worktree, beadId, competing, ownership, rejectedExit: conflict.exitCode };
  }
  writeFileSync(join(directory, 'smoke.txt'), '42');
  await git(directory, ['add', 'smoke.txt']);
  await cli(['complete', beadId, '--repo', directory]);
  assert.equal(JSON.parse(await bead(directory, ['show', beadId, '--json']))[0].status, 'closed');
  assert.deepEqual(JSON.parse(await cli(['status', '--all', '--json', '--repo', directory])), []);
  await git(directory, ['commit', '--quiet', '-m', 'Record disposable CLI result']);
  report.smokes.push({ directory, beadId, completed: true });
}

async function connect(pane) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(installed, 'dist/src/mcp/main.js')], env: { ...environment, INTERLOCK_PANE: pane, INTERLOCK_PANE_TOKEN: tokens[pane] }, stderr: 'pipe' });
  const client = new Client({ name: `dogfood-${pane}`, version: '1' });
  await client.connect(transport);
  const connection = { pane, client, transport, pid: transport.pid };
  connections.add(connection);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'task_complete'));
  record({ operation: 'mcp-connect', pane, pid: connection.pid, tools: tools.tools.map((tool) => tool.name) });
  return connection;
}

async function call(connection, name, args = {}, expectError = false) {
  const result = await connection.client.callTool({ name, arguments: args });
  record({ operation: 'mcp-call', pane: connection.pane, pid: connection.pid, name, args, result });
  assert.equal(result.isError === true, expectError, JSON.stringify(result));
  return result.structuredContent;
}

async function bootstrap() {
  const initialized = JSON.parse(await cli(['orchestrator', 'init']));
  const template = join(evidence, 'pod.json');
  writeFileSync(template, JSON.stringify({ members: ['agent-a', 'agent-b'], leader: 'agent-a', succession: ['agent-a', 'agent-b'] }));
  tokens = JSON.parse(await cli(['pod', 'create', '--name', 'dogfood', '--template', template,
    '--orchestrator-token', initialized.token])).tokens;
  return Promise.all([connect('agent-a'), connect('agent-b')]);
}

async function loseResponse(owner, helper, request) {
  const receive = owner.transport.onmessage;
  let dropped = false;
  owner.transport.onmessage = (message, extra) => {
    if (message.result?.structuredContent?.message?.requestId === request.request_id) {
      dropped = true;
      record({ operation: 'drop-accepted-response', pane: owner.pane, requestId: request.request_id });
      return;
    }
    receive(message, extra);
  };
  const pending = owner.client.callTool({ name: 'message_send', arguments: request }).then(
    () => { throw new Error('The injected lost response reached its caller'); }, () => undefined);
  let delivered;
  for (let attempt = 0; attempt < 30 && !delivered; attempt += 1) {
    const inbox = await call(helper, 'inbox_list', { task: request.task });
    delivered = inbox.messages.find((message) => message.requestId === request.request_id);
    if (!delivered || !dropped) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(delivered && dropped, 'Recipient must observe the accepted send before sender death');
  process.kill(owner.pid, 'SIGKILL');
  await owner.client.close();
  await pending;
  connections.delete(owner);
  record({ operation: 'owner-killed', pane: owner.pane, pid: owner.pid, signal: 'SIGKILL' });
  return delivered;
}

async function mcpScenario(directory) {
  const agents = await bootstrap();
  const criterion = 'The result file contains 42.';
  const beadId = await issue(directory, 'Agent-native answer', criterion, 'answer.txt');
  const contract = { beadId, paths: ['answer.txt'], checks: [{ criterion, command: [process.execPath, '-e',
    "if(require('fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1);console.log('verified answer 42')"] }] };
  await call(agents[0], 'task_create', { id: 'answer', title: 'Answer', value: 'Correct answer', workspace: directory, contract });
  for (const agent of agents) assert.ok((await call(agent, 'task_list')).tasks.some((task) => task.id === 'answer'));
  const race = await Promise.all(agents.map(async (agent) => {
    const result = await agent.client.callTool({ name: 'task_claim', arguments: { id: 'answer' } });
    record({ operation: 'claim-race', pane: agent.pane, pid: agent.pid, result });
    return result;
  }));
  assert.equal(race.filter((result) => !result.isError).length, 1);
  const winner = race.findIndex((result) => !result.isError);
  const owner = agents[winner];
  const helper = agents[1 - winner];
  const claim = race[winner].structuredContent.task;
  assert.equal(claim.execution.process.pid, owner.pid);
  await call(owner, 'task_checkpoint', { id: 'answer', text: 'Ask the other agent for the expected answer. Write its reply value to the contracted path. Then submit the result.' });
  await call(helper, 'task_recover', { id: 'answer' }, true);
  const request = { to: helper.pane, task: 'answer', request_id: 'expected-answer-1', text: 'Return the required answer as JSON.' };
  const accepted = await loseResponse(owner, helper, request);
  await call(helper, 'inbox_claim', { message: accepted.id });
  const reply = { reply_to: accepted.id, request_id: 'answer-reply-1', text: JSON.stringify({ answer: 42 }) };
  const replied = await call(helper, 'message_send', reply);
  const replyRetry = await call(helper, 'message_send', reply);
  assert.equal(replyRetry.message.id, replied.message.id);
  const recoveryStart = performance.now();
  const recovered = (await call(helper, 'task_recover', { id: 'answer' })).task;
  report.metrics.recoveryMs = performance.now() - recoveryStart;
  assert.equal(recovered.stage, 'open');
  assert.equal(recovered.execution.phase, 'released');
  assert.equal(JSON.parse(await bead(directory, ['show', beadId, '--json']))[0].status, 'open');
  assert.deepEqual(JSON.parse(await cli(['status', '--all', '--json', '--repo', directory])), []);
  const restarted = await connect(owner.pane);
  assert.notEqual(restarted.pid, owner.pid);
  const retried = await call(restarted, 'message_send', request);
  assert.equal(retried.message.id, accepted.id);
  assert.equal(retried.deduplicated, true);
  await call(helper, 'inbox_close', { message: accepted.id });
  await call(restarted, 'inbox_claim', { message: replied.message.id });
  await call(restarted, 'inbox_close', { message: replied.message.id });
  await call(helper, 'task_claim', { id: 'answer' });
  const context = await call(helper, 'task_resume', { id: 'answer' });
  assert.match(context.tasks[0].checkpoint, /contracted path/);
  assert.equal(context.tasks[0].executionHistory[0].contractId, claim.execution.contractId);
  const response = context.messages.find((message) => message.requestId === 'answer-reply-1');
  assert.ok(response);
  const outputPath = context.tasks[0].contract.paths[0];
  writeFileSync(join(context.tasks[0].workspace, outputPath), String(JSON.parse(response.text).answer));
  await git(directory, ['add', outputPath]);
  const completed = (await call(helper, 'task_complete', { id: 'answer',
    result: { summary: 'Produced the answer from durable task context.', artifacts: [outputPath] } })).task;
  assert.equal(completed.stage, 'done');
  assert.equal(completed.execution.phase, 'done');
  assert.equal(completed.execution.verification.length, contract.checks.length);
  assert.ok(completed.execution.verification.every((check) => check.passed && check.source === 'interlock-executed'));
  assert.equal(JSON.parse(await bead(directory, ['show', beadId, '--json']))[0].status, 'closed');
  assert.deepEqual(JSON.parse(await cli(['status', '--all', '--json', '--repo', directory])), []);
  const final = await call(helper, 'task_resume', { id: 'answer' });
  const logicalIds = ['expected-answer-1', 'answer-reply-1'];
  const duplicateCount = logicalIds.reduce((count, id) => count + Math.max(0, final.messages.filter((message) => message.requestId === id).length - 1), 0);
  assert.equal(duplicateCount, 0);
  const pendingMessages = (await call(helper, 'inbox_summary')).pending + (await call(restarted, 'inbox_summary')).pending;
  assert.equal(pendingMessages, 0);
  report.metrics = { ...report.metrics, humanContextTransfers: 0, humanInterventions: 0, duplicateCount,
    pendingMessages, taskClaimWinners: 1, acceptanceItems: contract.checks.length, observedPassedItems: completed.execution.verification.length };
  report.workflow = { beadId, owner: owner.pane, helper: helper.pane, originalPid: owner.pid, restartedPid: restarted.pid,
    initialContractId: claim.execution.contractId, finalContractId: completed.execution.contractId, completed, finalContext: final };
}

async function atlasSmoke() {
  const atlas = '/Users/master/projects/atlas-terminal';
  if (!existsSync(atlas)) { report.atlas = { status: 'skipped', reason: 'Target directory is absent' }; return; }
  const before = await run('git', ['-C', atlas, 'status', '--porcelain', '--untracked-files=no']);
  if (before.exitCode !== 0 || before.stdout.trim()) {
    report.atlas = { status: 'skipped', reason: 'Tracked tree is not clean', trackedStatus: before.stdout }; return;
  }
  const head = await git(atlas, ['rev-parse', 'HEAD']);
  const result = await run(process.execPath, [executable, 'status', '--all', '--json', '--repo', atlas]);
  const after = await git(atlas, ['status', '--porcelain', '--untracked-files=no']);
  assert.equal(after, '');
  assert.equal(await git(atlas, ['rev-parse', 'HEAD']), head);
  report.atlas = { status: result.exitCode === 0 ? 'read-only-smoke-passed' : 'read-only-smoke-failed', head, exitCode: result.exitCode,
    trackedFilesUnchanged: true, scope: 'Packed CLI status only. No target application changes or lease mutations.' };
}

try {
  if (process.env.INTERLOCK_DOGFOOD_INSTALL) {
    installed = resolve(process.env.INTERLOCK_DOGFOOD_INSTALL);
    report.artifact = { reusedInstallation: installed };
  }
  else {
    await required('npm', ['run', 'build']);
    const packed = JSON.parse(await required('npm', ['pack', '--json', '--pack-destination', evidence]));
    const archive = join(evidence, packed[0].filename);
    const installation = join(evidence, 'installed');
    mkdirSync(installation);
    writeFileSync(join(installation, 'package.json'), JSON.stringify({ private: true }));
    await required('npm', ['install', '--no-audit', '--no-fund', archive], installation);
    installed = join(installation, 'node_modules/@raava-solutions/interlock');
    report.artifact = { archive, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), installation, manifest: packed[0] };
  }
  executable = join(installed, 'dist/src/cli/main.js');
  assert.ok(existsSync(executable));
  const requireInstalled = createRequire(join(installed, 'package.json'));
  ({ Client } = await import(pathToFileURL(requireInstalled.resolve('@modelcontextprotocol/sdk/client/index.js')).href));
  ({ StdioClientTransport } = await import(pathToFileURL(requireInstalled.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href));
  report.installed = installed;
  await required('bd', ['--version']);
  const repositories = [];
  for (let index = 1; index <= 3; index += 1) {
    const directory = await initializeRepository(index);
    repositories.push(directory);
    await cliSmoke(directory, index);
  }
  await mcpScenario(repositories[0]);
  await atlasSmoke();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([...connections].map((connection) => connection.client.close()));
  report.finishedAt = new Date().toISOString();
  save();
  process.stdout.write(JSON.stringify({ passed: report.passed, report: join(evidence, 'report.json'), error: report.error }, null, 2) + '\n');
}
