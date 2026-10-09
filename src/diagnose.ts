import type { Engine } from "./engine.ts";
import { readJson } from "./probes.ts";
import type { Check, Coverage, Report, ReportVerdict } from "./types.ts";

/**
 * One-click diagnosis (一键排查). Space Ops gathers the evidence it can read on this machine, bounded,
 * and an agent on the space's model service turns it into a report. The model may run on another host
 * (a runtime over ssh), so it gets the evidence in the prompt instead of a shell: what it says rests on
 * what was collected, and every source that was not read is listed as such. Nothing is repaired.
 */

const APP_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NOT_APPS = new Set(["host", "peers", "space", "custom"]);
const PROBLEM = new Set(["failing", "recovering", "transient", "unknown"]);
const clip = (s: unknown, n: number) => { const t = String(s ?? "").trim(); return t.length > n ? `${t.slice(0, n)}…[truncated]` : t; };
const iso = (ms: unknown) => typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : typeof ms === "string" ? ms : "—";

export type Evidence = { text: string; coverage: Coverage[]; targets: string[] };
export type DiagnoseOptions = { logsCommand?: string; logLines?: number; maxLogApps?: number; modelTimeoutMs?: number; run?: (cmd: string, timeoutMs: number) => Promise<{ code: number; out: string }> };

