import { writeDigestDelivery } from "./state.js";
import type { CoordinationMessage, CoordinationState, DigestDelivery } from "./types.js";

export function deliverDigests(state: CoordinationState, reason: DigestDelivery["reason"]): DigestDelivery[] {
  const delivered = new Set(state.digests.flatMap((digest) => digest.messageIds));
  const byPane = new Map<string, CoordinationMessage[]>();
  for (const message of state.messages) {
    if (message.state !== "queued" || delivered.has(message.id)) continue;
    const messages = byPane.get(message.toPane) ?? []; messages.push(message); byPane.set(message.toPane, messages);
  }
  const deliveries: DigestDelivery[] = [];
  for (const [pane, messages] of byPane) {
    const session = state.sessions.find((candidate) => candidate.pane === pane);
    if (!session || session.state !== "idle") continue;
    const id = state.nextDigestId++;
    deliveries.push(writeDigestDelivery(state, { id, pane, messageIds: messages.map((message) => message.id), reason, createdAt: new Date().toISOString() }, messages));
  }
  return deliveries;
}
