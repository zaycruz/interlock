import { resolve } from "node:path";
import { runLeaseCommand, type LeaseCommand, type LeaseDependencies } from "../application/lease-commands.js";
import { coordinationUsage, runCoordinationCli } from "../coordination/index.js";
import { runSetupDoctor, type SetupDoctorDependencies } from "./setup-doctor.js";

export interface CliResult { exitCode: number; stdout: string; stderr: string; }
export interface CliDependencies extends LeaseDependencies {
  setupDoctor?: SetupDoctorDependencies;
}

export function runCli(argv: string[], dependencies: CliDependencies = {}): CliResult {
  const coordination = runCoordinationCli(argv);
  if (coordination !== null) return coordination;
  const setupDoctor = runSetupDoctor(argv, dependencies.setupDoctor);
  if (setupDoctor !== null) return setupDoctor;
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) return { exitCode: 0, stdout: `${usage()}\n`, stderr: "" };
  try {
    const result = runLeaseCommand(parseCommand(argv), dependencies);
    return { exitCode: 0, stdout: `${result}\n`, stderr: "" };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `Error: ${message(error)}\n` };
  }
}

function parseCommand(argv: string[]): LeaseCommand {
  const [name, ...rest] = argv;
  if (name === undefined) throw new Error(usage());
  const parsed = parseFlags(rest, name === "status" ? ["all", "json"] : []);
  const repositoryPath = resolve(single(parsed, "repo") ?? process.cwd());
  if (name === "reconcile") { requirePositionals(parsed, 0, name); requireOnly(parsed, ["repo"]); return { name, repositoryPath }; }
  if (name === "claim") return parseClaim(parsed, repositoryPath);
  if (name === "status") return parseStatus(parsed, repositoryPath);
  return parseLeaseAction(name, parsed, repositoryPath);
}

function parseLeaseAction(name: string, parsed: ParsedFlags, repositoryPath: string): LeaseCommand {
  const beadId = parsed.positionals[0];
  requirePositionals(parsed, 1, name);
  if (name === "heartbeat" || name === "complete" || name === "resolve") { requireOnly(parsed, ["repo"]); return { name, beadId, repositoryPath }; }
  if (name === "release") { requireOnly(parsed, ["reason", "repo"]); return { name, beadId, reason: required(parsed, "reason"), repositoryPath }; }
  throw new Error(`Unknown command: ${name}\n${usage()}`);
}

interface ParsedFlags { positionals: string[]; flags: Map<string, string[]>; }
function parseFlags(values: string[], booleanFlags: string[] = []): ParsedFlags {
  const flags = new Map<string, string[]>(); const positionals: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const name = value.slice(2);
    if (name === "" || name.includes("=")) throw new Error(`Invalid option: ${value}`);
    let flagValue = "true";
    if (!booleanFlags.includes(name)) {
      const supplied = values[++index];
      if (supplied === undefined || supplied.startsWith("--")) throw new Error(`Option ${value} requires a value`);
      flagValue = supplied;
    }
    flags.set(name, [...(flags.get(name) ?? []), flagValue]);
  }
  return { positionals, flags };
}

function requireOnly(parsed: ParsedFlags, allowed: string[]): void { for (const name of parsed.flags.keys()) if (!allowed.includes(name)) throw new Error(`Unknown option: --${name}`); }

function requirePositionals(parsed: ParsedFlags, count: number, command: string): void {
  if (parsed.positionals.length !== count) throw new Error(`${command} requires ${count === 0 ? "no arguments" : "a Beads issue ID"}`);
}

function values(parsed: ParsedFlags, name: string): string[] { return parsed.flags.get(name) ?? []; }

function single(parsed: ParsedFlags, name: string): string | undefined {
  const found = values(parsed, name); if (found.length > 1) throw new Error(`Option --${name} may only be specified once`); return found[0];
}

function required(parsed: ParsedFlags, name: string): string {
  const value = single(parsed, name); if (value === undefined || value.trim() === "") throw new Error(`Option --${name} is required`); return value;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function usage(): string {
  return ["Usage:", "  interlock claim <bead-id> --actor <actor> --session-pid <pid> --path <path> [--path <path>] [--repo <repo>]",
    "  interlock status <bead-id> [--json] [--repo <repo>]", "  interlock status --all --json [--repo <repo>]", "  interlock heartbeat <bead-id> [--repo <repo>]",
    "  interlock complete <bead-id> [--repo <repo>]", "  interlock release <bead-id> --reason <reason> [--repo <repo>]",
    "  interlock resolve <bead-id> [--repo <repo>]  (operator: clear or confirm an ambiguous attempted claim after inspecting Beads)",
    "  interlock reconcile [--repo <repo>]", "  interlock setup [--yes] [--remove]", "  interlock doctor", ...coordinationUsage()] .join("\n");
}

function parseClaim(parsed: ParsedFlags, repositoryPath: string): LeaseCommand {
  const name = "claim";
    const beadId = parsed.positionals[0];
    requirePositionals(parsed, 1, name);
    requireOnly(parsed, ["actor", "session-pid", "path", "repo"]);
    const sessionPid = Number(single(parsed, "session-pid"));
    if (!Number.isSafeInteger(sessionPid) || sessionPid <= 0) throw new Error("--session-pid must be a positive integer");
    const paths = values(parsed, "path");
    if (paths.length === 0) throw new Error("claim requires at least one --path");
    return { name, beadId, actor: required(parsed, "actor"), sessionPid, paths, repositoryPath };
}

function parseStatus(parsed: ParsedFlags, repositoryPath: string): LeaseCommand {
  const name = "status";
    requireOnly(parsed, ["repo", "all", "json"]);
    const all = single(parsed, "all") !== undefined;
    const json = single(parsed, "json") !== undefined;
    if (all) {
      if (!json) throw new Error("status --all requires --json");
      requirePositionals(parsed, 0, name);
      return { name, all: true, beadId: undefined, repositoryPath, json: true };
    }
    const beadId = parsed.positionals[0];
    requirePositionals(parsed, 1, name);
    if (beadId === undefined) throw new Error(`${name} requires a Beads issue ID`);
    return { name, all: false, beadId, repositoryPath, json };
}