/** Read every source once; a source that fails is recorded, never silently left out. */
export async function collectEvidence(engine: Engine, opts: DiagnoseOptions = {}, now = Date.now()): Promise<Evidence> {
  const { api, machine } = engine.config, fetcher = engine.fetcher;
  const coverage: Coverage[] = [], parts: string[] = [];
  const snap = engine.snapshot(), checks = snap.checks;
  const problems = checks.filter(c => PROBLEM.has(c.status) && c.code !== "task_running");
  const fresh = !!snap.lastScanAt && now - Date.parse(snap.lastScanAt) < snap.staleAfterMs;
  const count = (st: string) => checks.filter(c => c.status === st).length;

  parts.push(`## Collector\nMachine: ${machine}\nNow: ${new Date(now).toISOString()}\nLast scan: ${snap.lastScanAt ?? "never"} (${fresh ? "fresh" : "STALE or missing: observations below may be outdated"})\nChecks: ${checks.length} total, ${count("healthy")} healthy, ${count("failing")} failing, ${count("recovering")} recovering, ${count("transient")} one-off, ${count("unknown")} unknown, ${count("paused")} paused\nRecent scans (failing/one-off/unknown per scan): ${snap.history.slice(-12).map(h => `${h.failing}/${h.transient ?? 0}/${h.unknown}`).join(" ") || "none"}`);
  coverage.push({ name: "Health checks", status: fresh ? "done" : "partial", detail: fresh ? `${checks.length} checks from the latest scan` : "The latest scan is missing or expired" });

  const row = (c: Check) => `- [${c.status}] ${c.name} (id ${c.id}, app ${c.app}, kind ${c.kind}) code=${c.code}${c.value !== undefined ? ` value=${c.value}` : ""}${c.threshold !== undefined ? ` threshold=${c.threshold}` : ""} failures=${c.failures} observed=${c.observedAt}${c.failedAt ? ` failingSince=${c.failedAt}` : ""}${c.lastPassedAt ? ` lastPass=${c.lastPassedAt}` : " lastPass=never"}\n  ${clip(c.detail, 400)}`;
  parts.push(`## Checks not healthy (${problems.length})\n${problems.slice(0, 60).map(row).join("\n") || "None."}${problems.length > 60 ? `\n…and ${problems.length - 60} more` : ""}`);
  const paused = checks.filter(c => c.status === "paused");
  if (paused.length) parts.push(`## Paused checks (not observed)\n${paused.slice(0, 20).map(c => `- ${c.name} (${c.app})`).join("\n")}`);

  const open = snap.incidents.filter(i => i.status !== "resolved"), recent = snap.incidents.filter(i => i.status === "resolved" && i.resolvedAt && now - Date.parse(i.resolvedAt) < 86_400_000);
  parts.push(`## Open incidents (${open.length})\n${open.slice(0, 30).map(i => `- [${i.status}, ${i.severity}${i.source === "manual" ? ", opened by an operator" : ""}] ${i.name} (app ${i.app}, check ${i.checkId}) since ${i.openedAt}\n  ${clip(i.detail, 400)}\n${i.events.slice(-4).map(e => `  · ${e.at} ${e.type}: ${clip(e.detail, 300)}`).join("\n")}`).join("\n") || "None."}\n\n## Incidents resolved in the last 24 hours (${recent.length})\n${recent.slice(0, 15).map(i => `- ${i.name} (app ${i.app}) ${i.openedAt} → ${i.resolvedAt} by ${i.resolvedBy ?? "?"}`).join("\n") || "None."}`);
  coverage.push({ name: "Incidents", status: "done", detail: `${open.length} open, ${recent.length} resolved in 24 hours` });

  // Failed task runs: the error text the scheduler kept for each task that is not healthy.
  const tasks = problems.filter(c => c.kind === "task").slice(0, 8);
  if (tasks.length) {
    let read = 0; const out: string[] = [];
    for (const c of tasks) {
      try {
        const r = await readJson(`${api}/api/tasks/${encodeURIComponent(c.id.slice(5))}/runs?limit=5`, 8000, fetcher);
        const runs = Array.isArray(r.runs) ? r.runs as { status?: string; startedAt?: number; endedAt?: number; error?: string; output?: string }[] : [];
        out.push(`### ${c.name}\n${runs.map(x => `- ${x.status} started=${iso(x.startedAt)} ended=${iso(x.endedAt)}${x.error ? `\n  error: ${clip(x.error, 800)}` : ""}${x.status !== "ok" && x.output ? `\n  output: ${clip(x.output, 400)}` : ""}`).join("\n") || "No runs recorded."}`); read++;
      } catch (e) { out.push(`### ${c.name}\nRun history unavailable (${clip(e instanceof Error ? e.message : e, 120)})`); }
    }
    parts.push(`## Recent runs of tasks that are not healthy\n${out.join("\n")}`);
    coverage.push({ name: "Failed task runs", status: read === tasks.length ? "done" : read ? "partial" : "failed", detail: `Run history of ${read} of ${tasks.length} tasks` });
  } else coverage.push({ name: "Failed task runs", status: "done", detail: "No task is failing; nothing to read" });

  // Model calls that failed in the last day: an app whose AI step breaks often runs "fine" otherwise.
  try {
    const r = await readJson(`${api}/api/model/calls?limit=200`, 8000, fetcher);
    const calls = (Array.isArray(r.calls) ? r.calls : []) as { app?: string; tag?: string; model?: string; status?: string; error?: string; startedAt?: string }[];
    const failed = calls.filter(c => c.status === "error" && c.startedAt && now - Date.parse(c.startedAt) < 86_400_000);
    const groups = new Map<string, { n: number; last: string; error: string }>();
    for (const c of failed) { const k = `${c.app}/${c.tag} (${c.model})`, g = groups.get(k); if (g) g.n++; else groups.set(k, { n: 1, last: c.startedAt!, error: clip(c.error, 300) }); }
    parts.push(`## Failed model calls in the last 24 hours (${failed.length} of the latest ${calls.length} calls)\n${[...groups].map(([k, g]) => `- ${k}: ${g.n} failed, latest ${g.last}: ${g.error}`).join("\n") || "None."}`);
    coverage.push({ name: "Model call errors", status: "done", detail: `${calls.length} recent calls read, ${failed.length} failed in 24 hours` });
  } catch (e) { coverage.push({ name: "Model call errors", status: "failed", detail: `Space model ledger unavailable (${clip(e instanceof Error ? e.message : e, 120)})` }); }

  // Service logs of the apps with problems, through the operator's command template.
  const apps = [...new Set([...problems.map(c => c.app), ...open.map(i => i.app)])].filter(a => APP_RE.test(a) && !NOT_APPS.has(a));
  if (!apps.length) coverage.push({ name: "Service logs", status: "done", detail: "No application has a problem; no log to read" });
  else if (!opts.logsCommand) coverage.push({ name: "Service logs", status: "skipped", detail: `Not read for ${apps.join(", ")}: OPS_LOGS_COMMAND is not configured on this machine` });
  else {
    const run = opts.run ?? shell, lines = opts.logLines ?? 60, pick = apps.slice(0, opts.maxLogApps ?? 6), out: string[] = []; let read = 0;
    for (const app of pick) {
      try {
        const r = await run(opts.logsCommand.replaceAll("{app}", app).replaceAll("{lines}", String(lines)), 10_000);
        if (r.code !== 0 && !r.out.trim()) throw new Error(`exit ${r.code}`);
        out.push(`### ${app}\n\`\`\`\n${r.out.trim().split("\n").slice(-lines).map(l => clip(l, 400)).join("\n").slice(-8000) || "(empty)"}\n\`\`\``); read++;
      } catch (e) { out.push(`### ${app}\nLog unavailable (${clip(e instanceof Error ? e.message : e, 120)})`); }
    }
    parts.push(`## Service logs (last ${lines} lines each)\n${out.join("\n")}`);
    coverage.push({ name: "Service logs", status: read === apps.length ? "done" : read ? "partial" : "failed", detail: `Logs of ${read} of ${apps.length} applications${apps.length > pick.length ? ` (first ${pick.length} only)` : ""}` });
  }

  const peers = engine.peers(now);
  parts.push(`## Peer collectors (${peers.length})\n${peers.map(p => `- ${p.name}: ${p.status}${p.error ? ` (${p.error})` : ""}; open incidents there: ${(p.snapshot?.incidents ?? []).filter(i => i.status !== "resolved").map(i => i.name).join(", ") || "none"}`).join("\n") || "None configured."}\nPeers are other machines; their details are diagnosed on those machines.`);
  coverage.push({ name: "Peer collectors", status: "done", detail: `${peers.length} peers, status only` });

  return { text: parts.join("\n\n"), coverage, targets: [machine, ...apps] };
}

