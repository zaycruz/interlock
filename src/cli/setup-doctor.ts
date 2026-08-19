import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const PLUGIN_NAME = "@raava-solutions/interlock-plugin-herdr";
const DEFAULT_HERDR_FLOOR = "0.0.0";

export interface CommandResult { exitCode: number; stdout: string; stderr: string; }
export interface PluginPackage { path: string; version: string; }
export interface ConsentRecord { timestamp: string; engineVersion: string; pluginVersion: string; herdrVersion: string; actions: string[]; }
export interface SetupDoctorDependencies {
  engineVersion?: string;
  minimumHerdrVersion?: string;
  stateDirectory?: () => string;
  inspectStateDirectory?: () => "healthy" | string;
  resolveCommand?: (name: string) => string | undefined;
  execute?: (command: string, args: string[], timeoutMs?: number) => CommandResult;
  plugin?: () => PluginPackage | undefined;
  readConsent?: () => ConsentRecord | undefined;
  writeConsent?: (record: ConsentRecord) => void;
  removeConsent?: () => void;
  isTty?: () => boolean;
  prompt?: (question: string) => string | undefined;
  clock?: () => Date;
}

interface Herdr { path: string; version: string; }

export function runSetupDoctor(argv: string[], dependencies: SetupDoctorDependencies = {}): CommandResult | null {
  const [command, ...flags] = argv;
  if (command !== "setup" && command !== "doctor") return null;
  const allowed = command === "setup" ? new Set(["--yes", "--remove"]) : new Set<string>();
  if (flags.some((flag) => !allowed.has(flag)) || new Set(flags).size !== flags.length) return failure(`Unknown option for ${command}`);
  const deps = defaults(dependencies);
  return command === "doctor" ? doctor(deps) : setup(flags, deps);
}

