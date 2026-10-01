import { freemem, totalmem, loadavg, cpus } from "node:os";
import { statfs, readFile } from "node:fs/promises";
import { assertionsResult, field, validInstant } from "./rules.ts";
import type { Rule, Sample, Settings, Check } from "./types.ts";

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
      if (!validInstant(value) || Date.parse(value) > now + 60_000) return { ...base, verdict: "unknown", code: "invalid_recovery_timestamp", detail: "Recovery completion timestamp is absent, invalid or in the future" };
      evidenceAt = new Date(value).toISOString();
    }
    return { ...base, evidenceAt, ...assertionsResult(data, rule.assertions, now), latencyMs: Math.round(performance.now()-started) };
  } catch (e) { return { ...base, verdict: "fail", code: "http_unreachable", detail: e instanceof Error && e.name === "TimeoutError" ? "Probe exceeded its timeout" : "Connection failed, redirected, or timed out", latencyMs: Math.round(performance.now()-started) }; }
}
export type Task = { id: string; app: string; name: string; enabled: boolean; orphaned: boolean; timeoutMs: number; state: { runningAt?: string; nextRunAt?: string; lastRunAt?: string; lastStatus?: string; consecutiveErrors?: number; pending?: { dueAt: string; deadlineAt?: string } } };
export function taskSample(t: Task, settings: Settings, now = Date.now()): Sample {
  const s = t.state;
  const base: Sample = { id: `task:${t.id}`, name: `${t.app} / ${t.name}`, app: t.app, kind: "task", verdict: "pass", code: "task_ok", detail: "Execution status only; business output is not verified", coverage: "execution", evidenceAt: s.lastRunAt };
  if (!t.enabled || t.orphaned) return { ...base, verdict: "unknown", code: "task_disabled", detail: "Task is disabled or no longer declared" };
  if (s.runningAt && now - Date.parse(s.runningAt) > t.timeoutMs + 60_000) return { ...base, verdict: "fail", code: "task_stalled", detail: "Running beyond the configured timeout and 60s grace", value: now-Date.parse(s.runningAt), threshold: t.timeoutMs + 60_000 };
  if (s.runningAt) return { ...base, verdict: "unknown", code: "task_running", detail: "Task is running within its deadline" };
  if (s.nextRunAt && now - Date.parse(s.nextRunAt) > 180_000) return { ...base, verdict: "fail", code: "task_overdue", detail: "Scheduled execution is overdue by more than 3 minutes", evidenceAt: s.nextRunAt };
  if (s.pending?.dueAt && now - Date.parse(s.pending.dueAt) > 180_000) return { ...base, verdict: "fail", code: "event_overdue", detail: "Pending event execution is overdue by more than 3 minutes", evidenceAt: s.pending.dueAt };
  if (s.lastStatus === "error") return { ...base, verdict: (s.consecutiveErrors ?? 1) >= settings.taskErrorThreshold ? "fail" : "unknown", code: "task_errors", detail: `${s.consecutiveErrors ?? 1} failed executions; latest failure may predate a repair`, value: s.consecutiveErrors ?? 1, threshold: settings.taskErrorThreshold };
  if (s.lastStatus === "skipped") return { ...base, verdict: "unknown", code: "task_skipped", detail: "Latest execution was skipped; completion is not established" };
  if (!s.lastRunAt) return { ...base, verdict: "unknown", code: "task_never_run", detail: "No completed execution has been observed" };
  return base;
}
export async function hostSamples(dir: string, settings: Settings): Promise<Sample[]> {
  let available=freemem();
  if (process.platform === "linux") {
    try { const info=await readFile("/proc/meminfo","utf8");const match=info.match(/^MemAvailable:\s+(\d+) kB$/m);if(match)available=Number(match[1])*1024; } catch { /* Fall back to the OS free-memory estimate. */ }
  }
  const memory = Math.round((1-available/totalmem())*1000)/10;
  const base = { app: "host", kind: "host", coverage: "host" as const };
  const out: Sample[] = [{ ...base, id: "host:memory", name: "Memory pressure", verdict: memory >= settings.memoryPercent ? "fail" : "pass", code: "host_memory", detail: process.platform === "linux" ? "Used memory excluding reclaimable memory (MemAvailable)" : "OS free-memory estimate; pressure is advisory", value: memory, threshold: settings.memoryPercent }, { ...base, id: "host:load", name: "System load", verdict: loadavg()[0]! > cpus().length * 2 ? "fail" : "pass", code: "host_load", detail: "One-minute load average relative to CPU count", value: Math.round(loadavg()[0]!*100)/100, threshold: cpus().length * 2 }];
  try { const fs = await statfs(dir); const used = Math.round((1-fs.bavail/fs.blocks)*1000)/10; out.push({ ...base, id: "host:disk", name: "Data disk capacity", verdict: used >= settings.diskPercent ? "fail" : "pass", code: "host_disk", detail: "Filesystem capacity at the app data directory", value: used, threshold: settings.diskPercent }); }
  catch { out.push({ ...base, id: "host:disk", name: "Data disk capacity", verdict: "unknown", code: "host_disk_unknown", detail: "Filesystem metrics unavailable" }); }
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
    return { ...sample, verdict: "pass", code: "task_recovered_evidence", coverage: "assertion", evidenceAt: check.evidenceAt, detail: `Recovered: ${rule.name}; completion ${check.evidenceAt} is newer than failed execution ${sample.evidenceAt}` };
  }
  return sample;
}