export const SYSTEM = `You are the operations diagnosis agent of one ai-space machine. ai-space runs apps as services, runs their scheduled tasks and model calls, and Space Ops checks them. You receive the evidence Space Ops collected on that machine. You cannot run commands or read anything else, and you must not invent facts beyond the evidence.

Write a fault diagnosis report:
- First line exactly: VERDICT: ok | issues | incomplete  (ok = no current fault; issues = at least one fault; incomplete = the evidence is not enough to tell)
- Second line exactly: SUMMARY: one sentence, at most 80 characters
- Then a Markdown report with these sections:
  ## 结论 / Conclusion — the overall state in two or three sentences.
  ## 检查范围 / Scope — what the evidence covered and how fresh it is.
  ## 发现的问题 / Findings — one ### subsection per problem, most severe first, each with: severity (critical / warning / minor), symptom, evidence (quote ids, codes, timestamps, log lines), likely cause (say "likely" or "unconfirmed" when it is a hypothesis), recommended action. Group checks that share one cause. When nothing is wrong, say so explicitly.
  ## 未完成的检查 / Not checked — every source that was skipped, failed or partial, and what it would take to check it.
- One-off errors (status transient) are single failures below the incident threshold; mention them, but do not call them faults unless the evidence shows a pattern.
- Unknown is not healthy: say what is missing.
- Recommend actions only; do not claim anything was repaired. Keep commands generic and mark them as suggestions.
Write the report in the language the request names.`;