function doctor(deps: Required<SetupDoctorDependencies>): CommandResult {
  const herdr = detectHerdr(deps);
  const plugin = deps.plugin();
  const consent = deps.readConsent();
  const active = herdr === undefined || herdr === null ? false : pluginActive(deps, herdr, plugin);
  const lines = [
    `engine: ${deps.engineVersion}`,
    `state directory: ${deps.stateDirectory()} (${deps.inspectStateDirectory()})`,
    herdr === undefined || herdr === null ? "herdr: not detected" : `herdr: ${herdr.path} (${herdr.version}; floor ${deps.minimumHerdrVersion})`,
    `consent record: ${consent === undefined ? "absent" : `${consent.timestamp} (${consent.pluginVersion})`}`,
    `plugin link: ${active ? "active" : "not active"}`,
  ];
  if (herdr === null) lines[2] = `herdr not usable: ${herdrReason(deps)}`;
  if (herdr !== undefined && herdr !== null && plugin !== undefined && plugin.version !== deps.engineVersion) lines.push(`version drift: engine ${deps.engineVersion}, plugin ${plugin.version}`);
  const divergent = active !== (consent !== undefined);
  if (divergent) lines.push(`divergence: ${consent === undefined ? "plugin active without consent record" : "consent record exists but plugin is not active"}; repair: interlock setup --yes`);
  const failed = herdr === null || deps.inspectStateDirectory() !== "healthy" || (herdr !== undefined && herdr !== null && plugin !== undefined && plugin.version !== deps.engineVersion) || divergent;
  return { exitCode: failed ? 1 : 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

function setup(flags: string[], deps: Required<SetupDoctorDependencies>): CommandResult {
  const remove = flags.includes("--remove");
  const herdr = detectHerdr(deps);
  if (herdr === undefined || herdr === null) return remove ? failure(`herdr not usable: ${herdr === null ? herdrReason(deps) : "not detected"}`) : success("herdr is not usable; Interlock works standalone. Nothing was changed.");
  const plugin = deps.plugin();
  if (remove) return removePlugin(deps, herdr, plugin);
  const activePlugin = pluginListed(deps);
  if (plugin !== undefined && plugin.version === deps.engineVersion && activePlugin.includes(plugin.version)) return success("Herdr plugin already installed.");
  if (plugin !== undefined && compareVersions(plugin.version, deps.engineVersion) > 0) return failure(`Plugin ${plugin.version} is newer than engine ${deps.engineVersion}; upgrade Interlock instead of downgrading the plugin.`);
  const plan = [
    `herdr detected: ${herdr.path} (${herdr.version})`,
    "Interlock works fully without the plugin.",
    ...(plugin === undefined || plugin.version !== deps.engineVersion ? [`Will run: npm install -g ${PLUGIN_NAME}`] : []),
    "Will run: herdr plugin link <plugin path>",
    "Will verify: herdr plugin list",
    "Uninstall: interlock setup --remove",
  ];
  if (!flags.includes("--yes")) {
    if (!deps.isTty()) return { exitCode: 2, stdout: `${plan.join("\n")}\n`, stderr: "Refusing to prompt without a TTY; pass --yes for explicit scriptable consent.\n" };
    if (deps.prompt("Type yes to continue: ") !== "yes") return success(`${plan.join("\n")}\nnothing was changed`);
  }
  const output = [...plan];
  let resolved = plugin;
  if (resolved === undefined || resolved.version !== deps.engineVersion) {
    if (resolved !== undefined && activePlugin.includes(resolved.version)) {
      const unlink = runEchoed(deps, output, "herdr", ["plugin", "unlink", resolved.path]);
      if (unlink !== undefined) return failure([...output, unlink].join("\n"));
    }
    const install = runEchoed(deps, output, "npm", ["install", "-g", PLUGIN_NAME]);
    if (install !== undefined) return failure([...output, install].join("\n"));
    resolved = deps.plugin();
    if (resolved === undefined || resolved.version !== deps.engineVersion) return failure([...output, `Plugin ${PLUGIN_NAME}@${deps.engineVersion} was not resolvable after installation.`].join("\n"));
  } else output.push(`Plugin package already resolvable at ${resolved.version}; skipping npm install.`);
  const linked = runEchoed(deps, output, "herdr", ["plugin", "link", resolved.path]);
  if (linked !== undefined) return failure([...output, `${linked}\nLink failed. Run \`herdr plugin link ${resolved.path}\` after correcting Herdr, then rerun interlock setup.`].join("\n"));
  if (!pluginActive(deps, herdr, resolved)) return failure([...output, "Activation was not verified by herdr plugin list; no consent record was written."].join("\n"));
  deps.writeConsent({ timestamp: deps.clock().toISOString(), engineVersion: deps.engineVersion, pluginVersion: resolved.version, herdrVersion: herdr.version, actions: ["npm install -g", "herdr plugin link", "herdr plugin list"] });
  return success([...output, "Herdr plugin installed and verified."].join("\n"));
}

function removePlugin(deps: Required<SetupDoctorDependencies>, herdr: Herdr, plugin: PluginPackage | undefined): CommandResult {
  if (plugin === undefined) return failure(`Cannot unlink ${PLUGIN_NAME}: its plugin path is not resolvable.`);
  const output: string[] = [];
  const failed = runEchoed(deps, output, "herdr", ["plugin", "unlink", plugin.path]);
  if (failed !== undefined) return failure([...output, failed].join("\n"));
  deps.removeConsent();
  return success([...output, `Removed Interlock's consent record. To remove the package: npm uninstall -g ${PLUGIN_NAME}`].join("\n"));
}

function runEchoed(deps: Required<SetupDoctorDependencies>, output: string[], command: string, args: string[]): string | undefined {
  output.push(`$ ${command} ${args.join(" ")}`);
  const result = deps.execute(command, args, 5000);
  if (result.exitCode === 0) return undefined;
  return `Command failed: ${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`.trim();
}

function pluginActive(deps: Required<SetupDoctorDependencies>, _herdr: Herdr, plugin: PluginPackage | undefined): boolean {
  if (plugin === undefined) return false;
  return pluginListed(deps).includes(plugin.version);
}
function pluginListed(deps: Required<SetupDoctorDependencies>): string {
  const result = deps.execute("herdr", ["plugin", "list"], 5000);
  return result.exitCode === 0 && result.stdout.includes(PLUGIN_NAME) ? result.stdout : "";
}

function detectHerdr(deps: Required<SetupDoctorDependencies>): Herdr | undefined | null {
  const path = deps.resolveCommand("herdr");
  if (path === undefined) return undefined;
  const result = deps.execute("herdr", ["--version"], 5000);
  const version = parseVersion(result.stdout);
  return result.exitCode === 0 && version !== undefined && compareVersions(version, deps.minimumHerdrVersion) >= 0 ? { path, version } : null;
}

function herdrReason(deps: Required<SetupDoctorDependencies>): string {
  const path = deps.resolveCommand("herdr");
  if (path === undefined) return "not detected";
  const result = deps.execute("herdr", ["--version"], 5000);
  const version = parseVersion(result.stdout);
  if (result.exitCode !== 0) return `herdr --version exited ${result.exitCode}: ${result.stderr || result.stdout}`.trim();
  if (version === undefined) return "herdr --version did not report a SemVer version";
  return `version ${version} is below required ${deps.minimumHerdrVersion}`;
}

function parseVersion(value: string): string | undefined { return value.match(/\b(\d+)\.(\d+)\.(\d+)\b/)?.[0]; }
function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number); const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  return 0;
}
function success(stdout: string): CommandResult { return { exitCode: 0, stdout: `${stdout}\n`, stderr: "" }; }
function failure(stderr: string): CommandResult { return { exitCode: 1, stdout: "", stderr: `${stderr}\n` }; }

