import { freemem, totalmem, loadavg, cpus } from "node:os";
import { statfs, readFile } from "node:fs/promises";
import { assertionsResult, field, validInstant, ruleActive, pendingDeadline } from "./rules.ts";
import type { Rule, Sample, Settings, Check, HostResources, TaskPolicy } from "./types.ts";

/**
 * Adds the app's SPACE_APP_TOKEN to requests for Space's own API, and only to those: a Space that
 * signs its owner in itself (SPACE_AUTH=builtin) refuses an app's reads without it, and an app's
 * declared check URL on another port must never see the token.
 */
export function withSpaceToken(fetcher: typeof fetch, api: string, token?: string): typeof fetch {
  if (!token) return fetcher;
  const base = api.replace(/\/+$/, "") + "/";
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(base)) return fetcher(input, init);
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    return fetcher(input, { ...init, headers });
  }) as typeof fetch;
}
export async function readJson(url: string, timeoutMs = 8000, fetcher: typeof fetch = fetch): Promise<any> {
  const r = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!r.ok) { await r.body?.cancel(); throw new Error(`HTTP ${r.status}`); }
  const text = await limitedText(r);
  return JSON.parse(text);
}
export async function limitedText(response: Response, limit = 2_000_000): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error("Response exceeds 2 MB limit"); chunks.push(value); } }
  finally { await reader.cancel().catch(()=>{}); }
  return Buffer.concat(chunks).toString("utf8");
}
export async function httpProbe(rule: Rule, fetcher: typeof fetch = fetch, now = Date.now()): Promise<Sample> {
  const base: Sample = { id: rule.id, name: rule.name, app: rule.app, kind: "http", verdict: "unknown", code: "unknown", detail: "", coverage: rule.assertions.length ? "assertion" : "availability", failAfter: rule.failAfter, recoverAfter: rule.recoverAfter, severity: rule.severity, staleAfterMs: rule.intervalMs * 3 + rule.timeoutMs };
  if (!ruleActive(rule, now)) return { ...base, code: "rule_offday", detail: `No check scheduled today (${rule.timezone})` };
  const pending = pendingDeadline(rule.assertions, now, rule.timezone);
  if (pending) return { ...base, code: "rule_before_deadline", detail: `Waiting until ${pending} today (${rule.timezone})` };
  const started = performance.now();
  try {
    const response = await fetcher(rule.url, { signal: AbortSignal.timeout(rule.timeoutMs), redirect: "error", headers: { accept: "application/json" } });
    if (response.status !== rule.expectedStatus) { await response.body?.cancel(); return { ...base, verdict: "fail", code: "http_status", detail: `HTTP ${response.status}; expected ${rule.expectedStatus}`, value: response.status, threshold: rule.expectedStatus, latencyMs: Math.round(performance.now()-started) }; }
    if (!rule.assertions.length) { await response.body?.cancel(); return { ...base, verdict: "pass", code: "http_ok", detail: `HTTP ${response.status}`, latencyMs: Math.round(performance.now()-started) }; }
    let data: unknown;
    try { data = JSON.parse(await limitedText(response)); } catch { return { ...base, verdict: "unknown", code: "invalid_json", detail: "Response is not valid bounded JSON" }; }
    let evidenceAt: string | undefined;
    if (rule.evidenceTimestampPath) {
      const value = field(data, rule.evidenceTimestampPath);
      if (!validInstant(value) || Date.parse(value) > now + 60_000) return { ...base, verdict: "unknown", code: "invalid_recovery_timestamp", detail: "Result timestamp is absent, invalid or in the future" };
      evidenceAt = new Date(value).toISOString();
    }
    return { ...base, evidenceAt, ...assertionsResult(data, rule.assertions, now, rule.timezone, rule.weekdays), latencyMs: Math.round(performance.now()-started) };
  } catch (e) { return { ...base, verdict: "fail", code: "http_unreachable", detail: e instanceof Error && e.name === "TimeoutError" ? "Probe exceeded its timeout" : "Connection failed, redirected, or timed out", latencyMs: Math.round(performance.now()-started) }; }
}
export type Task = { id: string; app: string; name: string; enabled: boolean; orphaned: boolean; timeoutMs: number; state: { runningAt?: string; nextRunAt?: string; lastRunAt?: string; lastDurationMs?: number; lastStatus?: string; consecutiveErrors?: number; pending?: { dueAt: string; deadlineAt?: string } } };
export function taskSample(t: Task, settings: Settings, now = Date.now(), policy: TaskPolicy = {}): Sample {
  const s = t.state, errorThreshold = policy.errorThreshold ?? settings.taskErrorThreshold, deadlineMs = (policy.deadlineMinutes ?? 0) * 60_000;
  const base: Sample = { id: `task:${t.id}`, name: `${t.app} / ${t.name}`, app: t.app, kind: "task", verdict: "pass", code: "task_ok", detail: "Execution status only; business output is not verified", coverage: "execution", evidenceAt: s.lastRunAt };
  // A late completion must also postdate the failed attempt's end, not only its start.
  if (["error", "skipped"].includes(s.lastStatus ?? "") && validInstant(s.lastRunAt) && Number.isFinite(s.lastDurationMs) && s.lastDurationMs! >= 0) base.evidenceAt = new Date(Date.parse(s.lastRunAt) + s.lastDurationMs!).toISOString();
  if (!t.enabled || t.orphaned) return { ...base, verdict: "unknown", code: "task_disabled", detail: "Task is disabled or no longer declared" };
  // An operator deadline is a fact about this run, not a flaky probe: it opens on the first observation.
  if (s.runningAt && deadlineMs && now - Date.parse(s.runningAt) > deadlineMs) return { ...base, verdict: "fail", failAfter: 1, code: "task_deadline", detail: `Not successful within ${policy.deadlineMinutes} minutes of its start`, value: now-Date.parse(s.runningAt), threshold: deadlineMs, evidenceAt: s.runningAt };
  if (s.runningAt && now - Date.parse(s.runningAt) > t.timeoutMs + 60_000) return { ...base, verdict: "fail", code: "task_stalled", detail: "Running beyond the configured timeout and 60s grace", value: now-Date.parse(s.runningAt), threshold: t.timeoutMs + 60_000 };
  if (s.runningAt) return { ...base, verdict: "unknown", code: "task_running", detail: "Task is running within its deadline" };
  if (s.nextRunAt && now - Date.parse(s.nextRunAt) > 180_000) return { ...base, verdict: "fail", code: "task_overdue", detail: "Scheduled execution is overdue by more than 3 minutes", evidenceAt: s.nextRunAt };
  if (s.pending?.dueAt && now - Date.parse(s.pending.dueAt) > 180_000) return { ...base, verdict: "fail", code: "event_overdue", detail: "Pending event execution is overdue by more than 3 minutes", evidenceAt: s.pending.dueAt };
  // Below the threshold the failure is a one-off error: not healthy, not an incident, cleared by the next good run.
  if (s.lastStatus === "error") { const n = s.consecutiveErrors ?? 1; return n >= errorThreshold ? { ...base, verdict: "fail", ...(policy.errorThreshold ? { failAfter: 1 } : {}), code: "task_errors", detail: `${n} consecutive failed execution${n === 1 ? "" : "s"}; latest failure may predate a repair`, value: n, threshold: errorThreshold } : { ...base, verdict: "unknown", transient: true, code: "task_errors", detail: `${n} failed execution${n === 1 ? "" : "s"}, below the threshold of ${errorThreshold}; cleared by the next successful run`, value: n, threshold: errorThreshold }; }
  if (s.lastStatus === "skipped" && policy.errorThreshold === 1) return { ...base, verdict: "fail", failAfter: 1, code: "task_skipped", detail: "Latest execution was skipped" };
  if (s.lastStatus === "skipped") return { ...base, verdict: "unknown", transient: true, code: "task_skipped", detail: "Latest execution was skipped; cleared by the next completed run" };
  if (!s.lastRunAt) return { ...base, verdict: "unknown", code: "task_never_run", detail: "No completed execution has been observed" };
  return base;
}
// A no-op run ("inputs unchanged") is normal for a polling task; skips count only once nothing has succeeded for a day.
export type TaskRun = { status: string; startedAt?: number; endedAt?: number; error?: string; output?: string };
// A skip answering a `reason` and no error is planned (market closed, holiday): not a failure, not a missed run.
export function declaredNoop(r: TaskRun): string | undefined {
  if (r.status !== "skipped" || r.error) return undefined;
  try { const v = JSON.parse(r.output ?? ""); return typeof v?.reason === "string" && v.reason ? v.reason : undefined; } catch { return undefined; }
}
export function repeatedSkip(runs: TaskRun[], now = Date.now()): boolean {
  if (runs.length < 3 || !runs.slice(0, 3).every(r => r.status === "skipped" && !declaredNoop(r))) return false;
  const ok = runs.find(r => r.status === "ok"), at = ok?.endedAt ?? ok?.startedAt;
  return !Number.isFinite(at) || now - at! > 86_400_000;
}
/** Aggregate CPU time: idle (idle + iowait) and total jiffies, with the sample instant. */
export type CpuTicks = { idle: number; total: number; at: number };
/** The `cpu` line of /proc/stat: user nice system idle iowait irq softirq steal [guest guest_nice]. */
export function parseProcStat(text: string, at = Date.now()): CpuTicks | null {
  const m = text.match(/^cpu\s+(.+)$/m); if (!m) return null;
  const n = m[1]!.trim().split(/\s+/).map(Number);
  if (n.length < 4 || n.some(x => !Number.isFinite(x) || x < 0)) return null;
  // Guest time is already counted in user/nice; sum the first eight fields only.
  const total = n.slice(0, 8).reduce((a, b) => a + b, 0), idle = n[3]! + (n[4] ?? 0);
  return total > 0 ? { idle, total, at } : null;
}
/** The same shape from the OS module, for platforms without /proc. */
export function osCpuTicks(at = Date.now()): CpuTicks {
  let idle = 0, total = 0;
  for (const c of cpus()) { idle += c.times.idle; total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq; }
  return { idle, total, at };
}
/** Busy share between two samples, one decimal; null when nothing elapsed or the counters went backwards. */
export function cpuPercent(prev: CpuTicks, next: CpuTicks): number | null {
  const total = next.total - prev.total, idle = next.idle - prev.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return Math.round((1 - idle / total) * 1000) / 10;
}
/** /proc/loadavg: three averages, then running/total tasks and the last pid. */
export function parseLoadavg(text: string): { one: number; five: number; fifteen: number } | null {
  const n = text.trim().split(/\s+/, 3).map(Number);
  return n.length === 3 && n.every(Number.isFinite) ? { one: n[0]!, five: n[1]!, fifteen: n[2]! } : null;
}
/** /proc/meminfo: total and available (what can be used without swapping, so caches do not count as used). */
export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } | null {
  const kb = (key: string) => { const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m")); return m ? Number(m[1]) * 1024 : undefined; };
  const totalBytes = kb("MemTotal"), availableBytes = kb("MemAvailable");
  return totalBytes && availableBytes !== undefined && availableBytes <= totalBytes ? { totalBytes, availableBytes } : null;
}
export async function readCpuTicks(now = Date.now()): Promise<{ ticks: CpuTicks; source: "proc" | "os" }> {
  if (process.platform === "linux") { try { const t = parseProcStat(await readFile("/proc/stat", "utf8"), now); if (t) return { ticks: t, source: "proc" }; } catch { /* Fall back to the OS counters. */ } }
  return { ticks: osCpuTicks(now), source: "os" };
}
/**
 * Measure this machine: CPU against `prev` (the previous scan's ticks; with none and `settleMs` > 0 a
 * second sample is taken after that delay, otherwise CPU stays absent), load, memory and the data disk.
 */
export async function readHostResources(dir: string, prev: CpuTicks | null, settleMs = 0, now = Date.now()): Promise<{ resources: HostResources; ticks: CpuTicks }> {
  let { ticks, source } = await readCpuTicks(now);
  if (!prev && settleMs > 0) { prev = ticks; await Bun.sleep(settleMs); ({ ticks, source } = await readCpuTicks(Date.now())); }
  const resources: HostResources = { sampledAt: new Date(ticks.at).toISOString() };
  const percent = prev ? cpuPercent(prev, ticks) : null;
  if (percent !== null) resources.cpu = { percent, cores: cpus().length || 1, intervalMs: ticks.at - prev!.at, source };
  let load = { one: loadavg()[0]!, five: loadavg()[1]!, fifteen: loadavg()[2]! };
  let memory: { totalBytes: number; availableBytes: number; source: "proc" | "os" } = { totalBytes: totalmem(), availableBytes: freemem(), source: "os" };
  if (process.platform === "linux") {
    try { const l = parseLoadavg(await readFile("/proc/loadavg", "utf8")); if (l) load = l; } catch { /* Keep the OS load average. */ }
    try { const m = parseMeminfo(await readFile("/proc/meminfo", "utf8")); if (m) memory = { ...m, source: "proc" }; } catch { /* Fall back to the OS free-memory estimate. */ }
  }
  resources.load = { one: round2(load.one), five: round2(load.five), fifteen: round2(load.fifteen) };
  if (memory.totalBytes > 0) resources.memory = { ...memory, usedBytes: memory.totalBytes - memory.availableBytes, percent: Math.round((1 - memory.availableBytes / memory.totalBytes) * 1000) / 10 };
  try { const fs = await statfs(dir); if (fs.blocks > 0) resources.disk = { usedBytes: (fs.blocks - fs.bavail) * fs.bsize, totalBytes: fs.blocks * fs.bsize, percent: Math.round((1 - fs.bavail / fs.blocks) * 1000) / 10, path: dir }; }
  catch { /* No disk entry: the check below reports it unknown. */ }
  return { resources, ticks };
}
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Host checks from one measurement. A number that could not be measured is unknown, never passing. */
export function hostSamples(r: HostResources, settings: Settings): Sample[] {
  const base = { app: "host", kind: "host", coverage: "host" as const };
  const out: Sample[] = [];
  if (r.cpu) out.push({ ...base, id: "host:cpu", name: "CPU usage", verdict: r.cpu.percent >= settings.cpuPercent ? "fail" : "pass", code: "host_cpu", detail: `Busy share of all CPUs over the last ${Math.max(1, Math.round(r.cpu.intervalMs / 1000))} s${r.cpu.source === "os" ? "; OS counters" : ""}`, value: r.cpu.percent, threshold: settings.cpuPercent });
  else out.push({ ...base, id: "host:cpu", name: "CPU usage", verdict: "unknown", code: "host_cpu_unknown", detail: "CPU usage needs two samples; awaiting the next scan", threshold: settings.cpuPercent });
  if (r.memory) out.push({ ...base, id: "host:memory", name: "Memory pressure", verdict: r.memory.percent >= settings.memoryPercent ? "fail" : "pass", code: "host_memory", detail: r.memory.source === "proc" ? "Used memory excluding reclaimable memory (MemAvailable)" : "OS free-memory estimate; pressure is advisory", value: r.memory.percent, threshold: settings.memoryPercent });
  else out.push({ ...base, id: "host:memory", name: "Memory pressure", verdict: "unknown", code: "host_memory_unknown", detail: "Memory metrics unavailable", threshold: settings.memoryPercent });
  const cores = r.cpu?.cores ?? cpus().length ?? 1;
  if (r.load) out.push({ ...base, id: "host:load", name: "System load", verdict: r.load.one > cores * 2 ? "fail" : "pass", code: "host_load", detail: "One-minute load average relative to CPU count", value: r.load.one, threshold: cores * 2 });
  if (r.disk) out.push({ ...base, id: "host:disk", name: "Data disk capacity", verdict: r.disk.percent >= settings.diskPercent ? "fail" : "pass", code: "host_disk", detail: "Filesystem capacity at the app data directory", value: r.disk.percent, threshold: settings.diskPercent });
  else out.push({ ...base, id: "host:disk", name: "Data disk capacity", verdict: "unknown", code: "host_disk_unknown", detail: "Filesystem metrics unavailable" });
  return out;
}

/** Only explicitly mapped, fresh success evidence may supersede a historical execution failure. */
export function withRecoveryEvidence(sample: Sample, rules: Rule[], checks: Check[], now = Date.now()): Sample {
  if (!["task_errors", "task_skipped", "task_repeated_skip"].includes(sample.code) || !validInstant(sample.evidenceAt)) return sample;
  for (const rule of rules) {
    if (!rule.enabled || `task:${rule.recoveryTaskId}` !== sample.id) continue;
    const check = checks.find(c => c.id === rule.id);
    if (!check || !check.enabled || check.status !== "healthy" || check.verdict !== "pass" || !validInstant(check.evidenceAt)) continue;
    if (now - Date.parse(check.observedAt) > (check.staleAfterMs ?? 180_000) || Date.parse(check.evidenceAt) > now + 60_000 || Date.parse(check.evidenceAt) <= Date.parse(sample.evidenceAt)) continue;
    return { ...sample, verdict: "pass", transient: undefined, code: "task_recovered_evidence", value: undefined, threshold: undefined, coverage: "assertion", evidenceAt: check.evidenceAt, detail: `Recovered: ${rule.name}; completion ${check.evidenceAt} is newer than failed execution ${sample.evidenceAt}` };
  }
  return sample;
}