export function parseAnswer(text: string): { verdict: ReportVerdict; summary: string; body: string } {
  const lines = text.replace(/^```\w*\n|```\s*$/g, "").trim().split("\n");
  let verdict: ReportVerdict = "incomplete", summary = "", i = 0;
  for (; i < Math.min(lines.length, 6); i++) {
    const v = lines[i]!.match(/^\**VERDICT\**\s*[:：]\s*\**\s*(ok|issues|incomplete)/i), s = lines[i]!.match(/^\**SUMMARY\**\s*[:：]\s*(.+)$/i);
    if (v) verdict = v[1]!.toLowerCase() as ReportVerdict; else if (s) summary = s[1]!.replace(/\*+$/, "").trim(); else if (lines[i]!.trim()) break;
  }
  const body = lines.slice(i).join("\n").trim() || text.trim();
  return { verdict, summary: clip(summary || body.split("\n").find(l => l.trim() && !l.startsWith("#"))?.replace(/^[-*>\s]+/, "") || "", 160), body };
}

/** Runs one diagnosis at a time; the run outlives the request that started it. */
export class Diagnosis {
  private current: Promise<void> | null = null;
  constructor(private engine: Engine, private opts: DiagnoseOptions = {}) {}
  ready() { return !!this.engine.config.appToken; }
  /** Starts a run, or answers the one already running. */
  start(lang: "en" | "zh", by?: string, now = Date.now()): { report: Report; started: boolean } {
    const running = this.engine.store.runningReport();
    if (running) return { report: running, started: false };
    if (!this.ready()) throw new Error("Space model credentials are unavailable");
    const report: Report = { id: crypto.randomUUID(), machine: this.engine.config.machine, status: "running", lang, startedAt: new Date(now).toISOString(), finishedAt: null, ...(by ? { by } : {}), targets: [this.engine.config.machine], coverage: [] };
    this.engine.store.putReport(report);
    this.current = this.run(report).finally(() => { this.current = null; });
    return { report, started: true };
  }
  /** For tests and shutdown: the run in flight. */
  settled() { return this.current ?? Promise.resolve(); }
  private async run(report: Report) {
    const store = this.engine.store, { api, appToken } = this.engine.config;
    const finish = (patch: Partial<Report>) => store.putReport({ ...report, ...patch, finishedAt: new Date().toISOString() });
    try {
      const evidence = await collectEvidence(this.engine, this.opts);
      Object.assign(report, { coverage: evidence.coverage, targets: evidence.targets }); store.putReport(report);
      const timeoutMs = this.opts.modelTimeoutMs ?? 900_000;
      const prompt = `Language of the report: ${report.lang === "zh" ? "Simplified Chinese (简体中文)" : "English"}.\nDiagnose the faults of machine "${report.machine}" from this evidence.\n\n# Evidence\n\n${evidence.text}`;
      // No model is named: space.yaml declares the tag's tier and the panel may override it.
      const response = await this.engine.fetcher(`${api}/api/model/run`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${appToken}` }, body: JSON.stringify({ prompt, system: SYSTEM, tag: "diagnose", timeoutMs }), signal: AbortSignal.timeout(timeoutMs + 60_000), timeout: false } as RequestInit);
      const d = await response.json().catch(() => ({})) as { ok?: boolean; text?: string; error?: string; call?: { id?: number; model?: string; runtime?: string; backend?: string; durationMs?: number } };
      const call = d.call ? { id: d.call.id, model: d.call.model, runtime: d.call.runtime ?? d.call.backend, durationMs: d.call.durationMs } : undefined;
      if (!response.ok || !d.ok || !d.text?.trim()) return finish({ status: "failed", error: clip(d.error ?? `Model service answered HTTP ${response.status}`, 1000), ...(call ? { call } : {}) });
      finish({ status: "done", ...parseAnswer(d.text), ...(call ? { call } : {}) });
    } catch (e) {
      finish({ status: "failed", error: e instanceof Error && e.name === "TimeoutError" ? "The diagnosis timed out" : clip(e instanceof Error ? e.message : "Diagnosis failed", 1000) });
    }
  }
}

async function shell(cmd: string, timeoutMs: number) {
  const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: (out || err).slice(-200_000) };
}
