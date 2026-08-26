import type { PodTemplate } from "./pods.js";
import type { AwarenessEvent } from "./types.js";

// ADR-0002 exposes this contract as types only. Native identities and effects
// belong to each host package; the engine never imports an implementation.
export interface HostAdapter<NativeIdentity = unknown, NativeGroup = unknown, NativeEvent = unknown, EngineEvent = unknown, NativeEffect = unknown> {
  readonly host: string;
  readonly contractVersion: 1;
  provisionMember(native: NativeIdentity, pod: string): MemberHandle;
  revokeMember(member: MemberHandle): void;
  materializePod(native: NativeGroup, template: PodTemplate): PodHandle;
  releasePod(pod: PodHandle): void;
  toEngine(event: NativeEvent): EngineEvent | null;
  fromEngine(event: AwarenessEvent | Delivery): NativeEffect;
}

export interface MemberHandle { readonly member: string; readonly token: string; }
export interface PodHandle { readonly pod: string; }
export interface Delivery { readonly member: string; readonly digestId: number; }
