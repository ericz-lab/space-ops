/** `transient`: a failure below the incident threshold (one-off error); never healthy, never an incident. */
export type Status = "healthy" | "transient" | "failing" | "recovering" | "unknown" | "paused" | "off";
export type Verdict = "pass" | "fail" | "unknown";
/** `today` is for declared app checks: a timestamp whose local date is today in the check's timezone. */
export type Operator = "exists" | "eq" | "lt" | "gt" | "ageLessThan" | "dailyBy" | "today";
export type Assertion = { path: string; operator: Operator; value?: string | number | boolean };
export type Rule = {
  id: string; name: string; kind: "http"; url: string; app: string; enabled: boolean;
  intervalMs: number; timeoutMs: number; failAfter: number; recoverAfter: number;
  recoveryTaskId?: string; evidenceTimestampPath?: string;
  /** IANA zone of `dailyBy` deadlines. */
  timezone?: string;
  /** Active weekdays in timezone, 0 = Sunday. Omitted means every day. */
  weekdays?: number[];
  expectedStatus: number; assertions: Assertion[]; severity: "warning" | "critical";
};
export type Sample = { id: string; name: string; app: string; kind: string; verdict: Verdict; code: string; detail: string; value?: number | string; threshold?: number | string; latencyMs?: number; evidenceAt?: string; coverage: "availability" | "execution" | "assertion" | "host"; failAfter?: number; recoverAfter?: number; severity?: "warning" | "critical"; staleAfterMs?: number; transient?: boolean };
export type Check = Sample & { status: Status; failures: number; successes: number; observedAt: string; lastPassedAt: string | null; failedAt?: string | null; mutedUntil: string | null; enabled: boolean };
export type IncidentEvent = { at: string; type: string; detail: string; by?: string };
/** `manual`: created by an operator; it stays open until an operator resolves it. `resolvedBy` names who closed it ("check" when the check recovered). */
export type Incident = { id: string; checkId: string; name: string; app: string; severity: "warning" | "critical"; status: "open" | "acknowledged" | "resolved"; openedAt: string; updatedAt: string; resolvedAt: string | null; detail: string; source?: "auto" | "manual"; resolvedBy?: string; events: IncidentEvent[] };
/** Non-passing observations of one scan: from just after the previous scan to this one. */
export type ScanRecord = { at: string; previousAt: string | null; checks: { id: string; name: string; app: string; kind: string; status: string; verdict: string; code: string; at: string }[] };
/**
 * Measured host resources of one scan: CPU busy share over the interval between two samples (absent
 * until a second sample exists), load averages, memory and the data disk. Bytes and percentages, UTC
 * sample time. `source` says whether the number came from /proc or the OS estimate.
 */
export type HostResources = {
  sampledAt: string;
  /** Span of the two CPU samples the percentage covers. */
  cpu?: { percent: number; cores: number; intervalMs: number; source: "proc" | "os" };
  load?: { one: number; five: number; fifteen: number };
  memory?: { usedBytes: number; totalBytes: number; availableBytes: number; percent: number; source: "proc" | "os" };
  disk?: { usedBytes: number; totalBytes: number; percent: number; path: string };
};
export type Snapshot = { version: 1; machine: string; generatedAt: string; lastScanAt: string | null; staleAfterMs: number; checks: Check[]; incidents: Incident[]; history: { at: string; passing: number; failing: number; unknown: number; transient?: number }[]; inspections?: Inspection[]; resources?: HostResources };
/** `url`: where the snapshot is read; the peer's diagnosis evidence sits next to it. */
export type PeerView = { name: string; url?: string; status: "healthy" | "unknown"; error?: string; snapshot: Snapshot | null; receivedAt: string | null };
/** Operator policy for one local task: success due within `deadlineMinutes` of its start; `errorThreshold` overrides the global one. */
export type TaskPolicy = { deadlineMinutes?: number; errorThreshold?: number };
export type Settings = { notifications: boolean; scanMinutes: number; failAfter: number; recoverAfter: number; taskErrorThreshold: number; diskPercent: number; memoryPercent: number; cpuPercent: number };
export const DEFAULT_SETTINGS: Settings = { notifications: false, scanMinutes: 5, failAfter: 3, recoverAfter: 2, taskErrorThreshold: 3, diskPercent: 90, memoryPercent: 95, cpuPercent: 90 };
/** A check an app declares in space.yaml (`checks:`), as Space's GET /api/checks lists it. */
export type DeclaredCheck = { id: string; app: string; appTitle: string; name: string; title?: string; description?: string; url: string; done: Assertion[]; when?: Assertion[]; due?: string; timezone?: string; i18n?: Record<string, { appTitle?: string; title?: string; description?: string }> };
/** Inspection (点检) state: today's work is done, not due yet, late, not expected today, or unreadable. Never a fault. */
export type InspectionState = "done" | "pending" | "late" | "off" | "unknown";
export type Inspection = Omit<DeclaredCheck, "url" | "done" | "when"> & { state: InspectionState; detail: string; observedAt: string; doneAt: string | null; latencyMs?: number };
/** One AI diagnosis run (一键排查): the evidence it was given, what it checked and the agent's report. */
export type ReportStatus = "running" | "done" | "failed";
/** `ok`: no fault found; `issues`: faults found; `incomplete`: the evidence was not enough to say. */
export type ReportVerdict = "ok" | "issues" | "incomplete";
/** One evidence source: read in full, read in part, not read (with why), or failed. */
export type Coverage = { name: string; status: "done" | "partial" | "skipped" | "failed"; detail: string; machine?: string };
/** `machine` ran it; `machines` were diagnosed (absent on reports from before peers were covered: the machine itself). */
export type Report = { id: string; machine: string; machines?: string[]; status: ReportStatus; lang: "en" | "zh"; startedAt: string; finishedAt: string | null; by?: string; targets: string[]; coverage: Coverage[]; verdict?: ReportVerdict; summary?: string; body?: string; error?: string; call?: { id?: number; model?: string; runtime?: string; durationMs?: number } };
/** A report in a list: everything but the body. */
export type ReportItem = Omit<Report, "body">;
