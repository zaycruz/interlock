export interface BeadsIssue {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: string;
  assignee: string | undefined;
  metadata: Record<string, unknown> | undefined;
  metadataMalformed: boolean;
}

export interface BeadsDependency {
  id: string;
  title: string;
  status: string;
}

export interface ValidatedIssue {
  issue: BeadsIssue;
  value: string;
  work: string;
  out: string;
  acceptanceCriteria: string;
}

export interface LeaseHealth {
  status: "fresh" | "expired";
  heartbeatAt: number;
}

export interface InterlockMetadata {
  contractId: string;
  actor: string;
  session: {
    pid: number;
    startedAt: string;
  };
  paths: string[];
  leaseHealth: LeaseHealth;
}

export interface InterlockRecoveryMarker {
  eventId: number;
  contractId: string;
}

export interface WorkContract {
  issue: ValidatedIssue;
  paths: string[];
  upstream: BeadsDependency[];
  downstream: BeadsDependency[];
  leaseHealth: LeaseHealth | undefined;
  drift: string | undefined;
}
