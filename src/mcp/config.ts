// U2: MCP server configuration. One server instance serves one pane, bound
// at startup by the host through env vars (KTD6): INTERLOCK_PANE,
// INTERLOCK_PANE_TOKEN, INTERLOCK_STATE_DIR. The token never travels in argv
// (visible in ps); the engine already reads this env var as its --token
// fallback, so delegation to the engine is exact. Missing or invalid config
// never exits (KTD5): the server starts and each call fails with the missing
// variable named, so a host's tools/list still works during setup.
import { validatePaneName } from "../coordination/index.js";

export interface McpConfig {
  pane: string;
  token?: string;
  stateDir?: string;
}

export interface McpConfigProblems {
  problems: string[];
}

export interface McpConfigReading {
  config: McpConfig | null;
  problems: string[];
}

export function readMcpConfig(env: NodeJS.ProcessEnv): McpConfigReading {
  const problems: string[] = [];
  const pane = env.INTERLOCK_PANE;
  if (pane === undefined || pane.trim() === "") {
    problems.push("INTERLOCK_PANE is not set: the MCP server serves exactly one pane");
  } else {
    try {
      validatePaneName(pane, "INTERLOCK_PANE");
    } catch (error) {
      problems.push("INTERLOCK_PANE is invalid: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (problems.length > 0) return { config: null, problems };
  // INTERLOCK_PANE_TOKEN and INTERLOCK_STATE_DIR stay optional here: the
  // engine gives the first its --token-fallback error and the second its
  // default state dir. Surfacing those per call is the engine's job.
  return { config: { pane: pane!, token: env.INTERLOCK_PANE_TOKEN, stateDir: env.INTERLOCK_STATE_DIR }, problems: [] };
}
