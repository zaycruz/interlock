import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

// Run: TMPDIR=/Volumes/RTL-2TB PI_BIN=pi node test/pi/host-smoke.mjs <installed-package-root>
const root = resolve(process.argv[2] ?? '.');
const artifact = mkdtempSync(join(tmpdir(), 'interlock-pi-smoke-'));
const repo = join(artifact, 'repo'); mkdirSync(repo);
const env = { ...process.env, PI_CODING_AGENT_DIR: join(artifact, 'pi'), PI_TELEMETRY: '0', TMPDIR: artifact, INTERLOCK_STATE_DIR: join(artifact, 'state'), INTERLOCK_PANE_TOKEN: 'disposable-pi-smoke-token', BD_NON_INTERACTIVE: '1' };
delete env.INTERLOCK_PANE; delete env.INTERLOCK_CLI;
for (const key of Object.keys(env)) if (/API_KEY|SECRET|PASSWORD|TOKEN/.test(key) && key !== 'INTERLOCK_PANE_TOKEN') delete env[key];
const evidence = [];
function run(command, args) {
  const stdout = execFileSync(command, args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return stdout.trim();
}
function cli(args) { return JSON.parse(run(process.execPath, [join(root, 'dist/src/cli/main.js'), ...args])); }
run('git', ['init', '-q']); run('git', ['config', 'user.name', 'Interlock smoke']); run('git', ['config', 'user.email', 'smoke@example.invalid']);
writeFileSync(join(repo, 'owned.txt'), 'unchanged\n');run('git', ['add', 'owned.txt']);run('git', ['commit', '-qm', 'Create disposable smoke target']);
run('bd', ['init', '--prefix', 'pismoke', '--non-interactive']);
const bead = JSON.parse(run('bd', ['create', 'Pi lifecycle smoke', '--description', 'Value: Verify host ownership\nWork: Hold an exact path', '--acceptance', 'Smoke check passes', '--json']));
// The helper invokes Pi's documented reload operation without a model request.
const helper = join(artifact, 'reload.ts');
writeFileSync(helper, 'export default function(pi) { pi.registerCommand("smoke-reload", { description: "Reload isolated smoke runtime", handler: async (_args, ctx) => { await ctx.reload(); } }); }');
const proc = spawn(process.env.PI_BIN ?? 'pi', ['--offline', '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools', '-e', join(root, 'dist/src/pi/index.js'), '-e', helper], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = []; const stderr = [];
proc.stderr.on('data', (chunk) => stderr.push(String(chunk)));
createInterface({ input: proc.stdout }).on('line', (line) => { try { lines.push(JSON.parse(line)); } catch { lines.push({ raw: line }); } });
async function until(predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; if (proc.exitCode !== null) throw new Error('Pi exited: ' + stderr.join('')); await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('Pi response timeout: ' + JSON.stringify(lines.slice(-4)));
}
let seq = 0;
async function rpc(type, rest = {}) { const id = String(++seq); proc.stdin.write(JSON.stringify({ id, type, ...rest }) + '\n'); const response = await until(() => lines.find((line) => line.id === id && line.type === 'response')); assert.equal(response.success, true, JSON.stringify(response)); return response.data; }
async function command(message) { await rpc('prompt', { message }); }
try {
  const commands = await rpc('get_commands');
  assert.equal(commands.commands.filter((item) => item.name.startsWith('interlock-')).length, 6);
  const state = await rpc('get_state');
  const pane = `pi:${state.sessionId}`;
  cli(['task', 'add', '--id', 'pi-task', '--pane', pane, '--workspace', repo, '--contract', JSON.stringify({ beadId: bead.id, paths: ['owned.txt'], checks: [{ criterion: 'Smoke check passes', command: [process.execPath, '-e', 'process.exit(0)'] }] })]);
  await command('/interlock-claim pi-task');
  const read = () => cli(['task', 'inspect', 'pi-task', '--pane', pane]).task;
  let task = read(); assert.equal(task.execution.phase, 'active'); assert.equal(task.execution.process.pid, proc.pid);
  const contract = task.execution.contractId;
  evidence.push({ check: 'claim', pane, bead: bead.id, contract, hostPid: proc.pid, phase: task.execution.phase });
  cli(['task', 'checkpoint', 'pi-task', '--pane', pane, '--text', 'Resume at verified Pi checkpoint']);
  await command('/interlock-heartbeat pi-task');
  task = read(); assert.equal(task.execution.contractId, contract);
  evidence.push({ check: 'heartbeat', contract });
  await command('/smoke-reload');
  await command('/interlock-resume');
  task = read(); assert.equal(task.execution.contractId, contract); assert.equal(task.execution.phase, 'active');
  assert(lines.some((line) => line.method === 'notify' && line.message.includes('Resume at verified Pi checkpoint')));
  const hostState = await rpc('get_state'); assert.equal(hostState.isStreaming, false);
  evidence.push({ check: 'reload and durable context restoration (model delivery queued)', contract, checkpoint: task.checkpoint });
  await rpc('new_session');
  task = read(); assert.equal(task.stage, 'open'); assert.equal(task.execution.phase, 'released');
  assert.equal(run('git', ['diff', '--name-only', '--', 'owned.txt']), '');
  evidence.push({ check: 'session departure releases exact contract', phase: task.execution.phase, reason: task.execution.releaseReason });
  console.log(JSON.stringify({ artifact, evidence }, null, 2));
} finally {
  proc.kill('SIGTERM');
  await new Promise((resolve) => { if (proc.exitCode !== null) resolve(); else { proc.once('exit', resolve); setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 5000).unref(); } });
  writeFileSync(join(artifact, 'evidence.json'), JSON.stringify({ evidence, lines, stderr }, null, 2));
}
