import { spawnSync } from "node:child_process";
import { z } from "zod";
import { fileURLToPath } from "node:url";

const checkSchema = z.object({
  criterion: z.string().trim().min(1),
  command: z.array(z.string().min(1).refine((value) => !value.includes("\0"), "command arguments cannot contain NUL")).min(1),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
}).strict();

export type VerificationCheck = z.infer<typeof checkSchema>;

export interface VerificationResult {
  source: "interlock-executed";
  criterion: string;
  command: string[];
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  output: string;
  error?: string;
  finishedAt: string;
}

export function parseVerificationChecks(value: unknown): VerificationCheck[] {
  const parsed = z.array(checkSchema).min(1).safeParse(value);
  if (!parsed.success) throw new Error(`invalid verification checks: ${parsed.error.message}`);
  const criteria = parsed.data.map((check) => check.criterion);
  if (new Set(criteria).size !== criteria.length) throw new Error("duplicate verification criterion");
  return parsed.data;
}

export function runVerificationChecks(repositoryPath: string, checks: readonly VerificationCheck[]): VerificationResult[] {
  return checks.map((check) => runCheck(repositoryPath, check));
}

const processResultSchema = z.object({
  passed: z.boolean(), exitCode: z.number().nullable(), signal: z.string().nullable(),
  output: z.string(), error: z.string().optional(),
});

function runCheck(repositoryPath: string, check: VerificationCheck): VerificationResult {
  const supervisor = fileURLToPath(new URL("./verification-process.js", import.meta.url));
  const result = spawnSync(process.execPath, [supervisor, JSON.stringify(check)], {
    cwd: repositoryPath,
    encoding: "utf8",
    timeout: check.timeoutMs + 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 512 * 1024,
    shell: false,
  });
  const base = { source: "interlock-executed" as const, criterion: check.criterion,
    command: [...check.command], finishedAt: new Date().toISOString() };
  if (result.error !== undefined || result.status !== 0) {
    return { ...base, passed: false, exitCode: null, signal: result.signal, output: "",
      error: result.error?.message ?? `verification supervisor failed: ${result.stderr}` };
  }
  return { ...base, ...processResultSchema.parse(JSON.parse(result.stdout)) };
}
