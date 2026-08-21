import { runCoordinationCli } from "@raava-solutions/interlock/coordination";
import type { CoordinationMessage, CoordinationSession, DigestDelivery } from "@raava-solutions/interlock/coordination";

/**
 * Herdr's pane-shaped transport over Interlock's public coordination CLI.
 * The engine owns routing and durable state; this adapter only translates
 * host calls into the public command surface.
 */
export interface SpaceSendInput {
  fromPane: string;
  toPane: string;
  text: string;
  token: string;
  workspace?: string;
  reply?: number;
  channel?: number;
}

export interface SpaceSendResult {
  message: CoordinationMessage;
  digests: DigestDelivery[];
}

export interface SpaceInboxInput {
  pane: string;
  token: string;
  all?: boolean;
}

export interface SpaceInboxResult {
  ok: true;
  pane: string;
  messages: CoordinationMessage[];
  digests: DigestDelivery[];
}

export interface SpaceSessionInput {
  pane: string;
  token: string;
  state: CoordinationSession["state"];
}

export interface SpaceSessionResult {
  ok: true;
  session: CoordinationSession;
  digests: DigestDelivery[];
}

export interface SpaceWatchResult {
  ok: true;
  digested: number;
  messageIds: number[];
  heartbeatAt: string;
  digests: DigestDelivery[];
}

export interface SpaceAdapter {
  send(input: SpaceSendInput): SpaceSendResult;
  inbox(input: SpaceInboxInput): SpaceInboxResult;
  session(input: SpaceSessionInput): SpaceSessionResult;
  watch(): SpaceWatchResult;
}

export function createSpaceAdapter(): SpaceAdapter {
  return {
    send: (input) => invoke<SpaceSendResult>("send", [
      "send",
      "--from-pane", input.fromPane,
      "--to-pane", input.toPane,
      "--token", input.token,
      "--text", input.text,
      ...(input.workspace === undefined ? [] : ["--workspace", input.workspace]),
      ...(input.reply === undefined ? [] : ["--reply", String(input.reply)]),
      ...(input.channel === undefined ? [] : ["--channel", String(input.channel)]),
    ]),
    inbox: (input) => invoke<SpaceInboxResult>("inbox", [
      "inbox",
      "--pane", input.pane,
      "--token", input.token,
      "--json",
      ...(input.all ? ["--all"] : []),
    ]),
    session: (input) => invoke<SpaceSessionResult>("session", [
      "session", "set",
      "--pane", input.pane,
      "--token", input.token,
      "--state", input.state,
    ]),
    watch: () => invoke<SpaceWatchResult>("watch", ["watch", "--once"]),
  };
}

function invoke<T>(operation: string, argv: string[]): T {
  const result = runCoordinationCli(argv);
  if (result === null) throw new Error(`Interlock adapter could not route ${operation}`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Interlock ${operation} failed`);
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(`Interlock ${operation} returned invalid JSON: ${message(error)}`);
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