function defaults(overrides: SetupDoctorDependencies): Required<SetupDoctorDependencies> {
  const stateDirectory = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "interlock");
  const consentPath = () => join((overrides.stateDirectory ?? stateDirectory)(), "herdr-consent.json");
  return {
    engineVersion: overrides.engineVersion ?? "0.0.4", minimumHerdrVersion: overrides.minimumHerdrVersion ?? DEFAULT_HERDR_FLOOR,
    stateDirectory: overrides.stateDirectory ?? stateDirectory,
    inspectStateDirectory: overrides.inspectStateDirectory ?? (() => "healthy"),
    resolveCommand: overrides.resolveCommand ?? resolveCommand,
    execute: overrides.execute ?? execute,
    plugin: overrides.plugin ?? resolvePlugin,
    readConsent: overrides.readConsent ?? (() => existsSync(consentPath()) ? JSON.parse(readFileSync(consentPath(), "utf8")) as ConsentRecord : undefined),
    writeConsent: overrides.writeConsent ?? ((record) => { mkdirSync((overrides.stateDirectory ?? stateDirectory)(), { recursive: true }); writeFileSync(consentPath(), JSON.stringify(record)); }),
    removeConsent: overrides.removeConsent ?? (() => rmSync(consentPath(), { force: true })),
    isTty: overrides.isTty ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true),
    prompt: overrides.prompt ?? readConsentAnswer, clock: overrides.clock ?? (() => new Date()),
  };
}

function resolveCommand(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(":")) { const candidate = join(directory, name); if (existsSync(candidate)) return candidate; }
  return undefined;
}
function execute(command: string, args: string[], timeoutMs = 5000): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" };
}
function resolvePlugin(): PluginPackage | undefined {
  try {
    const require = createRequire(import.meta.url); const manifest = require.resolve(`${PLUGIN_NAME}/package.json`);
    return { path: dirname(manifest), version: (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version };
  } catch { return undefined; }
}
function readConsentAnswer(question: string): string | undefined {
  process.stdout.write(question);
  const bytes: number[] = []; const buffer = Buffer.alloc(1);
  while (readSync(0, buffer, 0, 1, null) === 1) {
    if (buffer[0] === 10) return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
    bytes.push(buffer[0]!);
  }
  return undefined;
}
