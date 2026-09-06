import { parseArgs, required, requiredToken } from "./args.js";
import { assertMemberToken, readCoordinationState } from "./state.js";
import { validatePaneName } from "./validation.js";

export function inboxSummary(argv: string[]): string {
  const parsed = parseArgs(argv);
  const pane = validatePaneName(required(parsed, "pane"));
  const state = readCoordinationState();
  assertMemberToken(state, pane, requiredToken(parsed));
  let queued = 0;
  let claimed = 0;
  for (const message of state.messages) {
    if (message.toPane !== pane) continue;
    if (message.state === "queued") queued += 1;
    if (message.state === "claimed") claimed += 1;
  }
  const digests = state.digests.filter((digest) => digest.pane === pane);
  const pointers = digests.slice(-20).map(({ id, file, reason, createdAt, messageIds }) => ({
    id, file, reason, createdAt, messageCount: messageIds.length,
  }));
  return JSON.stringify({ ok: true, pane, pending: { queued, claimed, total: queued + claimed },
    digests: pointers, digestTotal: digests.length, digestsTruncated: digests.length > pointers.length });
}
