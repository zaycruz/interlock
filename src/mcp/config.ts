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
  // Empty-string env values are the shell/docker convention for "unset";
  // normalizing them here keeps the engine from receiving a blank state dir
  // (cryptic `mkdir ''` per call) and gives the token fallback its chance.
  const blank = (value: string | undefined): boolean => value === undefined || value.trim() === "";
  return {
    config: {
      pane: pane!,
      token: blank(env.INTERLOCK_PANE_TOKEN) ? undefined : env.INTERLOCK_PANE_TOKEN,
      stateDir: blank(env.INTERLOCK_STATE_DIR) ? undefined : env.INTERLOCK_STATE_DIR,
    },
    problems: [],
  };
}
