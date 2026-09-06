type ParsedArgs = Map<string, string | true>;

// The equals form preserves values that start with `--`, including message text.
export function parseArgs(argv: string[]): ParsedArgs {
  const values: ParsedArgs = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      values.set(`$${index}`, value);
      continue;
    }
    const eq = value.indexOf("=");
    if (eq > 2) {
      values.set(value.slice(2, eq), value.slice(eq + 1));
      continue;
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    } else {
      values.set(name, true);
    }
  }
  return values;
}

export function required(values: ParsedArgs, name: string): string {
  const value = values.get(name);
  if (typeof value !== "string" || value.trim() === "") throw new Error(`--${name} is required`);
  return value;
}

export function optional(values: ParsedArgs, name: string): string | null {
  const value = values.get(name);
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function requiredToken(values: ParsedArgs): string {
  const value = optional(values, "token") ?? process.env.INTERLOCK_PANE_TOKEN;
  if (value === undefined || value.trim() === "") throw new Error("--token is required (or set INTERLOCK_PANE_TOKEN)");
  return value;
}

export function optionalNumber(values: ParsedArgs, name: string): number | undefined {
  const value = optional(values, name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

export function has(values: ParsedArgs, name: string): boolean {
  return values.has(name);
}
