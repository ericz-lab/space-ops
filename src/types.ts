export type Status = "healthy" | "pending" | "failing" | "recovering" | "unknown" | "paused";
export type Verdict = "pass" | "fail" | "unknown";
export type Operator = "exists" | "eq" | "lt" | "gt" | "ageLessThan";
export type Assertion = { path: string; operator: Operator; value?: string | number | boolean };
export type Rule = {
  id: string; name: string; kind: "http"; url: string; app: string; enabled: boolean;
  intervalMs: number; timeoutMs: number; failAfter: number; recoverAfter: number;
  recoveryTaskId?: string; evidenceTimestampPath?: string;
  expectedStatus: number; assertions: Assertion[]; severity: "warning" | "critical";
};
export type Sample = { id: string; name: string; app: string; kind: string; verdict: Verdict; code: string; detail: string; value?: number | string; threshold?: number | string; latencyMs?: number; evidenceAt?: string; coverage: "availability" | "execution" | "assertion" | "host"; failAfter?: number; recoverAfter?: number; severity?: "warning" | "critical"; staleAfterMs?: number };
export type Check = Sample & { status: Status; failures: number; successes: number; observedAt: string; lastPassedAt: string | null; mutedUntil: string | null; enabled: boolean };
export type Incident = { id: string; checkId: string; name: string; app: string; severity: "warning" | "critical"; status: "open" | "acknowledged" | "resolved"; openedAt: string; updatedAt: string; resolvedAt: string | null; detail: string; events: { at: string; type: string; detail: string }[] };
export type Snapshot = { version: 1; machine: string; generatedAt: string; lastScanAt: string | null; staleAfterMs: number; checks: Check[]; incidents: Incident[]; history: { at: string; passing: number; failing: number; unknown: number }[] };
export type PeerView = { name: string; status: "healthy" | "unknown"; error?: string; snapshot: Snapshot | null; receivedAt: string | null };
export type Settings = { notifications: boolean; failAfter: number; recoverAfter: number; taskErrorThreshold: number; diskPercent: number; memoryPercent: number };
export const DEFAULT_SETTINGS: Settings = { notifications: false, failAfter: 3, recoverAfter: 2, taskErrorThreshold: 3, diskPercent: 90, memoryPercent: 95 };
